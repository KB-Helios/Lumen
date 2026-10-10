use super::*;
use std::{io::Write, sync::mpsc, time::Instant};
use tokio_util::sync::CancellationToken;

static FIXTURE_LOCK: Mutex<()> = Mutex::new(());

pub(super) struct Fixture {
    pub arguments: Vec<String>,
    pub server_arguments: Vec<String>,
    pub address: SocketAddr,
}

/// Creates an isolated supervisor whose version probe invokes this test binary in the given mode.
fn fixture(mode: &str) -> (LocalRuntimeSupervisor, PathBuf) {
    let marker = format!("lumen-answer-probe-{mode}-{}", uuid::Uuid::new_v4());
    let directory = env::temp_dir().join(&marker);
    fs::create_dir(&directory).unwrap();
    let binary = env::current_exe().unwrap();
    let address = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    (
        LocalRuntimeSupervisor {
            provisioning_root: None,
            system_cli: Some(binary.clone()),
            system_server: Some(binary),
            flm: None,
            mistral_rs: None,
            process: Mutex::new(None),
            answer_startup: tokio::sync::Mutex::new(()),
            answer_fixture: Some(Fixture {
                arguments: vec![
                    "--exact".into(),
                    "gateway::local_runtime::answer_preparation_tests::probe_child".into(),
                    "--ignored".into(),
                    "--nocapture".into(),
                    "--test-threads=1".into(),
                    "--skip".into(),
                    marker,
                ],
                server_arguments: vec![],
                address,
            }),
        },
        directory,
    )
}

/// Builds an exact ignored-test invocation with a unique marker passed through libtest arguments.
fn child_arguments(name: &str, marker: String) -> Vec<String> {
    vec![
        "--exact".into(),
        format!("gateway::local_runtime::answer_preparation_tests::{name}"),
        "--ignored".into(),
        "--nocapture".into(),
        "--test-threads=1".into(),
        "--skip".into(),
        marker,
    ]
}

/// Creates separate version-probe and server markers for local startup ownership tests.
fn readiness_fixture() -> (LocalRuntimeSupervisor, PathBuf, PathBuf) {
    let (mut supervisor, probe_directory) = fixture("ready");
    let marker = format!("lumen-answer-server-{}", uuid::Uuid::new_v4());
    let server_directory = env::temp_dir().join(&marker);
    fs::create_dir(&server_directory).unwrap();
    supervisor.answer_fixture.as_mut().unwrap().server_arguments =
        child_arguments("server_child", marker);
    (supervisor, probe_directory, server_directory)
}

/// Registers the configured server fixture as an already-owned process and returns its PID.
fn adopt_existing(supervisor: &LocalRuntimeSupervisor) -> u32 {
    adopt_process(
        supervisor,
        &supervisor.answer_fixture.as_ref().unwrap().server_arguments,
    )
}

/// Spawns and registers a fixture child, containing it in a kill-on-close job on Windows.
fn adopt_process(supervisor: &LocalRuntimeSupervisor, arguments: &[String]) -> u32 {
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let child = command.spawn().unwrap();
    let pid = child.id();
    #[cfg(windows)]
    let job = super::super::supervisor::assign_kill_on_close_job(&child).unwrap();
    *supervisor.process.lock().unwrap() = Some(RuntimeProcess {
        child,
        #[cfg(windows)]
        job: job.0 as isize,
    });
    pid
}

