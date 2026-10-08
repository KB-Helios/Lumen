#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sandbox_arguments_do_not_admit_host_access() {
        let args = sandbox_args("installation", "run", "sha256:image");
        for pair in [
            ["--network", "none"],
            ["--user", "10001:10001"],
            ["--cap-drop", "ALL"],
            ["--memory", "2g"],
            ["--pids-limit", "128"],
        ] {
            assert!(args.windows(2).any(|items| items == pair));
        }
        assert!(args.iter().any(|arg| arg == "--read-only"));
        assert!(!args.iter().any(|arg| arg == "--privileged"
            || arg == "-v"
            || arg == "--mount"
            || arg == "--env-file"));
    }

    #[test]
    fn metadata_input_rejects_extra_private_payloads() {
        let mut input = json!({"activeVersion":{"id":1,"parentId":null,"createdAt":0,"answerInstructions":"","computerUseInstructions":"","toolHints":"","preferences":[],"workflows":[]},"evidenceDigest":"a".repeat(64),"configDigest":"b".repeat(64),"failures":[],"developmentCases":[]});
        assert!(validate_input(&input).is_ok());
        input["heldOutCases"] = json!(["private"]);
        assert!(validate_input(&input).is_err());
    }

    #[test]
    fn broker_request_cannot_change_route_or_send_extra_network_fields() {
        let good = json!({"model":"lumen-host","messages":[{"role":"user","content":"Test"}],"stream":false,"max_tokens":4096});
        assert!(validate_model_body(&good).is_ok());
        let mut bad = good.clone();
        bad["base_url"] = json!("https://attacker.invalid");
        assert!(validate_model_body(&bad).is_err());
        bad = good;
        bad["model"] = json!("arbitrary-provider");
        assert!(validate_model_body(&bad).is_err());
    }

    #[tokio::test]
    async fn oversized_unterminated_frame_is_rejected_without_waiting_for_eof() {
        use tokio::io::AsyncWriteExt;
        let (mut sender, receiver) = tokio::io::duplex(FRAME_LIMIT * 2);
        sender
            .write_all(&vec![b'x'; FRAME_LIMIT + 1])
            .await
            .unwrap();
        assert!(
            read_frame(&mut tokio::io::BufReader::new(receiver))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn interleaved_broker_completion_preserves_partially_consumed_frame() {
        let (mut sender, receiver) = tokio::io::duplex(128);
        let mut reader = BufReader::new(receiver);
        let mut buffer = Vec::new();
        sender.write_all(b"{\"v\":1,").await.unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(5),
                read_frame_buffered(&mut reader, &mut buffer)
            )
            .await
            .is_err()
        );
        assert!(!buffer.is_empty());
        sender.write_all(b"\"type\":\"ready\"}\n").await.unwrap();
        let (frame, _) = read_frame_buffered(&mut reader, &mut buffer).await.unwrap();
        assert_eq!(frame, json!({"v":1,"type":"ready"}));
    }
    #[tokio::test]
    async fn blocked_guest_stdin_does_not_block_native_cancellation() {
        let (mut sender, _receiver) = tokio::io::duplex(8);
        let token = CancellationToken::new();
        let cancel = token.clone();
        let write =
            tokio::spawn(async move { write_frame(&mut sender, &vec![b'x'; 1024], &token).await });
        tokio::time::sleep(Duration::from_millis(5)).await;
        let began = std::time::Instant::now();
        cancel.cancel();
        assert!(write.await.unwrap().is_err());
        assert!(began.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn initial_harness_version_zero_is_valid_for_first_generation() {
        let input = json!({"activeVersion":{"id":0,"parentId":null,"createdAt":0,"answerInstructions":"","computerUseInstructions":"","toolHints":"","preferences":[],"workflows":[]},"evidenceDigest":"a".repeat(64),"configDigest":"b".repeat(64),"failures":[],"developmentCases":[]});
        assert!(validate_input(&input).is_ok());
    }

    #[test]
    fn cleanup_rejects_a_container_owned_by_another_installation() {
        let data = json!([{"Id":"a".repeat(64),"Config":{"Labels":{"dev.lumen.improvement.owner":"other","dev.lumen.improvement.runtime":"1","dev.lumen.improvement.run":"run-1"}}}]);
        assert!(owned_container_id("installation", &data).is_err());
    }

    #[test]
    fn duplicate_guest_protocol_keys_are_rejected() {
        assert!(strict_json(br#"{"v":1,"v":2,"type":"result"}"#).is_err());
    }

    #[tokio::test]
    #[ignore = "Requires explicit LUMEN_IMPROVEMENT_ASSETS, staged pinned image and running Docker Desktop Linux engine; synthetic broker, real Prime ACP"]
    async fn actual_docker_prime_acceptance_generation_cancel_and_ownership() {
        struct Broker {
            block: bool,
            requested: Arc<tokio::sync::Notify>,
        }
        impl ModelBroker for Broker {
            fn request(
                &self,
                _body: Value,
                cancel: CancellationToken,
            ) -> BoxFuture<'static, Result<Value, String>> {
                let block = self.block;
                let requested = self.requested.clone();
                Box::pin(async move {
                    requested.notify_one();
                    if block {
                        cancel.cancelled().await;
                        return Err(CANCELLED.into());
                    }
                    let manifest = json!({"baseVersion":1,"kind":"prompt","summary":"Make synthetic fixture answers concise.","evidenceDigest":"a".repeat(64),"answerInstructions":"Use concise cited answers.","computerUseInstructions":null,"toolHints":null,"preferences":[],"workflows":[]});
                    Ok(
                        json!({"id":"chatcmpl-acceptance","object":"chat.completion","created":0,"model":"lumen-host","choices":[{"index":0,"message":{"role":"assistant","content":manifest.to_string()},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":80,"total_tokens":180}}),
                    )
                })
            }
        }
        let assets = std::env::var_os("LUMEN_IMPROVEMENT_ASSETS")
            .expect("Explicit asset directory required");
        let owner = format!("test-{}", uuid::Uuid::new_v4());
        let runtime = Arc::new(DockerRuntime::new(owner.clone(), assets.into()));
        assert_eq!(
            runtime.health().await.state,
            "ready",
            "Image must already be explicitly prepared"
        );
        let manifest = runtime.manifest().await.unwrap();
        let input = json!({"activeVersion":{"id":1,"parentId":null,"createdAt":0,"answerInstructions":"","computerUseInstructions":"","toolHints":"","preferences":[],"workflows":[]},"evidenceDigest":"a".repeat(64),"configDigest":"b".repeat(64),"failures":[],"developmentCases":[]});

        let other_owner = format!("other-{}", uuid::Uuid::new_v4());
        let other_run = uuid::Uuid::new_v4().to_string();
        let other_name = format!("lumen-improvement-{other_run}");
        let mut other_guard = ContainerGuard {
            owner: other_owner.clone(),
            name: other_name.clone(),
            armed: true,
        };
        execute(
            &sandbox_args(&other_owner, &other_run, &manifest.image_id),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
        let inspected = execute(
            &["container".into(), "inspect".into(), other_name.clone()],
            Duration::from_secs(15),
        )
        .await
        .unwrap();
        let inspected: Value = serde_json::from_slice(&inspected).unwrap();
        let host = &inspected[0]["HostConfig"];
        assert_eq!(inspected[0]["Config"]["User"], "10001:10001");
        assert_eq!(host["ReadonlyRootfs"], true);
        assert_eq!(host["NetworkMode"], "none");
        assert_eq!(host["Privileged"], false);
        assert_eq!(host["Memory"], 2_147_483_648u64);
        assert_eq!(host["PidsLimit"], 128);
        assert_eq!(host["CapDrop"], json!(["ALL"]));
        assert!(host["Binds"].is_null() || host["Binds"] == json!([]));
        assert!(
            host["SecurityOpt"]
                .as_array()
                .unwrap()
                .contains(&json!("no-new-privileges=true"))
        );

        let requested = Arc::new(tokio::sync::Notify::new());
        let generated = runtime
            .run(
                input.clone(),
                CancellationToken::new(),
                Arc::new(Broker {
                    block: false,
                    requested: requested.clone(),
                }),
            )
            .await
            .unwrap();
        assert_eq!(generated.manifest["baseVersion"], 1);
        assert_eq!(generated.manifest["evidenceDigest"], "a".repeat(64));
        let cancel = CancellationToken::new();
        let run_runtime = runtime.clone();
        let run_cancel = cancel.clone();
        let cancel_requested = Arc::new(tokio::sync::Notify::new());
        let notify = cancel_requested.clone();
        let blocked = tokio::spawn(async move {
            run_runtime
                .run(
                    input,
                    run_cancel,
                    Arc::new(Broker {
                        block: true,
                        requested: notify,
                    }),
                )
                .await
        });
        let reached_prompt =
            tokio::time::timeout(Duration::from_secs(60), cancel_requested.notified())
                .await
                .is_ok();
        cancel.cancel();
        let outcome = tokio::time::timeout(Duration::from_secs(45), blocked)
            .await
            .unwrap()
            .unwrap();
        assert!(
            reached_prompt,
            "Cancellation acceptance requires a real Prime model request first"
        );
        assert_eq!(outcome.err().as_deref(), Some(CANCELLED));
        runtime.cleanup_owned().await.unwrap();
        let survived = execute(
            &["container".into(), "inspect".into(), other_name.clone()],
            Duration::from_secs(15),
        )
        .await
        .is_ok();
        remove_exact_owned(&other_owner, &other_name).await.unwrap();
        other_guard.armed = false;
        assert!(
            survived,
            "Cleanup must preserve another installation's container"
        );
        let owned = execute(
            &[
                "container".into(),
                "ls".into(),
                "--all".into(),
                "--quiet".into(),
                "--filter".into(),
                format!("label={OWNER_LABEL}={owner}"),
            ],
            Duration::from_secs(15),
        )
        .await
        .unwrap();
        assert!(
            std::str::from_utf8(&owned).unwrap().trim().is_empty(),
            "No generation/cancel container may survive"
        );
    }
}

use futures_util::{StreamExt, future::BoxFuture, stream::FuturesUnordered};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const FRAME_LIMIT: usize = 524_288;
const OUTPUT_LIMIT: usize = 2_097_152;
const REVISION: &str = "2ed835646120f79562407879ff19e8860623775c";
const VERSION: &str = "0.9.8";
const OWNER_LABEL: &str = "dev.lumen.improvement.owner";
const RUN_LABEL: &str = "dev.lumen.improvement.run";
const ERROR: &str = "The isolated improvement runtime is unavailable or failed validation.";
const CANCELLED: &str = "Improvement generation was cancelled.";
pub(crate) const CLEANUP_UNCERTAIN: &str = "The owned improvement container could not be removed. Retry runtime cleanup after Docker is available.";

pub struct DockerRuntime {
    owner_id: String,
    asset_directory: PathBuf,
}
pub struct RuntimeHealth {
    pub state: String,
    pub detail: Option<String>,
    pub prepared: bool,
}
pub trait ModelBroker: Send + Sync {
    fn request(
        &self,
        body: Value,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value, String>>;
}
pub struct SandboxResult {
    pub manifest: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageManifest {
    protocol: u32,
    prime_version: String,
    source_revision: String,
    image_id: String,
    archive_sha256: String,
    archive: String,
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn image_id(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(digest)
}

fn command() -> Command {
    #[cfg(windows)]
    let mut command = {
        let program_files =
            std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into());
        let mut command = Command::new(
            PathBuf::from(program_files).join("Docker/Docker/resources/bin/docker.exe"),
        );
        command.args(["--host", "npipe:////./pipe/dockerDesktopLinuxEngine"]);
        command.creation_flags(0x08000000);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("/usr/bin/docker");
        command.args(["--host", "unix:///var/run/docker.sock"]);
        command
    };
    command
        .env_remove("DOCKER_HOST")
        .env_remove("DOCKER_CONTEXT")
        .env_remove("DOCKER_TLS_VERIFY")
        .env_remove("DOCKER_CERT_PATH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn bounded_read<R: AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ERROR)?;
    if bytes.len() > limit {
        return Err(ERROR.into());
    }
    Ok(bytes)
}

async fn execute(args: &[String], deadline: Duration) -> Result<Vec<u8>, String> {
    tokio::time::timeout(deadline, async {
        let mut child = command().args(args).spawn().map_err(|_| ERROR)?;
        let mut stdout = child.stdout.take().ok_or(ERROR)?;
        let bytes = bounded_read(&mut stdout, 32_768).await?;
        if !child.wait().await.map_err(|_| ERROR)?.success() {
            return Err(ERROR.into());
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| ERROR.to_string())?
}

#[cfg(test)]
async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<(Value, usize), String> {
    let mut frame = Vec::new();
    read_frame_buffered(reader, &mut frame).await
}
async fn read_frame_buffered<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    frame: &mut Vec<u8>,
) -> Result<(Value, usize), String> {
    loop {
        let available = reader.fill_buf().await.map_err(|_| ERROR)?;
        if available.is_empty() {
            return Err(ERROR.into());
        }
        let end = available.iter().position(|b| *b == b'\n');
        let count = end.map_or(available.len(), |i| i + 1);
        if frame.len() + count > FRAME_LIMIT {
            return Err(ERROR.into());
        }
        frame.extend_from_slice(&available[..count]);
        reader.consume(count);
        if end.is_some() {
            // Deserialize to a strict frame below; duplicate keys cannot replace protocol fields.
            let result = strict_json(frame).map(|value| (value, frame.len()));
            frame.clear();
            return result;
        }
    }
}
async fn write_frame<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &[u8],
    cancel: &CancellationToken,
) -> Result<(), String> {
    tokio::select! {biased;_=cancel.cancelled()=>Err(CANCELLED.into()),result=tokio::time::timeout(Duration::from_secs(5),async{writer.write_all(frame).await.map_err(|_|ERROR)?;writer.write_all(b"\n").await.map_err(|_|ERROR)?;Ok::<(),String>(())})=>result.map_err(|_|ERROR.to_string())?}
}

fn strict_json(bytes: &[u8]) -> Result<Value, String> {
    struct StrictValue(Value);
    impl<'de> Deserialize<'de> for StrictValue {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = StrictValue;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("JSON value without duplicate keys")
                }
                fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
                    Ok(StrictValue(Value::Bool(v)))
                }
                fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                    Ok(StrictValue(v.into()))
                }
                fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                    Ok(StrictValue(v.into()))
                }
                fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                    serde_json::Number::from_f64(v)
                        .map(|n| StrictValue(Value::Number(n)))
                        .ok_or_else(|| E::custom("nonfinite"))
                }
                fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                    Ok(StrictValue(v.into()))
                }
                fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Self::Value, E> {
                    Ok(StrictValue(v.into()))
                }
                fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                    Ok(StrictValue(Value::Null))
                }
                fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                    Ok(StrictValue(Value::Null))
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(
                    self,
                    mut seq: A,
                ) -> Result<Self::Value, A::Error> {
                    let mut values = Vec::new();
                    while let Some(StrictValue(value)) = seq.next_element()? {
                        values.push(value);
                    }
                    Ok(StrictValue(Value::Array(values)))
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> Result<Self::Value, A::Error> {
                    let mut values = serde_json::Map::new();
                    while let Some((key, StrictValue(value))) =
                        map.next_entry::<String, StrictValue>()?
                    {
                        if values.insert(key, value).is_some() {
                            return Err(serde::de::Error::custom("duplicate key"));
                        }
                    }
                    Ok(StrictValue(Value::Object(values)))
                }
            }
            deserializer.deserialize_any(Visitor)
        }
    }
    serde_json::from_slice::<StrictValue>(bytes)
        .map(|v| v.0)
        .map_err(|_| ERROR.into())
}

fn exact_fields(value: &Value, names: &[&str]) -> bool {
    value.as_object().is_some_and(|obj| {
        obj.len() == names.len() && names.iter().all(|key| obj.contains_key(*key))
    })
}

fn validate_input(input: &Value) -> Result<(), String> {
    if !exact_fields(
        input,
        &[
            "activeVersion",
            "evidenceDigest",
            "configDigest",
            "failures",
            "developmentCases",
        ],
    ) || !input["evidenceDigest"].as_str().is_some_and(digest)
        || !input["configDigest"].as_str().is_some_and(digest)
        || input["activeVersion"]["id"].as_u64().is_none()
        || input["failures"]
            .as_array()
            .is_none_or(|items| items.len() > 32)
        || input["developmentCases"]
            .as_array()
            .is_none_or(|items| items.len() > 32)
        || serde_json::to_vec(input).map_err(|_| ERROR)?.len() > 131_072
    {
        return Err(ERROR.into());
    }
    let _: super::types::HarnessVersion =
        serde_json::from_value(input["activeVersion"].clone()).map_err(|_| ERROR)?;
    for failure in input["failures"].as_array().ok_or(ERROR)? {
        let trace: super::types::ExecutionTrace =
            serde_json::from_value(failure.clone()).map_err(|_| ERROR)?;
        trace.validate().map_err(|_| ERROR)?;
    }
    for case in input["developmentCases"].as_array().ok_or(ERROR)? {
        if !exact_fields(case, &["id", "prompt"])
            || case["id"]
                .as_str()
                .is_none_or(|id| !super::types::safe_id(id, 64))
            || case["prompt"]
                .as_str()
                .is_none_or(|prompt| prompt.is_empty() || prompt.len() > 8192)
        {
            return Err(ERROR.into());
        }
    }
    Ok(())
}

pub(crate) fn validate_model_body(body: &Value) -> Result<(), String> {
    let allowed = [
        "model",
        "messages",
        "stream",
        "tools",
        "tool_choice",
        "max_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "stream_options",
        "parallel_tool_calls",
    ];
    if body
        .as_object()
        .is_none_or(|obj| obj.keys().any(|key| !allowed.contains(&key.as_str())))
        || body["model"] != "lumen-host"
        || body["stream"] != false
        || body["messages"]
            .as_array()
            .is_none_or(|items| items.is_empty() || items.len() > 128)
        || serde_json::to_vec(body).map_err(|_| ERROR)?.len() > 262_144
    {
        return Err(ERROR.into());
    }
    for key in ["max_tokens", "max_completion_tokens"] {
        if body
            .get(key)
            .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0 || n > 4096))
        {
            return Err(ERROR.into());
        }
    }
    Ok(())
}

