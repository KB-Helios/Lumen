use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::ipc::InvokeResponseBody;

struct Provider {
    supervisor: GatewaySupervisor,
    directory: std::path::PathBuf,
    thread: Option<std::thread::JoinHandle<()>>,
    stopped: CancellationToken,
    accepted: Arc<AtomicBool>,
}

impl Provider {
    fn serve(handler: impl FnOnce(std::net::TcpStream) + Send + 'static) -> Self {
        let directory = std::env::temp_dir().join(format!("lumen-answer-{}", uuid::Uuid::new_v4()));
        let supervisor = GatewaySupervisor::new("unused".into(), &directory, &[]).unwrap();
        let (base, bearer) = supervisor.endpoint(false);
        let listener = TcpListener::bind(base.strip_prefix("http://").unwrap()).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stopped = CancellationToken::new();
        let worker_stop = stopped.clone();
        let accepted = Arc::new(AtomicBool::new(false));
        let worker_accepted = accepted.clone();
        let thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let (mut socket, _) = loop {
                if worker_stop.is_cancelled() {
                    return;
                }
                match listener.accept() {
                    Ok(socket) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "provider fixture received no request"
                        );
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) => panic!("provider fixture accept failed: {error}"),
                }
            };
            // Windows shutdown does not reliably interrupt an already-blocked read.
            // Poll only request admission; handlers retain ordinary blocking I/O.
            socket.set_nonblocking(true).unwrap();
            worker_accepted.store(true, Ordering::Release);
            let request_deadline = Instant::now() + Duration::from_secs(3);
            let mut request = Vec::new();
            let mut buf = [0; 4096];
            loop {
                if worker_stop.is_cancelled() {
                    return;
                }
                assert!(
                    Instant::now() < request_deadline,
                    "provider fixture request timed out"
                );
                let n = match socket.read(&mut buf) {
                    Ok(0) => return, // A cancelled client can abandon its unfinished request.
                    Ok(n) => n,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => panic!("provider fixture request read failed: {error}"),
                };
                request.extend_from_slice(&buf[..n]);
                if let Some(offset) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = std::str::from_utf8(&request[..offset]).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    if request.len() < offset + 4 + length {
                        continue;
                    }
                    assert!(headers.starts_with("POST /v1/responses HTTP/1.1"));
                    assert!(headers.contains(&format!("Bearer {bearer}")));
                    let body: serde_json::Value =
                        serde_json::from_slice(&request[offset + 4..]).unwrap();
                    assert_eq!(body["stream"], true);
                    assert_eq!(body["input"], "fixture prompt");
                    break;
                }
            }
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            handler(socket);
        });
        Self {
            supervisor,
            directory,
            thread: Some(thread),
            stopped,
            accepted,
        }
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.stopped.cancel();
        let joined = self.thread.take().map(|thread| thread.join());
        let _ = std::fs::remove_dir_all(&self.directory);
        if let Some(joined) = joined {
            joined.unwrap();
        }
    }
}

fn channel() -> (Channel<AnswerEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let output = Arc::clone(&events);
    let channel = Channel::new(move |body| {
        let InvokeResponseBody::Json(body) = body else {
            panic!("expected JSON channel");
        };
        output
            .lock()
            .unwrap()
            .push(serde_json::from_str(&body).unwrap());
        Ok(())
    });
    (channel, events)
}

fn local_route() -> RouteAttempt {
    RouteAttempt {
        alias: "lumen.answer.local".into(),
        provider: "local-fixture".into(),
        model: "fixture-model".into(),
        applied: None,
    }
}

fn stream(body: &'static str) -> (Result<Option<Usage>, RouteFailure>, Vec<serde_json::Value>) {
    let provider = Provider::serve(move |mut socket| {
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    });
    let (channel, events) = channel();
    let result = tauri::async_runtime::block_on(stream_attempt(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &CancellationToken::new(),
    ));
    (result, events.lock().unwrap().clone())
}

