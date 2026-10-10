use super::*;
use std::{io::Write, sync::mpsc, time::Instant};
use tokio_util::sync::CancellationToken;

static FIXTURE_LOCK: Mutex<()> = Mutex::new(());

pub(super) struct Fixture {
    pub arguments: Vec<String>,
    pub server_arguments: Vec<String>,
    pub address: SocketAddr,
}

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

fn readiness_fixture() -> (LocalRuntimeSupervisor, PathBuf, PathBuf) {
    let (mut supervisor, probe_directory) = fixture("ready");
    let marker = format!("lumen-answer-server-{}", uuid::Uuid::new_v4());
    let server_directory = env::temp_dir().join(&marker);
    fs::create_dir(&server_directory).unwrap();
    supervisor.answer_fixture.as_mut().unwrap().server_arguments =
        child_arguments("server_child", marker);
    (supervisor, probe_directory, server_directory)
}

fn adopt_existing(supervisor: &LocalRuntimeSupervisor) -> u32 {
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args(&supervisor.answer_fixture.as_ref().unwrap().server_arguments)
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

#[cfg(windows)]
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
#[ignore = "owned subprocess fixture, invoked only by answer preparation tests"]
fn probe_child() {
    let marker = env::args()
        .find(|argument| argument.starts_with("lumen-answer-probe-"))
        .unwrap();
    let directory = env::temp_dir().join(&marker);
    fs::write(directory.join("pid"), std::process::id().to_string()).unwrap();
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
fn server_child() {
    let marker = env::args()
        .find(|argument| argument.starts_with("lumen-answer-server-"))
        .unwrap();
    fs::write(
        env::temp_dir().join(marker).join("pid"),
        std::process::id().to_string(),
    )
    .unwrap();
    let _listener = env::args()
        .find_map(|argument| {
            argument
                .strip_prefix("lumen-answer-listen-")
                .map(str::to_owned)
        })
        .map(|port| std::net::TcpListener::bind(format!("127.0.0.1:{port}")).unwrap());
    std::thread::sleep(Duration::from_secs(5));
}