fn sandbox_args(owner: &str, run: &str, image: &str) -> Vec<String> {
    [
        "create",
        "--pull",
        "never",
        "--interactive",
        "--name",
        &format!("lumen-improvement-{run}"),
        "--label",
        &format!("{OWNER_LABEL}={owner}"),
        "--label",
        &format!("{RUN_LABEL}={run}"),
        "--label",
        "dev.lumen.improvement.runtime=1",
        "--user",
        "10001:10001",
        "--read-only",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--cpus",
        "2",
        "--memory",
        "2g",
        "--memory-swap",
        "2g",
        "--pids-limit",
        "128",
        "--ulimit",
        "nofile=256:256",
        "--log-driver",
        "none",
        "--tmpfs",
        "/scratch:rw,nosuid,nodev,noexec,size=268435456,uid=10001,gid=10001,mode=0700",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=67108864,uid=10001,gid=10001,mode=0700",
        image,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

async fn remove_exact_owned(owner: &str, name: &str) -> Result<(), String> {
    let inspected = execute(
        &["container".into(), "inspect".into(), name.into()],
        Duration::from_secs(10),
    )
    .await?;
    let value: Value = serde_json::from_slice(&inspected).map_err(|_| ERROR)?;
    let id = owned_container_id(owner, &value)?;
    execute(
        &["container".into(), "rm".into(), "--force".into(), id.into()],
        Duration::from_secs(15),
    )
    .await?;
    Ok(())
}

fn owned_container_id<'a>(owner: &str, value: &'a Value) -> Result<&'a str, String> {
    let labels = &value[0]["Config"]["Labels"];
    if labels[OWNER_LABEL] != owner
        || labels["dev.lumen.improvement.runtime"] != "1"
        || !labels[RUN_LABEL].as_str().is_some_and(safe_id)
    {
        return Err(ERROR.into());
    }
    let id = value[0]["Id"]
        .as_str()
        .filter(|id| digest(id))
        .ok_or(ERROR)?;
    Ok(id)
}