#[test]
fn accepts_crlf_multiline_data_and_optional_field_space() {
    let (result, events) = stream(
        "data:{\"type\":\"response.output_text.delta\",\r\ndata: \"delta\":\"Hello 🌍\"}\r\n\r\ndata:{\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\r\n\r\n",
    );
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(
        events
            .iter()
            .filter_map(|e| e["text"].as_str())
            .collect::<String>(),
        "Hello 🌍"
    );
    assert_eq!(
        events.iter().filter(|e| e["type"] == "completed").count(),
        1
    );
}

#[test]
fn cancellation_before_headers_drops_the_owned_request_promptly() {
    let (arrived_tx, arrived_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let provider = Provider::serve(move |_socket| {
        arrived_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    });
    let cancellation = CancellationToken::new();
    let signal = cancellation.clone();
    let (channel, _) = channel();
    let canceller = std::thread::spawn(move || {
        arrived_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let began = Instant::now();
        signal.cancel();
        // The server remains open long enough to distinguish cancellation from EOF.
        std::thread::sleep(Duration::from_millis(600));
        release_tx.send(()).unwrap();
        began
    });
    let result = tauri::async_runtime::block_on(stream_attempt(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &cancellation,
    ));
    let finished = Instant::now();
    let cancelled = canceller.join().unwrap();
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert!(
        finished.duration_since(cancelled) < Duration::from_millis(250),
        "cancellation waited for the server"
    );
}

#[test]
fn valid_completion_does_not_wait_for_the_provider_to_close() {
    let provider = Provider::serve(move |mut socket| {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        let body =
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n";
        write!(socket, "{:x}\r\n{body}\r\n", body.len()).unwrap();
        socket.flush().unwrap();
        std::thread::sleep(Duration::from_millis(600));
        let _ = socket.write_all(b"0\r\n\r\n");
    });
    let (channel, _) = channel();
    let began = Instant::now();
    let result = tauri::async_runtime::block_on(stream_attempt(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &CancellationToken::new(),
    ));
    assert!(result.is_ok());
    assert!(
        began.elapsed() < Duration::from_millis(250),
        "completion waited for EOF"
    );
}

#[test]
fn malformed_json_cannot_be_hidden_by_a_later_completion() {
    let (result, _) = stream("data: {not-json}\n\ndata: {\"type\":\"response.completed\"}\n\n");
    assert!(
        result.is_err(),
        "malformed provider events must fail the attempt"
    );
}

#[test]
fn malformed_type_cannot_be_reinterpreted_as_a_valid_named_completion() {
    let (result, events) = stream(
        "event: response.completed\ndata: {\"type\":17,\"response\":{\"status\":\"completed\"}}\n\n",
    );
    assert!(
        result.is_err(),
        "a present malformed type is not an omitted type"
    );
    assert!(!events.iter().any(|event| event["type"] == "completed"));
}

#[test]
fn incomplete_provider_status_is_not_success() {
    let (result, events) = stream(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"incomplete\"}}\n\n",
    );
    assert!(result.is_err());
    assert!(!events.iter().any(|e| e["type"] == "completed"));
}

#[test]
fn provider_error_details_never_escape_the_native_boundary() {
    let (result, _) = stream(
        "data: {\"type\":\"error\",\"error\":{\"message\":\"credential sk-fixture-secret; private source text\"}}\n\n",
    );
    let error = result.unwrap_err();
    assert!(
        !error.message.contains("sk-fixture-secret"),
        "upstream credentials escaped"
    );
    assert!(!error.message.contains("private source text"));
}

#[test]
fn utf8_codepoint_fragmented_across_http_chunks_is_preserved() {
    let provider = Provider::serve(move |mut socket| {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        let prefix = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello ";
        write!(socket, "{:x}\r\n{prefix}\r\n", prefix.len()).unwrap();
        for byte in "🌍".as_bytes() {
            write!(socket, "1\r\n").unwrap();
            socket.write_all(&[*byte]).unwrap();
            socket.write_all(b"\r\n").unwrap();
            socket.flush().unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        let suffix = "\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n";
        write!(socket, "{:x}\r\n{suffix}\r\n0\r\n\r\n", suffix.len()).unwrap();
    });
    let (channel, events) = channel();
    let result = tauri::async_runtime::block_on(stream_attempt(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &CancellationToken::new(),
    ));
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| e["text"].as_str())
            .collect::<String>(),
        "Hello 🌍"
    );
}