/// Polls the child marker asynchronously until it contains a PID or the deadline expires.
async fn acknowledged_pid(directory: &Path, deadline: tokio::time::Instant) -> u32 {
    loop {
        if let Ok(pid) = fs::read_to_string(directory.join("pid"))
            && let Ok(pid) = pid.parse()
        {
            return pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "child did not acknowledge startup"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

/// Waits up to five seconds for a fixture child to publish its PID.
fn wait_for_pid(directory: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(pid) = fs::read_to_string(directory.join("pid"))
            && let Ok(pid) = pid.parse()
        {
            return pid;
        }
        assert!(
            Instant::now() < deadline,
            "owned child never acknowledged its PID"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Publishes the current PID by rename so cancellation cannot expose a partial marker.
fn acknowledge_pid(directory: &Path) {
    // Deadline termination must not expose a partially written PID acknowledgement.
    let pending = directory.join("pid.pending");
    fs::write(&pending, std::process::id().to_string()).unwrap();
    fs::rename(pending, directory.join("pid")).unwrap();
}

#[cfg(windows)]
/// Checks whether a Windows process handle remains unsignalled without waiting for exit.
fn is_alive(pid: u32) -> bool {
    use windows::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            WaitForSingleObject,
        },
    };
    unsafe {
        let Ok(handle) = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        ) else {
            return false;
        };
        let active = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        let _ = CloseHandle(handle);
        active
    }
}

#[test]
/// Cancels after the probe acknowledges startup and checks prompt return and Windows process exit.
fn cancellation_kills_and_reaps_an_acknowledged_owned_version_probe() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, directory) = fixture("hung");
    let cancellation = CancellationToken::new();
    let token = cancellation.clone();
    let marker = directory.clone();
    let (timing_tx, timing_rx) = mpsc::channel();
    let canceller = std::thread::spawn(move || {
        let pid = wait_for_pid(&marker);
        let instant = Instant::now();
        token.cancel();
        timing_tx.send((pid, instant)).unwrap();
    });
    let result = tauri::async_runtime::block_on(supervisor.prepare_answer(
        &cancellation,
        tokio::time::Instant::now() + Duration::from_secs(5),
    ));
    let finished = Instant::now();
    canceller.join().unwrap();
    let (pid, cancelled) = timing_rx.recv().unwrap();
    let elapsed = finished.duration_since(cancelled);
    println!("owned local version probe cancellation: {elapsed:?}");
    let _ = fs::remove_dir_all(directory);
    assert!(
        elapsed < Duration::from_millis(250),
        "version probe cancellation took {elapsed:?}"
    );
    assert_eq!(result, Err("cancelled"));
    #[cfg(windows)]
    assert!(
        !is_alive(pid),
        "owned version probe remained alive after cancellation"
    );
}

#[test]
/// Checks cancellation precedence and timeout admission without creating a child PID marker.
fn already_cancelled_and_expired_preparation_do_not_spawn_a_probe() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, directory) = fixture("hung");
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    assert_eq!(
        tauri::async_runtime::block_on(supervisor.prepare_answer(
            &cancellation,
            tokio::time::Instant::now() - Duration::from_secs(1)
        )),
        Err("cancelled")
    );
    assert_eq!(
        tauri::async_runtime::block_on(supervisor.prepare_answer(
            &CancellationToken::new(),
            tokio::time::Instant::now() - Duration::from_secs(1)
        )),
        Err("request_timeout")
    );
    assert!(!directory.join("pid").exists());
    let _ = fs::remove_dir_all(directory);
}

#[test]
/// Expires preparation during the version probe and checks that no acknowledged Windows child survives.
fn version_deadline_kills_the_owned_probe() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, directory) = fixture("hung");
    let result = tauri::async_runtime::block_on(supervisor.prepare_answer(
        &CancellationToken::new(),
        tokio::time::Instant::now() + Duration::from_millis(500),
    ));
    assert_eq!(result, Err("request_timeout"));
    if let Ok(pid) = fs::read_to_string(directory.join("pid")) {
        #[cfg(windows)]
        assert!(!is_alive(pid.parse().unwrap()));
    }
    let _ = fs::remove_dir_all(directory);
}

#[test]
/// Overflows probe stderr and checks safe failure plus termination of the owned Windows child.
fn oversized_version_output_is_bounded_and_kills_the_probe() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, directory) = fixture("overflow");
    let result = tauri::async_runtime::block_on(supervisor.prepare_answer(
        &CancellationToken::new(),
        tokio::time::Instant::now() + Duration::from_secs(5),
    ));
    assert_eq!(result, Err("local_runtime_unavailable"));
    let pid = wait_for_pid(&directory);
    #[cfg(windows)]
    assert!(!is_alive(pid));
    let _ = fs::remove_dir_all(directory);
}

#[test]
/// Provides a listening port with a wrong version to ensure TCP readiness cannot bypass version admission.
fn external_listening_runtime_still_requires_the_pinned_version() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, directory) = fixture("invalid");
    let listener =
        std::net::TcpListener::bind(supervisor.answer_fixture.as_ref().unwrap().address).unwrap();
    let result = tauri::async_runtime::block_on(supervisor.prepare_answer(
        &CancellationToken::new(),
        tokio::time::Instant::now() + Duration::from_secs(5),
    ));
    assert_eq!(result, Err("local_runtime_unavailable"));
    assert!(supervisor.process.lock().unwrap().is_none());
    drop(listener);
    let _ = fs::remove_dir_all(directory);
}