struct ContainerGuard {
    owner: String,
    name: String,
    armed: bool,
}
impl Drop for ContainerGuard {
    fn drop(&mut self) {
        if self.armed
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            let owner = self.owner.clone();
            let name = self.name.clone();
            handle.spawn(async move {
                let _ = remove_exact_owned(&owner, &name).await;
            });
        }
    }
}

impl DockerRuntime {
    pub fn new(owner_id: String, asset_directory: PathBuf) -> Self {
        Self {
            owner_id,
            asset_directory,
        }
    }

    async fn manifest(&self) -> Result<ImageManifest, String> {
        if !safe_id(&self.owner_id) {
            return Err(ERROR.into());
        }
        let path = self.asset_directory.join("improvement-runtime.json");
        let manifest: ImageManifest = tokio::task::spawn_blocking(move || {
            let bytes = std::fs::read(path).map_err(|_| ERROR)?;
            if bytes.len() > 4096 {
                return Err(ERROR);
            }
            serde_json::from_slice(&bytes).map_err(|_| ERROR)
        })
        .await
        .map_err(|_| ERROR)?
        .map_err(str::to_string)?;
        if manifest.protocol != 1
            || manifest.prime_version != VERSION
            || manifest.source_revision != REVISION
            || manifest.archive != "improvement-runtime.tar"
            || !digest(&manifest.archive_sha256)
            || !image_id(&manifest.image_id)
        {
            return Err(ERROR.into());
        }
        Ok(manifest)
    }