#[test]
fn rate_limit_headers_do_not_require_reading_a_stalled_error_body() {
    let provider = Provider::serve(move |mut socket| {
        socket
            .write_all(b"HTTP/1.1 429 Too Many Requests\r\nTransfer-Encoding: chunked\r\n\r\n")
            .unwrap();
        socket.flush().unwrap();
        std::thread::sleep(Duration::from_millis(600));
        let _ = socket.write_all(b"0\r\n\r\n");
    });
    let (channel, _) = channel();
    let began = Instant::now();
    let result = tauri::async_runtime::block_on(stream_attempt(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &CancellationToken::new(),
    ));
    assert_eq!(result.unwrap_err().code, "rate_limited");
    assert!(
        began.elapsed() < Duration::from_millis(250),
        "read a stalled error body"
    );
}

#[test]
fn rejects_a_stream_that_ends_without_a_completion() {
    let (result, events) =
        stream("data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n");
    assert!(result.is_err());
    assert!(!events.iter().any(|e| e["type"] == "completed"));
}

#[test]
fn accepts_bom_comments_cr_lines_and_empty_optional_space() {
    let (result, events) = stream(
        "\u{feff}: keepalive\rdata:{\"type\":\"response.output_text.delta\",\"delta\":\"Hello 🌍\"}\r\rdata:{\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\r\r",
    );
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(
        events
            .iter()
            .filter_map(|e| e["text"].as_str())
            .collect::<String>(),
        "Hello 🌍"
    );
}

#[test]
fn unbounded_event_data_is_rejected_before_completion() {
    let body = format!(
        "data: {{\"type\":\"response.output_text.delta\",\"delta\":\"{}\"}}\n\ndata: {{\"type\":\"response.completed\",\"response\":{{\"status\":\"completed\"}}}}\n\n",
        "x".repeat(70_000)
    );
    let provider = Provider::serve(move |mut socket| {
        let _ = write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
    });
    let (channel, events) = channel();
    let result = tauri::async_runtime::block_on(stream_attempt(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &CancellationToken::new(),
    ));
    assert!(result.is_err(), "oversized provider frames must fail");
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "completed")
    );
}

#[test]
fn invalid_utf8_is_rejected_instead_of_replacing_provider_content() {
    let provider = Provider::serve(move |mut socket| {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        let mut body = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"".to_vec();
        body.push(0xff);
        body.extend_from_slice(b"\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n");
        write!(socket, "{:x}\r\n", body.len()).unwrap();
        socket.write_all(&body).unwrap();
        socket.write_all(b"\r\n0\r\n\r\n").unwrap();
    });
    let (channel, _) = channel();
    let result = tauri::async_runtime::block_on(stream_attempt(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &CancellationToken::new(),
    ));
    assert!(
        result.is_err(),
        "invalid UTF-8 must not become replacement characters"
    );
}

#[test]
fn replacement_cleanup_does_not_cancel_the_new_owner() {
    let runtime = AnswerRuntime::default();
    let old = runtime.begin(7);
    let new = runtime.begin(7);
    assert!(old.token.is_cancelled());
    drop(old);
    assert!(!new.token.is_cancelled());
    assert!(runtime.is_active());
    runtime.cancel(7);
    assert!(new.token.is_cancelled());
    assert!(
        runtime.is_active(),
        "admission must remain closed until owned cleanup completes"
    );
    drop(new);
    assert!(!runtime.is_active());
}

#[test]
fn cancellation_before_native_admission_is_preserved() {
    let runtime = AnswerRuntime::default();
    runtime.cancel(91);
    assert!(!runtime.is_active());
    let active = runtime.begin(91);
    assert!(
        active.token.is_cancelled(),
        "an early Stop must close admission when the scheduled command begins"
    );
    drop(active);
    assert!(!runtime.is_active());
    let unrelated = runtime.begin(92);
    assert!(!unrelated.token.is_cancelled());
}

