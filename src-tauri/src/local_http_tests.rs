use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};

pub(crate) const LIMIT: usize = 4 * 1024 * 1024;

/// An owned ephemeral server; the request is read fully before replying.
pub(crate) fn server_at(
    listener: TcpListener,
    reply: Vec<u8>,
    delay: Duration,
) -> thread::JoinHandle<Vec<u8>> {
    server_parts(listener, Vec::new(), reply, delay)
}

pub(crate) fn server_parts(
    listener: TcpListener,
    headers: Vec<u8>,
    reply: Vec<u8>,
    delay: Duration,
) -> thread::JoinHandle<Vec<u8>> {
    listener.set_nonblocking(true).unwrap();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Vec::new(),
                Err(error) => panic!("loopback accept failed: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            assert_ne!(count, 0);
            request.extend_from_slice(&buffer[..count]);
            if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length:")
                            .map(|value| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let _ = stream.write_all(&headers);
        thread::sleep(delay);
        let _ = stream.write_all(&reply);
        request
    })
}

pub(crate) fn server(reply: Vec<u8>, delay: Duration) -> (String, thread::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    (base, server_at(listener, reply, delay))
}

pub(crate) fn json(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

pub(crate) fn oversized(chunked: bool) -> Vec<u8> {
    let body = format!("\"{}\"", "x".repeat(LIMIT));
    if chunked {
        format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len()).into_bytes()
    } else {
        json(&body)
    }
}

#[test]
fn local_http_proxy_bypass_in_isolated_process() {
    let (proxy, server) = server(
        b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        Duration::ZERO,
    );
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "local_http_proxy_probe",
            "--ignored",
            "--test-threads=1",
            "--nocapture",
        ])
        .env("HTTP_PROXY", &proxy)
        .env("HTTPS_PROXY", &proxy)
        .env("ALL_PROXY", &proxy)
        .env("NO_PROXY", "")
        .env("http_proxy", &proxy)
        .env("https_proxy", &proxy)
        .env("all_proxy", &proxy)
        .env("no_proxy", "")
        .env("LUMEN_LOCAL_HTTP_PROXY_PROBE", "1")
        .status()
        .unwrap();
    let proxied = server.join().unwrap();
    assert!(
        status.success(),
        "local requests must succeed under a configured proxy"
    );
    assert!(
        proxied.is_empty(),
        "the proxy must receive no local request or bearer"
    );
}