    async fn engine(&self) -> Result<(), String> {
        let bytes = execute(
            &[
                "version".into(),
                "--format".into(),
                "{{json .Server}}".into(),
            ],
            Duration::from_secs(15),
        )
        .await?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
        if value["Os"] != "linux" || value["Arch"] != "amd64" {
            return Err(ERROR.into());
        }
        let options = execute(
            &[
                "info".into(),
                "--format".into(),
                "{{json .SecurityOptions}}".into(),
            ],
            Duration::from_secs(15),
        )
        .await?;
        let options: Vec<String> = serde_json::from_slice(&options).map_err(|_| ERROR)?;
        if !options
            .iter()
            .any(|option| option == "name=seccomp,profile=builtin")
        {
            return Err(ERROR.into());
        }
        Ok(())
    }

    async fn installed(&self, manifest: &ImageManifest) -> Result<(), String> {
        let bytes = execute(
            &["image".into(), "inspect".into(), manifest.image_id.clone()],
            Duration::from_secs(15),
        )
        .await?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
        if value[0]["Id"] != manifest.image_id
            || value[0]["Os"] != "linux"
            || value[0]["Architecture"] != "amd64"
            || value[0]["Config"]["Labels"]["dev.lumen.improvement.protocol"] != "1"
            || value[0]["Config"]["Labels"]["dev.lumen.improvement.prime"] != VERSION
            || value[0]["Config"]["Labels"]["dev.lumen.improvement.revision"] != REVISION
        {
            return Err(ERROR.into());
        }
        Ok(())
    }