#[test]
fn provider_fixture_drop_without_a_client_is_prompt() {
    let provider = Provider::serve(|_| {});
    let (base, bearer) = provider.supervisor.endpoint(false);
    let (closed_tx, closed_rx) = mpsc::channel();
    let cleanup = std::thread::spawn(move || {
        drop(provider);
        closed_tx.send(()).unwrap();
    });
    let prompt = closed_rx.recv_timeout(Duration::from_millis(250)).is_ok();
    if !prompt {
        // Wake the old blocking accept on RED so the regression cleans up its thread.
        let mut socket =
            std::net::TcpStream::connect(base.strip_prefix("http://").unwrap()).unwrap();
        let body = r#"{"stream":true,"input":"fixture prompt"}"#;
        write!(socket, "POST /v1/responses HTTP/1.1\r\nAuthorization: Bearer {bearer}\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        closed_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    cleanup.join().unwrap();
    assert!(
        prompt,
        "dropping an unused provider must stop its accept loop within 250 ms"
    );
}

#[test]
fn provider_fixture_drop_interrupts_an_accepted_incomplete_request() {
    let provider = Provider::serve(|_| {});
    let directory = provider.directory.clone();
    let (base, _) = provider.supervisor.endpoint(false);
    let mut client =
        Some(std::net::TcpStream::connect(base.strip_prefix("http://").unwrap()).unwrap());
    let deadline = Instant::now() + Duration::from_secs(3);
    while !provider.accepted.load(Ordering::Acquire) {
        assert!(
            Instant::now() < deadline,
            "provider never acknowledged accept"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    let (closed_tx, closed_rx) = mpsc::channel();
    let cleanup = std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(provider)));
        closed_tx.send(result.is_ok()).unwrap();
    });
    let prompt = closed_rx.recv_timeout(Duration::from_millis(250));
    let clean = match prompt {
        Ok(clean) => clean,
        Err(_) => {
            // Release the baseline blocking read after RED, without leaking a fixture thread.
            drop(client.take());
            closed_rx.recv_timeout(Duration::from_secs(3)).unwrap()
        }
    };
    cleanup.join().unwrap();
    if directory.exists() {
        std::fs::remove_dir_all(directory).unwrap();
    }
    assert!(prompt.is_ok(), "accepted request cleanup exceeded 250 ms");
    assert!(clean, "cancelled input must not panic during cleanup");
}

#[test]
fn remembered_pre_admission_cancellations_are_bounded_and_deduplicated() {
    let runtime = AnswerRuntime::default();
    for id in 0..600 {
        runtime.cancel(id);
        runtime.cancel(id);
    }
    let requests = runtime.requests.lock().unwrap();
    assert_eq!(
        requests.cancelled_before_start.len(),
        MAX_PENDING_CANCELLATIONS
    );
    assert_eq!(
        requests.cancelled_before_start.front(),
        Some(&(600 - MAX_PENDING_CANCELLATIONS as u64))
    );
    assert_eq!(requests.cancelled_before_start.back(), Some(&599));
    assert!(requests.active.is_empty());
    drop(requests);
    let latest = runtime.begin(599);
    assert!(latest.token.is_cancelled());
    assert_eq!(
        runtime
            .requests
            .lock()
            .unwrap()
            .cancelled_before_start
            .len(),
        MAX_PENDING_CANCELLATIONS - 1
    );
}

#[test]
fn shutdown_cancels_owned_work_and_rejects_new_admission() {
    let runtime = AnswerRuntime::default();
    let active = runtime.begin(1);
    runtime.cancel_all();
    assert!(active.token.is_cancelled());
    let later = runtime.begin(2);
    assert!(later.token.is_cancelled());
    drop(active);
    drop(later);
    assert!(!runtime.is_active());
}

