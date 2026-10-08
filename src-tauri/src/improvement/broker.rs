use super::{
    docker::{ModelBroker, validate_model_body},
    store::ImprovementStore,
    types::*,
};
use futures_util::{StreamExt, future::BoxFuture};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

struct Account {
    fingerprint: Option<(String, Value)>,
}
#[derive(Clone)]
pub struct GatewayBroker {
    client: reqwest::Client,
    url: String,
    bearer: String,
    alias: String,
    store: Arc<ImprovementStore>,
    cloud: bool,
    budget: u64,
    job: String,
    phase: &'static str,
    began: Instant,
    deadline: Duration,
    account: Arc<tokio::sync::Mutex<Account>>,
    cancelled: CancellationToken,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
}
impl GatewayBroker {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        endpoint: (String, String),
        alias: String,
        store: Arc<ImprovementStore>,
        cloud: bool,
        budget: u64,
        job: String,
        phase: &'static str,
        deadline: Duration,
        cancelled: CancellationToken,
        current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Self, String> {
        if !["lumen.improvement.local", "lumen.improvement.cloud"].contains(&alias.as_str()) {
            return Err("Invalid improvement route.".into());
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(90))
                .build()
                .map_err(|_| "Improvement model client is unavailable.")?,
            url: format!("{}/v1/chat/completions", endpoint.0),
            bearer: endpoint.1,
            alias,
            store,
            cloud,
            budget,
            job,
            phase,
            began: Instant::now(),
            deadline,
            account: Arc::new(tokio::sync::Mutex::new(Account { fingerprint: None })),
            cancelled,
            current,
        })
    }
    fn admitted(&self) -> bool {
        !self.cancelled.is_cancelled()
            && self.began.elapsed() < self.deadline
            && (self.current)()
            && self.store.settings().is_ok_and(|s| {
                s.enabled
                    && !s.paused
                    && (!self.cloud || s.cloud_consent)
                    && (s.route_mode == RouteMode::Cloud) == self.cloud
            })
    }
    async fn send(&self, mut body: Value, cancel: CancellationToken) -> Result<Value, String> {
        validate_model_body(&body)?;
        let mut account = tokio::select! {_=cancel.cancelled()=>return Err("improvement_cancelled".into()),_=self.cancelled.cancelled()=>return Err("improvement_cancelled".into()),lock=self.account.lock()=>lock};
        if !self.admitted() {
            return Err("improvement_cancelled".into());
        }
        // UTF-8 bytes form a conservative input-token ceiling for supported BPE
        // models. Reserve before sending; reported usage is required afterwards.
        let output = body["max_tokens"]
            .as_u64()
            .or_else(|| body["max_completion_tokens"].as_u64())
            .unwrap_or(4096);
        let reserved = serde_json::to_vec(&body)
            .map_err(|_| "Invalid model request.")?
            .len() as u64
            + output
            + 1024;
        // One pacer spans generation and evaluation and follows the existing
        // enrichment lane's 10 requests/minute allowance.
        static PACER: std::sync::OnceLock<tokio::sync::Mutex<Instant>> = std::sync::OnceLock::new();
        let pacer = PACER.get_or_init(|| tokio::sync::Mutex::new(Instant::now()));
        let mut next = tokio::select! {_=cancel.cancelled()=>return Err("improvement_cancelled".into()),_=self.cancelled.cancelled()=>return Err("improvement_cancelled".into()),lock=pacer.lock()=>lock};
        tokio::select! {_=cancel.cancelled()=>return Err("improvement_cancelled".into()),_=self.cancelled.cancelled()=>return Err("improvement_cancelled".into()),_=tokio::time::sleep(next.saturating_duration_since(Instant::now()))=>{}}
        #[cfg(not(test))]
        let spacing = Duration::from_millis(6200);
        #[cfg(test)]
        let spacing = Duration::from_millis(2);
        *next = Instant::now() + spacing;
        drop(next);
        if !self.admitted() {
            return Err("improvement_cancelled".into());
        }
        let reservation = self.store.reserve_tokens(
            &self.job,
            self.phase,
            reserved,
            self.budget,
            self.deadline.as_millis() as u64,
        )?;
        body["model"] = json!(self.alias);
        body["stream"] = json!(false);
        body.as_object_mut()
            .ok_or("Invalid model request.")?
            .remove("stream_options");
        let operation = async {
            let began = Instant::now();
            let response = self
                .client
                .post(&self.url)
                .bearer_auth(&self.bearer)
                .header("x-lumen-lane", "enrichment")
                .json(&body)
                .send()
                .await
                .map_err(|_| "Improvement model is unavailable.")?;
            if response.status().as_u16() == 429 {
                return Err("improvement_budget_exceeded".into());
            }
            if !response.status().is_success() {
                return Err("Improvement model refused the request.".into());
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| "Improvement model response is unavailable.")?;
                if bytes.len() + chunk.len() > 524_288 {
                    return Err("Improvement model response is too large.".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let mut response: Value = serde_json::from_slice(&bytes)
                .map_err(|_| "Improvement model response is invalid.")?;
            response["lumenHostLatencyMs"] = json!(began.elapsed().as_millis().max(1) as u64);
            let input = response["usage"]["prompt_tokens"]
                .as_u64()
                .ok_or("Improvement requires metered model usage.")?;
            let output = response["usage"]["completion_tokens"]
                .as_u64()
                .ok_or("Improvement requires metered model usage.")?;
            let used = input
                .checked_add(output)
                .ok_or("improvement_budget_exceeded")?;
            if response["choices"]
                .as_array()
                .is_none_or(|choices| choices.len() != 1)
                || !response["choices"][0]["message"].is_object()
                || !matches!(
                    response["choices"][0]["finish_reason"].as_str(),
                    Some("stop" | "tool_calls")
                )
            {
                return Err("Improvement model returned incomplete output.".into());
            }
            Ok::<(Value, u64), String>((response, used))
        };
        let remaining = self.deadline.saturating_sub(self.began.elapsed());
        let (response, used) = tokio::select! {_=cancel.cancelled()=>return Err("improvement_cancelled".into()),_=self.cancelled.cancelled()=>return Err("improvement_cancelled".into()),result=tokio::time::timeout(remaining,operation)=>result.map_err(|_|"improvement_budget_exceeded")??};
        if !self.store.settle_tokens(&reservation, used)? {
            return Err("improvement_budget_exceeded".into());
        }
        let model = response["model"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 256)
            .ok_or("Improvement model identity is unavailable.")?
            .to_owned();
        let fingerprint = (model, response["system_fingerprint"].clone());
        if account
            .fingerprint
            .as_ref()
            .is_some_and(|previous| previous != &fingerprint)
        {
            return Err("Improvement model identity changed during evaluation.".into());
        }
        account.fingerprint = Some(fingerprint);
        if !self.admitted() {
            return Err("improvement_cancelled".into());
        }
        Ok(response)
    }
    pub async fn probe(&self, cancel: CancellationToken) -> Result<(), String> {
        let response=self.send(json!({"model":"lumen-host","stream":false,"max_tokens":64,"messages":[{"role":"user","content":"Call lumen_probe with ready:true. This is a synthetic compatibility test."}],"tools":[{"type":"function","function":{"name":"lumen_probe","description":"Confirm typed tool calling","parameters":{"type":"object","additionalProperties":false,"properties":{"ready":{"type":"boolean"}},"required":["ready"]}}}],"tool_choice":{"type":"function","function":{"name":"lumen_probe"}}}),cancel).await?;
        let calls = response["choices"][0]["message"]["tool_calls"]
            .as_array()
            .ok_or("Selected model does not support Prime tool calling.")?;
        if calls.len() != 1
            || calls[0]["function"]["name"] != "lumen_probe"
            || calls[0]["function"]["arguments"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                != Some(json!({"ready":true}))
        {
            return Err("Selected model failed the Prime compatibility test.".into());
        }
        Ok(())
    }
}
impl ModelBroker for GatewayBroker {
    fn request(
        &self,
        body: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let this = self.clone();
        Box::pin(async move { this.send(body, cancel).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn response(fingerprint: &str) -> Value {
        json!({"model":"fixture-model","system_fingerprint":fingerprint,"choices":[{"message":{"role":"assistant","content":"synthetic"},"finish_reason":"stop"}],"usage":{"prompt_tokens":80,"completion_tokens":20}})
    }
    fn body() -> Value {
        json!({"model":"lumen-host","stream":false,"max_tokens":64,"messages":[{"role":"user","content":"synthetic"}]})
    }
    fn broker(url: String, store: Arc<ImprovementStore>, cloud: bool, limit: u64) -> GatewayBroker {
        GatewayBroker::new(
            (url, "fixture-secret".into()),
            if cloud {
                "lumen.improvement.cloud"
            } else {
                "lumen.improvement.local"
            }
            .into(),
            store,
            cloud,
            limit,
            uuid::Uuid::new_v4().to_string(),
            "generation",
            Duration::from_secs(10),
            CancellationToken::new(),
            Arc::new(|| true),
        )
        .unwrap()
    }
    fn enabled(cloud: bool, consent: bool) -> Arc<ImprovementStore> {
        let store = Arc::new(ImprovementStore::memory().unwrap());
        store
            .set_settings(&ImprovementSettings {
                enabled: true,
                cloud_consent: consent,
                route_mode: if cloud {
                    RouteMode::Cloud
                } else {
                    RouteMode::Local
                },
                paused: false,
            })
            .unwrap();
        store
    }
    fn server(responses: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<Value>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut captured = Vec::new();
            for response in responses {
                let began = Instant::now();
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && began.elapsed() < Duration::from_secs(5) =>
                        {
                            std::thread::sleep(Duration::from_millis(2))
                        }
                        Err(error) => panic!("fixture listener failed: {error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let request = loop {
                    let mut chunk = [0; 4096];
                    let read = stream.read(&mut chunk).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&chunk[..read]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            assert!(headers.starts_with("post /v1/chat/completions "));
                            assert!(headers.contains("authorization: bearer fixture-secret"));
                            assert!(headers.contains("x-lumen-lane: enrichment"));
                            break serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                                .unwrap();
                        }
                    }
                };
                captured.push(request);
                let response = response.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
            }
            captured
        });
        (url, worker)
    }

    #[tokio::test]
    async fn native_broker_uses_fixed_enrichment_alias_and_rejects_changing_model() {
        let (url, worker) = server(vec![response("one"), response("two")]);
        let broker = broker(url, enabled(false, false), false, 20000);
        assert!(
            broker
                .request(body(), CancellationToken::new())
                .await
                .is_ok()
        );
        assert!(
            broker
                .request(body(), CancellationToken::new())
                .await
                .unwrap_err()
                .contains("identity changed")
        );
        let requests = worker.join().unwrap();
        assert!(
            requests
                .iter()
                .all(|request| request["model"] == "lumen.improvement.local"
                    && request["stream"] == false)
        );
    }

    #[tokio::test]
    async fn unmetered_response_keeps_reservation_and_blocks_more_model_traffic() {
        let mut missing = response("one");
        missing.as_object_mut().unwrap().remove("usage");
        let (url, worker) = server(vec![missing]);
        let broker = broker(url, enabled(false, false), false, 1800);
        assert!(
            broker
                .request(body(), CancellationToken::new())
                .await
                .unwrap_err()
                .contains("metered")
        );
        assert_eq!(
            broker
                .request(body(), CancellationToken::new())
                .await
                .unwrap_err(),
            "improvement_budget_exceeded"
        );
        assert_eq!(worker.join().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn cloud_consent_is_checked_before_any_http_connection() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let broker = broker(
            format!("http://{}", listener.local_addr().unwrap()),
            enabled(true, false),
            true,
            20000,
        );
        assert_eq!(
            broker
                .request(body(), CancellationToken::new())
                .await
                .unwrap_err(),
            "improvement_cancelled"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn native_cancellation_aborts_a_real_blocked_gateway_request() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (finish, done) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0; 1024];
            assert!(stream.read(&mut bytes).unwrap() > 0);
            entered.send(()).unwrap();
            let _ = done.recv_timeout(Duration::from_secs(5));
        });
        let broker = broker(url, enabled(false, false), false, 20000);
        let token = CancellationToken::new();
        let cancel = token.clone();
        let request = tokio::spawn(async move { broker.request(body(), token).await });
        tokio::time::timeout(Duration::from_secs(5), ready)
            .await
            .unwrap()
            .unwrap();
        let began = Instant::now();
        cancel.cancel();
        assert_eq!(request.await.unwrap().unwrap_err(), "improvement_cancelled");
        assert!(began.elapsed() < Duration::from_millis(100));
        let _ = finish.send(());
        worker.join().unwrap();
    }
}