    async fn probe(&self, manifest: &ImageManifest) -> Result<(), String> {
        let run = uuid::Uuid::new_v4().to_string();
        let name = format!("lumen-improvement-{run}");
        let mut guard = ContainerGuard {
            owner: self.owner_id.clone(),
            name: name.clone(),
            armed: true,
        };
        let result = tokio::time::timeout(Duration::from_secs(35), async {
            let mut args = sandbox_args(&self.owner_id, &run, &manifest.image_id);
            args.push("--health".into());
            execute(&args, Duration::from_secs(15)).await?;
            let bytes = execute(
                &[
                    "container".into(),
                    "start".into(),
                    "--attach".into(),
                    name.clone(),
                ],
                Duration::from_secs(25),
            )
            .await?;
            let frame = strict_json(&bytes)?;
            if !exact_fields(&frame, &["v", "type", "primeVersion", "protocol"])
                || frame["v"] != 1
                || frame["type"] != "health"
                || frame["primeVersion"] != VERSION
                || frame["protocol"] != 1
            {
                return Err(ERROR.to_string());
            }
            Ok(())
        })
        .await
        .map_err(|_| ERROR.to_string())
        .and_then(|v| v);
        if remove_exact_owned(&self.owner_id, &name).await.is_ok() {
            guard.armed = false;
        } else {
            return Err(ERROR.into());
        }
        result
    }