#[test]
/// Cancels after server startup and checks prompt cleanup without adopting the interrupted child.
fn cancellation_during_readiness_kills_only_the_newly_owned_server() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, probe_directory, server_directory) = readiness_fixture();
    let cancellation = CancellationToken::new();
    let token = cancellation.clone();
    let marker = server_directory.clone();
    let canceller = std::thread::spawn(move || {
        let pid = wait_for_pid(&marker);
        let instant = Instant::now();
        token.cancel();
        (pid, instant)
    });
    let result = tauri::async_runtime::block_on(supervisor.prepare_answer(
        &cancellation,
        tokio::time::Instant::now() + Duration::from_secs(5),
    ));
    let finished = Instant::now();
    let (pid, cancelled) = canceller.join().unwrap();
    println!(
        "owned local runtime readiness cancellation: {:?}",
        finished.duration_since(cancelled)
    );
    assert_eq!(result, Err("cancelled"));
    assert!(finished.duration_since(cancelled) < Duration::from_millis(250));
    #[cfg(windows)]
    assert!(
        !is_alive(pid),
        "owned runtime survived readiness cancellation"
    );
    assert!(supervisor.process.lock().unwrap().is_none());
    let _ = fs::remove_dir_all(probe_directory);
    let _ = fs::remove_dir_all(server_directory);
}

#[test]
/// Checks that a live registered process with a ready port is reused without a version subprocess.
fn healthy_cached_owned_runtime_is_retained_without_another_probe() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, probe_directory, server_directory) = readiness_fixture();
    let pid = adopt_existing(&supervisor);
    wait_for_pid(&server_directory);
    let listener =
        std::net::TcpListener::bind(supervisor.answer_fixture.as_ref().unwrap().address).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(supervisor.prepare_answer(
            &CancellationToken::new(),
            tokio::time::Instant::now() + Duration::from_secs(5)
        )),
        Ok(())
    );
    assert!(!probe_directory.join("pid").exists());
    assert_eq!(
        supervisor
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .child
            .id(),
        pid
    );
    #[cfg(windows)]
    assert!(is_alive(pid));
    drop(listener);
    drop(supervisor);
    let _ = fs::remove_dir_all(probe_directory);
    let _ = fs::remove_dir_all(server_directory);
}

#[test]
/// Checks that readiness transfers ownership to the supervisor and teardown reaps it on Windows.
fn successful_preparation_adopts_the_verified_ready_owned_runtime() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (mut supervisor, probe_directory, server_directory) = readiness_fixture();
    let fixture = supervisor.answer_fixture.as_mut().unwrap();
    fixture.server_arguments.extend([
        "--skip".into(),
        format!("lumen-answer-listen-{}", fixture.address.port()),
    ]);
    assert_eq!(
        tauri::async_runtime::block_on(supervisor.prepare_answer(
            &CancellationToken::new(),
            tokio::time::Instant::now() + Duration::from_secs(5)
        )),
        Ok(())
    );
    let pid = wait_for_pid(&server_directory);
    assert_eq!(
        supervisor
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .child
            .id(),
        pid
    );
    #[cfg(windows)]
    assert!(is_alive(pid));
    drop(supervisor);
    #[cfg(windows)]
    assert!(!is_alive(pid));
    let _ = fs::remove_dir_all(probe_directory);
    let _ = fs::remove_dir_all(server_directory);
}

#[test]
/// Drops the preparation future after child acknowledgement and checks it leaves no registered server.
fn dropping_preparation_reaps_the_owned_readiness_process() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, probe_directory, server_directory) = readiness_fixture();
    tauri::async_runtime::block_on(async {
        let cancellation = CancellationToken::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let prepare = supervisor.prepare_answer(&cancellation, deadline);
        tokio::pin!(prepare);
        tokio::select! {
            result = &mut prepare => panic!("readiness process returned unexpectedly: {result:?}"),
            _ = async {
                while !server_directory.join("pid").exists() {
                    assert!(tokio::time::Instant::now() < deadline, "owned server never started");
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            } => {},
        }
    });
    let pid = wait_for_pid(&server_directory);
    #[cfg(windows)]
    assert!(!is_alive(pid));
    assert!(supervisor.process.lock().unwrap().is_none());
    let _ = fs::remove_dir_all(probe_directory);
    let _ = fs::remove_dir_all(server_directory);
}