#[test]
fn dispatch_rechecks_current_consent_and_attribution_after_preparation() {
    let configured = ProviderRegistry::in_memory().routes();
    let attempts = routes(RuntimeMode::Auto, true, true, &configured).unwrap();
    assert_eq!(
        validate_dispatch(&attempts[0], false, &configured)
            .unwrap_err()
            .code,
        "cloud_consent_required"
    );
    assert!(validate_dispatch(&attempts[1], false, &configured).is_ok());
    assert_eq!(
        validate_dispatch(&attempts[0], true, &[]).unwrap_err().code,
        "route_unavailable"
    );
    let mut changed = configured.clone();
    changed
        .iter_mut()
        .find(|route| route.alias == attempts[0].alias)
        .unwrap()
        .base_url = Some("https://example.invalid/v1".into());
    assert_eq!(
        validate_dispatch(&attempts[0], true, &changed)
            .unwrap_err()
            .code,
        "route_unavailable"
    );
}

#[test]
fn cancellation_at_failure_boundary_does_not_enter_local_fallback() {
    let routes = [
        RouteAttempt {
            alias: "lumen.answer.cloud".into(),
            provider: "cloud-fixture".into(),
            model: "cloud-fixture-model".into(),
            applied: None,
        },
        local_route(),
    ];
    let token = CancellationToken::new();
    let (channel, events) = channel();
    let mut calls = 0;
    let result = tauri::async_runtime::block_on(run_attempts(
        &routes,
        &channel,
        &token,
        tokio::time::Instant::now() + Duration::from_secs(1),
        |_| {
            calls += 1;
            token.cancel();
            std::future::ready(Err(RouteFailure::new("provider_unavailable")))
        },
    ));
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert_eq!(calls, 1);
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "started")
            .count(),
        1
    );
}

#[test]
fn attempt_preparation_is_cancelled_even_when_the_attempt_is_not_cooperative() {
    let (channel, _) = channel();
    let token = CancellationToken::new();
    let signal = token.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        signal.cancel();
    });
    let result = tauri::async_runtime::block_on(async {
        tokio::time::timeout(
            Duration::from_millis(250),
            run_attempts(
                &[local_route()],
                &channel,
                &token,
                tokio::time::Instant::now() + Duration::from_secs(1),
                |_| std::future::pending(),
            ),
        )
        .await
    });
    canceller.join().unwrap();
    assert!(
        result.is_ok(),
        "attempt preparation retained a cancelled request"
    );
    assert_eq!(result.unwrap().unwrap_err().code, "cancelled");
}

#[test]
fn bounded_header_and_idle_waits_fail_without_socket_eof() {
    for (headers, expected) in [(false, "header_timeout"), (true, "stream_timeout")] {
        let provider = Provider::serve(move |mut socket| {
            if headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
                socket.flush().unwrap();
            }
            std::thread::sleep(Duration::from_millis(400));
        });
        let (channel, _) = channel();
        let began = Instant::now();
        let result = tauri::async_runtime::block_on(transport::stream(
            &provider.supervisor,
            &local_route(),
            "fixture prompt",
            &channel,
            &CancellationToken::new(),
            tokio::time::Instant::now() + Duration::from_secs(1),
            transport::StreamPolicy {
                // The idle case must admit headers before probing its unchanged 60 ms idle bound.
                headers: if headers {
                    Duration::from_secs(1)
                } else {
                    Duration::from_millis(60)
                },
                idle: Duration::from_millis(60),
            },
        ));
        assert_eq!(result.unwrap_err().code, expected);
        assert!(began.elapsed() < Duration::from_millis(250));
    }
}

#[test]
fn usage_is_parsed_once_from_valid_completion_and_headers_are_sanitized() {
    let provider = Provider::serve(move |mut socket| {
        let body = "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":3}}}\n\n";
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nx-ratelimit-remaining-tokens: 4\r\nx-ratelimit-reset-tokens: sk-private-source\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    });
    let (channel, events) = channel();
    let result = tauri::async_runtime::block_on(stream_attempt(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &CancellationToken::new(),
    ))
    .unwrap()
    .unwrap();
    assert_eq!(
        (
            result.input_tokens,
            result.output_tokens,
            result.remaining_tokens
        ),
        (12, 3, Some(4))
    );
    assert!(result.reset_at.is_none());
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "usage")
            .count(),
        1
    );
}