    pub async fn health(&self) -> RuntimeHealth {
        if self.engine().await.is_err() {
            return RuntimeHealth { state: "unavailable".into(), detail: Some("Docker Desktop Linux engine is unavailable. Start Docker explicitly before preparing the runtime.".into()), prepared: false };
        }
        let Ok(manifest) = self.manifest().await else {
            return RuntimeHealth { state: "unavailable".into(), detail: Some("The pinned improvement image archive is not bundled or its manifest is invalid.".into()), prepared: false };
        };
        if self.installed(&manifest).await.is_err() {
            return RuntimeHealth {
                state: "unavailable".into(),
                detail: Some("The pinned improvement image requires explicit preparation.".into()),
                prepared: false,
            };
        }
        if self.probe(&manifest).await.is_err() {
            return RuntimeHealth {
                state: "unavailable".into(),
                detail: Some(
                    "The pinned Prime ACP runtime failed its isolated protocol check.".into(),
                ),
                prepared: false,
            };
        }
        RuntimeHealth {
            state: "ready".into(),
            detail: None,
            prepared: true,
        }
    }

    pub async fn prepare(&self) -> Result<RuntimeHealth, String> {
        self.engine().await?;
        let manifest = self.manifest().await?;
        let archive = self.asset_directory.join(&manifest.archive);
        let path = archive.clone();
        let expected = manifest.archive_sha256.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            use std::io::Read;
            let mut file = std::fs::File::open(path).map_err(|_| ERROR)?;
            if file.metadata().map_err(|_| ERROR)?.len() > 2_147_483_648 {
                return Err(ERROR.into());
            }
            let mut hasher = Sha256::new();
            let mut chunk = [0u8; 65_536];
            loop {
                let count = file.read(&mut chunk).map_err(|_| ERROR)?;
                if count == 0 {
                    break;
                }
                hasher.update(&chunk[..count]);
            }
            if hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                != expected
            {
                return Err(ERROR.into());
            }
            Ok(())
        })
        .await
        .map_err(|_| ERROR)??;
        execute(
            &[
                "image".into(),
                "load".into(),
                "--input".into(),
                archive.to_str().ok_or(ERROR)?.into(),
            ],
            Duration::from_secs(180),
        )
        .await?;
        self.installed(&manifest).await?;
        self.probe(&manifest).await?;
        Ok(RuntimeHealth {
            state: "ready".into(),
            detail: None,
            prepared: true,
        })
    }

    pub async fn cleanup_owned(&self) -> Result<(), String> {
        if !safe_id(&self.owner_id) {
            return Err(ERROR.into());
        }
        let bytes = execute(
            &[
                "container".into(),
                "ls".into(),
                "--all".into(),
                "--quiet".into(),
                "--no-trunc".into(),
                "--filter".into(),
                format!("label={OWNER_LABEL}={}", self.owner_id),
                "--filter".into(),
                "label=dev.lumen.improvement.runtime=1".into(),
            ],
            Duration::from_secs(15),
        )
        .await?;
        let text = std::str::from_utf8(&bytes).map_err(|_| ERROR)?;
        let ids: Vec<_> = text.lines().collect();
        if ids.len() > 32 || ids.iter().any(|id| !digest(id)) {
            return Err(ERROR.into());
        }
        for id in ids {
            remove_exact_owned(&self.owner_id, id).await?;
        }
        Ok(())
    }

    pub async fn run(
        &self,
        input: Value,
        cancel: CancellationToken,
        broker: Arc<dyn ModelBroker>,
    ) -> Result<SandboxResult, String> {
        validate_input(&input)?;
        if cancel.is_cancelled() {
            return Err(CANCELLED.into());
        }
        self.engine().await?;
        let manifest = self.manifest().await?;
        self.installed(&manifest).await?;
        let run = uuid::Uuid::new_v4().to_string();
        let name = format!("lumen-improvement-{run}");
        let mut guard = ContainerGuard {
            owner: self.owner_id.clone(),
            name: name.clone(),
            armed: true,
        };
        let local_cancel = cancel.child_token();
        let operation = async {
            let created = execute(
                &sandbox_args(&self.owner_id, &run, &manifest.image_id),
                Duration::from_secs(30),
            )
            .await?;
            if !digest(std::str::from_utf8(&created).map_err(|_| ERROR)?.trim()) {
                return Err(ERROR.into());
            }
            if local_cancel.is_cancelled() {
                return Err(CANCELLED.into());
            }
            let mut child = command()
                .args(["container", "start", "--attach", "--interactive", &name])
                .stdin(Stdio::piped())
                .spawn()
                .map_err(|_| ERROR)?;
            let mut stdin = child.stdin.take().ok_or(ERROR)?;
            let mut stdout = BufReader::new(child.stdout.take().ok_or(ERROR)?);
            let begin = serde_json::to_vec(&json!({"v":1,"type":"begin","input":input}))
                .map_err(|_| ERROR)?;
            write_frame(&mut stdin, &begin, &local_cancel).await?;
            let mut frame_buffer = Vec::new();
            let mut ready = false;
            let mut output = 0;
            let mut requests = 0;
            let mut seen = std::collections::HashSet::new();
            let mut pending: FuturesUnordered<BoxFuture<'static, (u64, Result<Value, String>)>> =
                FuturesUnordered::new();
            loop {
                tokio::select! {
                    biased;
                    _ = local_cancel.cancelled() => {
                        let _ = tokio::time::timeout(Duration::from_millis(200), stdin.write_all(b"{\"v\":1,\"type\":\"cancel\"}\n")).await;
                        return Err(CANCELLED.into());
                    }
                    Some((id, response)) = pending.next(), if !pending.is_empty() => {
                        let response = response.map_err(|_| ERROR)?;
                        let frame = serde_json::to_vec(&json!({"v":1,"type":"modelResponse","id":id,"ok":true,"body":response})).map_err(|_| ERROR)?;
                        if frame.len() > FRAME_LIMIT { return Err(ERROR.into()); }
                        write_frame(&mut stdin,&frame,&local_cancel).await?;
                    }
                    frame = read_frame_buffered(&mut stdout,&mut frame_buffer) => {
                        let (frame, frame_bytes) = frame?;
                        output += frame_bytes;
                        if output > OUTPUT_LIMIT || frame["v"] != 1 { return Err(ERROR.into()); }
                        match frame["type"].as_str() {
                            Some("ready") if !ready && exact_fields(&frame, &["v","type","primeVersion"]) && frame["primeVersion"] == VERSION => ready = true,
                            Some("modelRequest") if ready && exact_fields(&frame, &["v","type","id","body"]) => {
                                let id = frame["id"].as_u64().filter(|id| *id > 0).ok_or(ERROR)?;
                                requests += 1;
                                if requests > 60 || pending.len() >= 2 || !seen.insert(id) { return Err(ERROR.into()); }
                                validate_model_body(&frame["body"])?;
                                let body = frame["body"].clone(); let broker = broker.clone(); let token = local_cancel.clone();
                                pending.push(Box::pin(async move { (id, tokio::time::timeout(Duration::from_secs(120), broker.request(body, token)).await.unwrap_or_else(|_| Err(ERROR.into()))) }));
                            }
                            Some("result") if ready && requests > 0 && pending.is_empty() && exact_fields(&frame, &["v","type","manifest"]) => {
                                let parsed: super::types::CandidateManifest = serde_json::from_value(frame["manifest"].clone()).map_err(|_| ERROR)?;
                                parsed.validate().map_err(|_| ERROR)?;
                                if parsed.base_version != input["activeVersion"]["id"].as_u64().ok_or(ERROR)? || parsed.evidence_digest != input["evidenceDigest"].as_str().ok_or(ERROR)? { return Err(ERROR.into()); }
                                drop(stdin);
                                return Ok(SandboxResult { manifest: frame["manifest"].clone() });
                            }
                            _ => return Err(ERROR.into()),
                        }
                    }
                }
            }
        };
        let result = tokio::time::timeout(Duration::from_secs(600), operation)
            .await
            .unwrap_or_else(|_| Err("Improvement generation exceeded its deadline.".into()));
        local_cancel.cancel();
        let cleanup = remove_exact_owned(&self.owner_id, &name).await;
        if cleanup.is_ok() {
            guard.armed = false;
        }
        if cleanup.is_err() {
            return Err(CLEANUP_UNCERTAIN.into());
        }
        result
    }
}