#[test]
/// Cancels preparation around an existing child and checks that its registration survives.
fn cancellation_while_waiting_for_an_existing_process_preserves_its_pid() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, probe_directory, server_directory) = readiness_fixture();
    let pid = adopt_existing(&supervisor);
    wait_for_pid(&server_directory);
    let cancellation = CancellationToken::new();
    let token = cancellation.clone();
    let marker = probe_directory.clone();
    let canceller = std::thread::spawn(move || {
        wait_for_pid(&marker);
        token.cancel();
    });
    assert_eq!(
        tauri::async_runtime::block_on(supervisor.prepare_answer(
            &cancellation,
            tokio::time::Instant::now() + Duration::from_secs(5)
        )),
        Err("cancelled")
    );
    canceller.join().unwrap();
    assert_eq!(
        supervisor
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .child
            .id(),
        pid
    );
    #[cfg(windows)]
    assert!(
        is_alive(pid),
        "a cancelled answer killed a preexisting runtime"
    );
    drop(supervisor);
    let _ = fs::remove_dir_all(probe_directory);
    let _ = fs::remove_dir_all(server_directory);
}

#[test]
/// Cancels a serialized waiter and checks that it cannot spawn a competing version probe.
fn a_cancelled_waiter_does_not_start_a_second_probe() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, directory) = fixture("hung");
    let first = CancellationToken::new();
    let second = CancellationToken::new();
    let token = second.clone();
    let marker = directory.clone();
    let canceller = std::thread::spawn(move || {
        let pid = wait_for_pid(&marker);
        token.cancel();
        pid
    });
    let (first_result, second_result) = tauri::async_runtime::block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        tokio::join!(supervisor.prepare_answer(&first, deadline), async {
            let result = supervisor.prepare_answer(&second, deadline).await;
            first.cancel();
            result
        })
    });
    assert_eq!(first_result, Err("cancelled"));
    assert_eq!(second_result, Err("cancelled"));
    let pid = canceller.join().unwrap();
    assert_eq!(wait_for_pid(&directory), pid);
    #[cfg(windows)]
    assert!(!is_alive(pid));
    let _ = fs::remove_dir_all(directory);
}

#[test]
/// Registers a competing child before readiness and requires failure while preserving that registration.
fn preparation_does_not_report_success_when_only_its_redundant_child_is_ready() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (mut supervisor, probe_directory, server_directory) = readiness_fixture();
    let fixture = supervisor.answer_fixture.as_mut().unwrap();
    fixture.server_arguments.extend([
        "--skip".into(),
        format!("lumen-answer-listen-{}", fixture.address.port()),
        "--skip".into(),
        "lumen-answer-server-wait-for-release".into(),
    ]);
    let marker = format!("lumen-answer-server-{}", uuid::Uuid::new_v4());
    let management_directory = env::temp_dir().join(&marker);
    fs::create_dir(&management_directory).unwrap();
    let arguments = child_arguments("server_child", marker);
    let (result, (redundant, management)) = tauri::async_runtime::block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let cancellation = CancellationToken::new();
        tokio::join!(supervisor.prepare_answer(&cancellation, deadline), async {
            let redundant = acknowledged_pid(&server_directory, deadline).await;
            let management = adopt_process(&supervisor, &arguments);
            assert_eq!(
                acknowledged_pid(&management_directory, deadline).await,
                management
            );
            fs::write(server_directory.join("release"), b"ready").unwrap();
            (redundant, management)
        })
    });
    assert_eq!(
        result,
        Err("local_runtime_unavailable"),
        "TCP readiness cannot establish ownership of an unexpected registered child"
    );
    assert_eq!(
        supervisor
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .child
            .id(),
        management
    );
    #[cfg(windows)]
    {
        assert!(!is_alive(redundant));
        assert!(is_alive(management));
    }
    drop(supervisor);
    let _ = fs::remove_dir_all(probe_directory);
    let _ = fs::remove_dir_all(server_directory);
    let _ = fs::remove_dir_all(management_directory);
}