#[test]
fn cumulative_output_event_and_wire_limits_bound_small_frames() {
    let output = format!(
        "data: {}\n\n",
        serde_json::json!({"type":"response.output_text.delta", "delta":"x".repeat(16_384)})
    )
    .repeat(100);
    let events = "data: {\"type\":\"response.created\"}\n\n".repeat(40_000);
    let wire = format!(":{}\n\n", "x".repeat(4096)).repeat(2048);
    for body in [output, events, wire] {
        let provider = Provider::serve(move |mut socket| {
            let _ = write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
        });
        let (channel, captured) = channel();
        let result = tauri::async_runtime::block_on(stream_attempt(
            &provider.supervisor,
            &local_route(),
            "fixture prompt",
            &channel,
            &CancellationToken::new(),
        ));
        assert_eq!(result.unwrap_err().code, "response_too_large");
        assert!(
            !captured
                .lock()
                .unwrap()
                .iter()
                .any(|event| event["type"] == "completed")
        );
    }
}

#[test]
fn the_total_deadline_bounds_a_live_socket_across_transport_waits() {
    let provider = Provider::serve(move |_socket| std::thread::sleep(Duration::from_millis(400)));
    let (channel, _) = channel();
    let began = Instant::now();
    let result = tauri::async_runtime::block_on(transport::stream(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &CancellationToken::new(),
        tokio::time::Instant::now() + Duration::from_millis(60),
        transport::StreamPolicy::default(),
    ));
    assert_eq!(result.unwrap_err().code, "request_timeout");
    assert!(began.elapsed() < Duration::from_millis(250));
}

#[test]
fn cancellation_during_a_chunk_does_not_emit_more_tokens_or_complete() {
    let body = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"obsolete\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n";
    let provider = Provider::serve(move |mut socket| {
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    });
    let token = CancellationToken::new();
    let signal = token.clone();
    let captured = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let output = captured.clone();
    let channel = Channel::new(move |body| {
        let InvokeResponseBody::Json(body) = body else {
            panic!("JSON only");
        };
        let event: serde_json::Value = serde_json::from_str(&body).unwrap();
        if event["type"] == "delta" {
            signal.cancel();
        }
        output.lock().unwrap().push(event);
        Ok(())
    });
    let result = tauri::async_runtime::block_on(stream_attempt(
        &provider.supervisor,
        &local_route(),
        "fixture prompt",
        &channel,
        &token,
    ));
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert_eq!(
        captured
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| event["text"].as_str())
            .collect::<String>(),
        "first"
    );
}

fn bridge_write(output: &Arc<Mutex<std::io::Stdout>>, value: &serde_json::Value) {
    let mut output = output.lock().unwrap();
    // libtest may have printed its test-name prefix without a newline.
    writeln!(output, "\n{value}").unwrap();
    output.flush().unwrap();
}

fn fixture_provider(
    text: String,
    failed: bool,
    stall: bool,
    cancellation: CancellationToken,
) -> Provider {
    Provider::serve(move |mut socket| {
        let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
        let delta = |text: &str| {
            format!(
                "data: {}\n\n",
                serde_json::json!({"type":"response.output_text.delta","delta":text})
            )
        };
        let body = if text == "burst" {
            (0..1000).map(|_| delta("x")).collect::<String>()
        } else {
            delta(&text)
        };
        let _ = write!(socket, "{:x}\r\n{body}\r\n", body.len());
        let _ = socket.flush();
        if stall {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !cancellation.is_cancelled() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            return;
        }
        if failed {
            std::thread::sleep(Duration::from_millis(40));
        }
        let terminal = if failed {
            "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"private upstream context\"}}}\n\n"
        } else {
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
        };
        let _ = write!(socket, "{:x}\r\n{terminal}\r\n0\r\n\r\n", terminal.len());
    })
}

