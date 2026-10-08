use futures_util::future::BoxFuture;
use lumen_improvement_runtime_tests::docker::{DockerRuntime, ModelBroker};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

struct SyntheticBroker;
impl ModelBroker for SyntheticBroker {
    fn request(
        &self,
        _body: Value,
        _cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value, String>> {
        Box::pin(async move {
            let candidate = json!({"baseVersion":1,"kind":"prompt","summary":"Make synthetic fixture answers concise.","evidenceDigest":"a".repeat(64),"answerInstructions":"Use concise cited answers.","computerUseInstructions":null,"toolHints":null,"preferences":[],"workflows":[]});
            Ok(
                json!({"id":"chatcmpl-acceptance","object":"chat.completion","model":"lumen-host","created":0,"choices":[{"index":0,"message":{"role":"assistant","content":candidate.to_string()},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":80,"total_tokens":180}}),
            )
        })
    }
}

#[tokio::main]
async fn main() {
    let assets = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("Pass the runtime asset directory");
    let runtime = DockerRuntime::new(format!("acceptance-{}", uuid::Uuid::new_v4()), assets);
    if std::env::args().any(|arg| arg == "--prepare")
        && let Err(detail) = runtime.prepare().await
    {
        println!(
            "{}",
            json!({"state":"unavailable","prepared":false,"detail":detail,"liveModel":false})
        );
        std::process::exit(2);
    }
    let health = runtime.health().await;
    println!(
        "{}",
        json!({"state":health.state,"prepared":health.prepared,"detail":health.detail,"liveModel":false})
    );
    if health.state != "ready" {
        std::process::exit(2);
    }
    let input = json!({"activeVersion":{"id":1,"parentId":null,"createdAt":0,"answerInstructions":"","computerUseInstructions":"","toolHints":"","preferences":[],"workflows":[]},"evidenceDigest":"a".repeat(64),"configDigest":"b".repeat(64),"failures":[],"developmentCases":[]});
    match runtime
        .run(input, CancellationToken::new(), Arc::new(SyntheticBroker))
        .await
    {
        Ok(result) => println!(
            "{}",
            json!({"state":"syntheticAcpCompleted","manifest":result.manifest,"liveModel":false})
        ),
        Err(detail) => {
            println!(
                "{}",
                json!({"state":"failed","detail":detail,"liveModel":false})
            );
            std::process::exit(1);
        }
    }
    runtime
        .cleanup_owned()
        .await
        .expect("Owned runtime cleanup must succeed");
}