#[test]
/// Checks that cold-cloud Stop fails during startup and succeeds on retry after adoption.
fn cloud_stop_cannot_acknowledge_an_unadopted_answer_startup() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (mut supervisor, probe_directory, server_directory) = readiness_fixture();
    let fixture = supervisor.answer_fixture.as_mut().unwrap();
    fixture.server_arguments.extend([
        "--skip".into(),
        format!("lumen-answer-listen-{}", fixture.address.port()),
        "--skip".into(),
        "lumen-answer-server-wait-for-release".into(),
    ]);
    let (preparation, (stop, pid)) = tauri::async_runtime::block_on(async {
        let cancellation = CancellationToken::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        tokio::join!(supervisor.prepare_answer(&cancellation, deadline), async {
            let pid = acknowledged_pid(&server_directory, deadline).await;
            let stop = supervisor.apply_mode("cloud", false);
            fs::write(server_directory.join("release"), b"ready").unwrap();
            (stop, pid)
        })
    });
    assert_eq!(preparation, Ok(()));
    assert!(
        stop.is_err_and(|message| message.contains("already preparing")),
        "cloud stop must not acknowledge success while an answer can still adopt its owned child"
    );
    assert_eq!(
        supervisor
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .child
            .id(),
        pid
    );
    #[cfg(windows)]
    assert!(is_alive(pid));
    // Retry once startup admission is free retains the existing cold-cloud semantics.
    assert_eq!(supervisor.apply_mode("cloud", false), Ok(()));
    assert!(supervisor.process.lock().unwrap().is_none());
    #[cfg(windows)]
    assert!(
        !is_alive(pid),
        "acknowledged cloud stop must reap the registered runtime"
    );
    drop(supervisor);
    let _ = fs::remove_dir_all(probe_directory);
    let _ = fs::remove_dir_all(server_directory);
}

#[test]
/// Checks that management startup respects the answer preparation lock before probing or spawning.
fn management_start_cannot_replace_a_runtime_during_answer_preparation() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, directory) = fixture("hung");
    let cancellation = CancellationToken::new();
    let (preparation, (management, probe)) = tauri::async_runtime::block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        tokio::join!(supervisor.prepare_answer(&cancellation, deadline), async {
            let probe = acknowledged_pid(&directory, deadline).await;
            let management = supervisor.start();
            cancellation.cancel();
            (management, probe)
        })
    });
    assert_eq!(preparation, Err("cancelled"));
    assert!(
        management.unwrap_err().contains("already preparing"),
        "management must respect the shared startup admission before probing or registering a competing child"
    );
    assert!(supervisor.process.lock().unwrap().is_none());
    #[cfg(windows)]
    assert!(!is_alive(probe));
    let _ = fs::remove_dir_all(directory);
}

#[test]
/// Kills the registered child while version admission is paused and checks replacement within the request.
fn preparation_restarts_a_process_that_exits_during_version_admission() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (mut supervisor, probe_directory, server_directory) = readiness_fixture();
    let original = adopt_existing(&supervisor);
    wait_for_pid(&server_directory);
    let fixture = supervisor.answer_fixture.as_mut().unwrap();
    fixture
        .arguments
        .extend(["--skip".into(), "lumen-answer-wait-for-release".into()]);
    fixture.server_arguments.extend([
        "--skip".into(),
        format!("lumen-answer-listen-{}", fixture.address.port()),
    ]);
    let result = tauri::async_runtime::block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let cancellation = CancellationToken::new();
        let (result, ()) =
            tokio::join!(supervisor.prepare_answer(&cancellation, deadline), async {
                acknowledged_pid(&probe_directory, deadline).await;
                let mut process = supervisor.process.lock().unwrap();
                let child = &mut process.as_mut().unwrap().child;
                child.kill().unwrap();
                child.wait().unwrap();
                fs::remove_file(server_directory.join("pid")).unwrap();
                fs::write(probe_directory.join("release"), b"ready").unwrap();
            });
        result
    });
    assert_eq!(
        result,
        Ok(()),
        "the exited process must be replaced within this request"
    );
    let replacement = supervisor
        .process
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .child
        .id();
    assert_ne!(replacement, original);
    assert_eq!(wait_for_pid(&server_directory), replacement);
    #[cfg(windows)]
    {
        assert!(!is_alive(original));
        assert!(is_alive(replacement));
    }
    drop(supervisor);
    let _ = fs::remove_dir_all(probe_directory);
    let _ = fs::remove_dir_all(server_directory);
}

