use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{AnswerEvent, GatewaySupervisor, RouteAttempt, RouteFailure, Usage, send};

const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_WIRE_BYTES: usize = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_EVENTS: usize = 32_768;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy)]
pub(super) struct StreamPolicy {
    pub headers: Duration,
    pub idle: Duration,
}

impl Default for StreamPolicy {
    fn default() -> Self {
        Self {
            headers: Duration::from_secs(30),
            idle: Duration::from_secs(30),
        }
    }
}

#[derive(Default)]
struct SseDecoder {
    line: Vec<u8>,
    data: String,
    event: String,
    frame_bytes: usize,
    skip_lf: bool,
    first_line: bool,
}

struct Frame {
    data: String,
    event: String,
}

impl SseDecoder {
    fn new() -> Self {
        Self {
            first_line: true,
            ..Self::default()
        }
    }

    // Decode complete lines, so network fragmentation never splits a UTF-8 decode.
    // CR is dispatched immediately; a following LF is consumed even across chunks.
    fn push(&mut self, byte: u8) -> Result<Option<Frame>, RouteFailure> {
        if self.skip_lf {
            self.skip_lf = false;
            if byte == b'\n' {
                return Ok(None);
            }
        }
        if byte == b'\r' || byte == b'\n' {
            self.skip_lf = byte == b'\r';
            return self.finish_line();
        }
        self.frame_bytes += 1;
        if self.frame_bytes > MAX_FRAME_BYTES {
            return Err(RouteFailure::new("response_too_large"));
        }
        self.line.push(byte);
        Ok(None)
    }

    fn finish_line(&mut self) -> Result<Option<Frame>, RouteFailure> {
        let mut line =
            std::str::from_utf8(&self.line).map_err(|_| RouteFailure::new("invalid_response"))?;
        if self.first_line {
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
            self.first_line = false;
        }
        if line.is_empty() {
            self.line.clear();
            self.frame_bytes = 0;
            if self.data.is_empty() {
                self.event.clear();
                return Ok(None);
            }
            self.data.pop(); // The SSE algorithm removes the final appended newline.
            return Ok(Some(Frame {
                data: std::mem::take(&mut self.data),
                event: std::mem::take(&mut self.event),
            }));
        }
        if !line.starts_with(':') {
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "data" => {
                    if self.data.len() + value.len() + 1 > MAX_FRAME_BYTES {
                        return Err(RouteFailure::new("response_too_large"));
                    }
                    self.data.push_str(value);
                    self.data.push('\n');
                }
                "event" => self.event = value.to_owned(),
                _ => {}
            }
        }
        self.line.clear();
        Ok(None)
    }
}

fn provider_failure(value: &Value) -> RouteFailure {
    let code = value["code"]
        .as_str()
        .or_else(|| value["error"]["code"].as_str())
        .or_else(|| value["response"]["error"]["code"].as_str());
    RouteFailure::new(match code {
        Some("rate_limit_exceeded" | "rate_limited" | "insufficient_quota") => "rate_limited",
        Some("invalid_api_key" | "authentication_error" | "unauthorized") => {
            "provider_unauthorized"
        }
        _ => "provider_unavailable",
    })
}

fn safe_integer(value: &Value) -> Option<u64> {
    value.as_u64().filter(|number| *number <= MAX_SAFE_INTEGER)
}

fn completion_usage(
    value: &Value,
    remaining_tokens: Option<u64>,
    reset_at: Option<String>,
) -> Result<Option<Usage>, RouteFailure> {
    let response = value
        .get("response")
        .and_then(Value::as_object)
        .ok_or_else(|| RouteFailure::new("invalid_response"))?;
    if response.get("status").and_then(Value::as_str) != Some("completed") {
        return Err(RouteFailure::new("incomplete_response"));
    }
    let Some(usage) = response.get("usage").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let input_tokens = safe_integer(&usage["input_tokens"])
        .ok_or_else(|| RouteFailure::new("invalid_response"))?;
    let output_tokens = safe_integer(&usage["output_tokens"])
        .ok_or_else(|| RouteFailure::new("invalid_response"))?;
    Ok(Some(Usage {
        input_tokens,
        output_tokens,
        remaining_tokens,
        reset_at,
    }))
}