#[derive(Deserialize)]
#[serde(
    tag = "command",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum BridgeCommand {
    Start { request: AnswerRequest },
    Cancel { request_id: u64 },
}

#[test]
#[ignore = "interactive owned loopback transport fixture; driven by test:answer-native"]
fn native_bridge() {
    assert_eq!(std::env::var("LUMEN_ANSWER_BRIDGE").as_deref(), Ok("1"));
    let runtime = Arc::new(AnswerRuntime::default());
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let mut tasks = Vec::new();
    let mut retries = 0usize;
    for line in std::io::stdin().lines() {
        let command: BridgeCommand = serde_json::from_str(&line.unwrap()).unwrap();
        match command {
            BridgeCommand::Cancel { request_id } => runtime.cancel(request_id),
            BridgeCommand::Start { request } => {
                assert!(tasks.len() < 128, "bounded fixture sessions only");
                if request.query == "retry" {
                    retries += 1;
                }
                let retry = retries;
                let runtime = runtime.clone();
                let output = output.clone();
                tasks.push(tauri::async_runtime::spawn(async move {
                    let active = runtime.begin(request.request_id);
                    let cancellation = active.token.as_ref();
                    let request_id = request.request_id;
                    let messages = output.clone();
                    let channel = Channel::new(move |body| {
                        let InvokeResponseBody::Json(body) = body else { panic!("JSON fixture channel only"); };
                        let event: serde_json::Value = serde_json::from_str(&body).unwrap();
                        bridge_write(&messages, &serde_json::json!({"requestId":request_id,"event":event}));
                        Ok(())
                    });
                    let source = Citation { file_id: "fixture-source".into(), label: "Fixture source".into(), page: Some(2), timestamp_seconds: None };
                    send(&channel, AnswerEvent::Citation { citation: source }).unwrap();
                    let mut routes = vec![local_route()];
                    if request.query == "fallback" && !matches!(request.mode, RuntimeMode::Local) && request.cloud_consent {
                        routes.insert(0, RouteAttempt { alias: "lumen.answer.cloud".into(), provider: "cloud-fixture".into(), model: "cloud-fixture-model".into(), applied: None });
                    }
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                    let result = run_attempts(&routes, &channel, cancellation, deadline, |route| {
                        let request = &request;
                        let channel = &channel;
                        async move {
                            if request.query == "failure" {
                                let provider = Provider::serve(|mut socket| {
                                    let _ = socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
                                });
                                return transport::stream(&provider.supervisor, route, "fixture prompt", channel, cancellation, deadline, transport::StreamPolicy::default()).await;
                            }
                            let cloud = route.alias == "lumen.answer.cloud";
                            if cloud {
                                // Explicit obsolete metadata precondition; production emits usage only on successful completion.
                                send(channel, AnswerEvent::Usage { usage: Usage { input_tokens: 7, output_tokens: 99, remaining_tokens: Some(0), reset_at: None } })?;
                            }
                            let stall = request.query == "replacement-a" || (request.query == "retry" && retry == 1);
                            let text = if cloud { "obsolete cloud output" }
                                else if stall { "Partial stalled answer" }
                                else { match request.query.as_str() {
                                    "fallback" => "Local fixture answer 🌍", "retry" => "Retry fixture answer",
                                    "replacement-b" => "Replacement fixture answer", "burst" => "burst",
                                    _ => return Err(RouteFailure::new("invalid_request")),
                                } };
                            let provider = fixture_provider(text.into(), cloud, stall, cancellation.clone());
                            transport::stream(&provider.supervisor, route, "fixture prompt", channel, cancellation, deadline, transport::StreamPolicy::default()).await
                        }
                    }).await;
                    if let Err(failure) = result { finish_failure(&channel, failure); }
                    drop(active);
                    bridge_write(&output, &serde_json::json!({"requestId":request_id,"done":true}));
                }));
            }
        }
    }
    runtime.cancel_all();
    tauri::async_runtime::block_on(async {
        for task in tasks {
            task.await.unwrap();
        }
    });
    assert!(!runtime.is_active());
}