#[test]
/// Makes a competing registration ready and checks that failure reaps only the preparation-owned child.
fn preparation_rejects_an_unexpected_ready_management_registration_without_reaping_it() {
    let _serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (supervisor, probe_directory, server_directory) = readiness_fixture();
    let marker = format!("lumen-answer-server-{}", uuid::Uuid::new_v4());
    let management_directory = env::temp_dir().join(&marker);
    fs::create_dir(&management_directory).unwrap();
    let mut arguments = child_arguments("server_child", marker);
    arguments.extend([
        "--skip".into(),
        format!(
            "lumen-answer-listen-{}",
            supervisor.answer_fixture.as_ref().unwrap().address.port()
        ),
    ]);
    let (result, (redundant, management)) = tauri::async_runtime::block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let cancellation = CancellationToken::new();
        tokio::join!(supervisor.prepare_answer(&cancellation, deadline), async {
            let redundant = acknowledged_pid(&server_directory, deadline).await;
            let management = adopt_process(&supervisor, &arguments);
            assert_eq!(
                acknowledged_pid(&management_directory, deadline).await,
                management
            );
            (redundant, management)
        })
    });
    assert_eq!(
        result,
        Err("local_runtime_unavailable"),
        "unexpected registration must fail closed even when the port is ready"
    );
    assert_eq!(
        supervisor
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .child
            .id(),
        management
    );
    #[cfg(windows)]
    {
        assert!(
            !is_alive(redundant),
            "redundant owned startup must be reaped"
        );
        assert!(is_alive(management));
    }
    drop(supervisor);
    let _ = fs::remove_dir_all(probe_directory);
    let _ = fs::remove_dir_all(server_directory);
    let _ = fs::remove_dir_all(management_directory);
}

#[test]
#[ignore = "owned subprocess fixture, invoked only by answer preparation tests"]
/// Implements the opt-in version subprocess modes, publishing its PID before delay or output.
fn probe_child() {
    let marker = env::args()
        .find(|argument| argument.starts_with("lumen-answer-probe-"))
        .unwrap();
    let directory = env::temp_dir().join(&marker);
    acknowledge_pid(&directory);
    if env::args().any(|argument| argument == "lumen-answer-wait-for-release") {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !directory.join("release").exists() {
            assert!(
                Instant::now() < deadline,
                "version admission was not released"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    if marker.starts_with("lumen-answer-probe-overflow-") {
        std::io::stderr().write_all(&vec![b'x'; 65_536]).unwrap();
        std::io::stderr().flush().unwrap();
    }
    if marker.starts_with("lumen-answer-probe-invalid-") {
        println!("Lemonade 0.0.1");
        return;
    }
    if marker.starts_with("lumen-answer-probe-ready-") {
        println!("Lemonade {REQUIRED_LEMONADE}");
        return;
    }
    std::thread::sleep(Duration::from_millis(1500));
    println!("Lemonade {REQUIRED_LEMONADE}");
}

#[test]
#[ignore = "owned subprocess fixture, invoked only by answer preparation tests"]
/// Implements an opt-in server subprocess with PID acknowledgement and optional gated TCP listening.
fn server_child() {
    let marker = env::args()
        .find(|argument| argument.starts_with("lumen-answer-server-"))
        .unwrap();
    let directory = env::temp_dir().join(marker);
    acknowledge_pid(&directory);
    if env::args().any(|argument| argument == "lumen-answer-server-wait-for-release") {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !directory.join("release").exists() {
            assert!(
                Instant::now() < deadline,
                "server readiness was not released"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    let _listener = env::args()
        .find_map(|argument| {
            argument
                .strip_prefix("lumen-answer-listen-")
                .map(str::to_owned)
        })
        .map(|port| std::net::TcpListener::bind(format!("127.0.0.1:{port}")).unwrap());
    std::thread::sleep(Duration::from_secs(5));
}