pub(super) async fn stream(
    supervisor: &GatewaySupervisor,
    route: &RouteAttempt,
    prompt: &str,
    channel: &Channel<AnswerEvent>,
    cancellation: &CancellationToken,
    deadline: Instant,
    policy: StreamPolicy,
) -> Result<Option<Usage>, RouteFailure> {
    let (base_url, bearer) = supervisor.endpoint(false);
    // This is an owned loopback connection, never an environment proxy or redirect.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(5))
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|_| RouteFailure::new("provider_unavailable"))?;
    let request = client.post(format!("{base_url}/v1/responses"))
        .bearer_auth(bearer).header("x-lumen-lane", "interactive")
        .json(&serde_json::json!({ "model": route.alias, "input": prompt, "stream": true, "max_output_tokens": 1200 }))
        .send();
    let response = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(RouteFailure::new("cancelled")),
        () = tokio::time::sleep_until(deadline) => return Err(RouteFailure::new("request_timeout")),
        () = tokio::time::sleep(policy.headers) => return Err(RouteFailure::new("header_timeout")),
        response = request => response.map_err(|_| RouteFailure::new("provider_unavailable"))?,
    };
    if !response.status().is_success() {
        // Do not consume an untrusted error body, which can stall or contain keys/context.
        return Err(RouteFailure::new(match response.status().as_u16() {
            429 => "rate_limited",
            401 | 403 => "provider_unauthorized",
            _ => "provider_unavailable",
        }));
    }
    let remaining_tokens = response
        .headers()
        .get("x-ratelimit-remaining-tokens")
        .or_else(|| response.headers().get("ratelimit-remaining"))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value <= MAX_SAFE_INTEGER);
    let reset_at = response
        .headers()
        .get("x-ratelimit-reset-tokens")
        .or_else(|| response.headers().get("ratelimit-reset"))
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || b".smhd".contains(&byte))
        })
        .map(str::to_owned);
    let mut bytes = response.bytes_stream();
    let mut decoder = SseDecoder::new();
    let mut wire_bytes = 0usize;
    let mut output_bytes = 0usize;
    let mut events = 0usize;
    loop {
        let next = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(RouteFailure::new("cancelled")),
            () = tokio::time::sleep_until(deadline) => return Err(RouteFailure::new("request_timeout")),
            () = tokio::time::sleep(policy.idle) => return Err(RouteFailure::new("stream_timeout")),
            next = bytes.next() => next,
        };
        let Some(chunk) = next else {
            return Err(RouteFailure::new("incomplete_response"));
        };
        let chunk = chunk.map_err(|_| RouteFailure::new("provider_unavailable"))?;
        wire_bytes = wire_bytes.saturating_add(chunk.len());
        if wire_bytes > MAX_WIRE_BYTES {
            return Err(RouteFailure::new("response_too_large"));
        }
        for (position, byte) in chunk.iter().copied().enumerate() {
            if position % 4096 == 0 {
                if cancellation.is_cancelled() {
                    return Err(RouteFailure::new("cancelled"));
                }
                if Instant::now() >= deadline {
                    return Err(RouteFailure::new("request_timeout"));
                }
            }
            let Some(frame) = decoder.push(byte)? else {
                continue;
            };
            events += 1;
            if events > MAX_EVENTS {
                return Err(RouteFailure::new("response_too_large"));
            }
            if frame.data.trim() == "[DONE]" {
                return Err(RouteFailure::new("incomplete_response"));
            }
            let value: Value = serde_json::from_str(&frame.data)
                .map_err(|_| RouteFailure::new("invalid_response"))?;
            if !value.is_object() {
                return Err(RouteFailure::new("invalid_response"));
            }
            let kind = match value.get("type") {
                Some(value) => value
                    .as_str()
                    .ok_or_else(|| RouteFailure::new("invalid_response"))?,
                None => &frame.event,
            };
            match kind {
                "response.output_text.delta" => {
                    if cancellation.is_cancelled() {
                        return Err(RouteFailure::new("cancelled"));
                    }
                    let delta = value
                        .get("delta")
                        .and_then(Value::as_str)
                        .ok_or_else(|| RouteFailure::new("invalid_response"))?;
                    output_bytes = output_bytes.saturating_add(delta.len());
                    if output_bytes > MAX_OUTPUT_BYTES {
                        return Err(RouteFailure::new("response_too_large"));
                    }
                    send(
                        channel,
                        AnswerEvent::Delta {
                            text: delta.to_owned(),
                        },
                    )?;
                }
                "response.completed" => {
                    if cancellation.is_cancelled() {
                        return Err(RouteFailure::new("cancelled"));
                    }
                    return completion_usage(&value, remaining_tokens, reset_at);
                }
                "response.incomplete" => return Err(RouteFailure::new("incomplete_response")),
                "error" | "response.failed" => return Err(provider_failure(&value)),
                "" => return Err(RouteFailure::new("invalid_response")),
                _ => {} // Well-formed informational Responses events do not contain answer text.
            }
        }
    }
}
