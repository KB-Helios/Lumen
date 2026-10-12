use serde::Deserialize;

use crate::gateway::{GatewaySupervisor, LocalRuntimeSupervisor, registry::ProviderRegistry};

use super::{IndexRuntime, index::EmbeddingJobRecord};

pub const EMBEDDING_MODEL: &str = "lumen.embed.local";
const MAX_BATCH_ITEMS: usize = 8;
const MAX_BATCH_CHARS: usize = 64 * 1024;
const MAX_DIMENSION: usize = 4_096;

pub fn active_model_key(registry: &ProviderRegistry) -> String {
    registry
        .routes()
        .into_iter()
        .find(|route| route.alias == EMBEDDING_MODEL)
        .map(|route| {
            format!(
                "{}:{}:{}",
                route.alias,
                route.model_id,
                route.upstream_model()
            )
        })
        .unwrap_or_else(|| EMBEDDING_MODEL.to_owned())
}

#[derive(Deserialize)]
struct EmbeddingDatum {
    index: usize,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingDatum>,
}

fn validate_embeddings(
    response: EmbeddingResponse,
    expected: usize,
) -> Result<Vec<Vec<f32>>, String> {
    if response.data.len() != expected {
        return Err("The embedding provider returned an incomplete batch.".to_owned());
    }
    let mut ordered = vec![None; expected];
    for item in response.data {
        if item.index >= expected || ordered[item.index].is_some() {
            return Err("The embedding provider returned invalid indexes.".to_owned());
        }
        if item.embedding.is_empty()
            || item.embedding.len() > MAX_DIMENSION
            || item.embedding.iter().any(|value| !value.is_finite())
        {
            return Err("The embedding provider returned an invalid vector.".to_owned());
        }
        ordered[item.index] = Some(item.embedding);
    }
    let vectors = ordered
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| "The embedding provider returned an incomplete batch.".to_owned())?;
    let dimension = vectors.first().map(Vec::len).unwrap_or(0);
    if vectors.iter().any(|vector| vector.len() != dimension) {
        return Err("The embedding provider returned inconsistent dimensions.".to_owned());
    }
    Ok(vectors)
}

async fn request_embeddings(
    gateway: &GatewaySupervisor,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if inputs.is_empty()
        || inputs.len() > MAX_BATCH_ITEMS
        || inputs
            .iter()
            .map(|input| input.chars().count())
            .sum::<usize>()
            > MAX_BATCH_CHARS
    {
        return Err("The embedding batch is outside Lumen's limits.".to_owned());
    }
    let (base_url, bearer) = gateway.endpoint(true);
    let response = crate::local_http::client(std::time::Duration::from_secs(20))
        .map_err(|_| "The embedding client is unavailable.".to_owned())?
        .post(format!("{base_url}/v1/embeddings"))
        .bearer_auth(bearer)
        .header("x-lumen-lane", "enrichment")
        .json(&serde_json::json!({"model": EMBEDDING_MODEL, "input": inputs}))
        .send()
        .await
        .map_err(|_| "The local embedding route is unavailable.".to_owned())?;
    if !response.status().is_success() {
        return Err("The local embedding route rejected the request.".to_owned());
    }
    let bytes = crate::local_http::body(response)
        .await
        .map_err(|_| "The local embedding response is invalid.".to_owned())?;
    let response = serde_json::from_slice::<EmbeddingResponse>(&bytes)
        .map_err(|_| "The local embedding response is invalid.".to_owned())?;
    validate_embeddings(response, inputs.len())
}

fn bounded_batch(jobs: Vec<EmbeddingJobRecord>) -> Vec<EmbeddingJobRecord> {
    let mut chars = 0_usize;
    jobs.into_iter()
        .take_while(|job| {
            let next = chars.saturating_add(job.text.chars().count());
            if next > MAX_BATCH_CHARS {
                false
            } else {
                chars = next;
                true
            }
        })
        .collect()
}

pub async fn process_pending(
    index: &IndexRuntime,
    gateway: &GatewaySupervisor,
    local_runtime: &LocalRuntimeSupervisor,
    model_key: &str,
) -> Result<usize, String> {
    index
        .queue_embedding_jobs(model_key)
        .map_err(|error| error.message)?;
    let jobs = bounded_batch(
        index
            .pending_embedding_jobs(model_key, MAX_BATCH_ITEMS)
            .map_err(|error| error.message)?,
    );
    if jobs.is_empty() {
        return Ok(0);
    }
    if let Err(error) = gateway.start() {
        for job in &jobs {
            let _ = index.defer_embedding_job(job, "local gateway unavailable");
        }
        return Err(error);
    }
    if let Err(error) = local_runtime.start() {
        for job in &jobs {
            let _ = index.defer_embedding_job(job, "local runtime unavailable");
        }
        return Err(error);
    }
    let inputs = jobs.iter().map(|job| job.text.clone()).collect::<Vec<_>>();
    let vectors = match request_embeddings(gateway, &inputs).await {
        Ok(vectors) => vectors,
        Err(error) => {
            for job in &jobs {
                let _ = index.defer_embedding_job(job, "local embedding route unavailable");
            }
            return Err(error);
        }
    };
    for (job, vector) in jobs.iter().zip(vectors) {
        index
            .complete_embedding_job(job, &vector)
            .map_err(|error| error.message)?;
    }
    Ok(jobs.len())
}

pub async fn embed_query(
    query: &str,
    gateway: &GatewaySupervisor,
    local_runtime: &LocalRuntimeSupervisor,
) -> Result<Vec<f32>, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 1_000 {
        return Err("The semantic query is outside Lumen's limits.".to_owned());
    }
    gateway.start()?;
    local_runtime.start()?;
    request_embeddings(gateway, &[query.to_owned()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "The local embedding response is empty.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_http_tests as http;
    use std::{net::TcpListener, path::PathBuf, time::Duration};

    fn local_request(reply: Vec<u8>) -> Result<Vec<Vec<f32>>, String> {
        let fixture = crate::search::test_support::SearchFixture::new("local-http-embedding");
        let gateway = GatewaySupervisor::new(PathBuf::from("unused"), fixture.root(), &[]).unwrap();
        let (base, _) = gateway.endpoint(true);
        let listener = TcpListener::bind(base.strip_prefix("http://").unwrap()).unwrap();
        let server = http::server_at(listener, reply, Duration::ZERO);
        let result = tauri::async_runtime::block_on(request_embeddings(
            &gateway,
            &["fixture-private".into()],
        ));
        server.join().unwrap();
        result
    }

    #[test]
    fn local_http_embedding_refuses_redirects() {
        let (target, server) = http::server(
            http::json(r#"{"data":[{"index":0,"embedding":[1.0]}]}"#),
            Duration::ZERO,
        );
        let result = local_request(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {target}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes());
        let redirected = server.join().unwrap();
        assert!(result.is_err());
        assert!(
            redirected.is_empty(),
            "no query text or bearer may reach redirect target"
        );
    }

    #[test]
    fn local_http_embedding_bounds_chunked_and_declared_bodies() {
        // A valid vector response with oversized harmless whitespace exposes unbounded decoding.
        let body = format!(
            r#"{{"data":[{{"index":0,"embedding":[1.0]}}]}}{}"#,
            " ".repeat(http::LIMIT)
        );
        let mut bounded = Vec::new();
        for chunked in [false, true] {
            let reply = if chunked {
                format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len()).into_bytes()
            } else {
                http::json(&body)
            };
            bounded.push(local_request(reply).is_err());
        }
        assert_eq!(bounded, [true, true]);
    }

    #[test]
    fn local_http_embedding_retains_twenty_second_body_deadline() {
        let fixture =
            crate::search::test_support::SearchFixture::new("local-http-embedding-deadline");
        let gateway = GatewaySupervisor::new(PathBuf::from("unused"), fixture.root(), &[]).unwrap();
        let (base, _) = gateway.endpoint(true);
        let listener = TcpListener::bind(base.strip_prefix("http://").unwrap()).unwrap();
        let body = r#"{"data":[{"index":0,"embedding":[1.0]}]}"#;
        let server = http::server_parts(
            listener,
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes(),
            body.as_bytes().to_vec(),
            Duration::from_secs(21),
        );
        let began = std::time::Instant::now();
        let result =
            tauri::async_runtime::block_on(request_embeddings(&gateway, &["fixture".into()]));
        let elapsed = began.elapsed();
        server.join().unwrap();
        assert!(result.is_err());
        assert!(elapsed >= Duration::from_secs(19));
        assert!(elapsed < Duration::from_secs(21));
    }

    #[test]
    #[ignore = "invoked only by isolated proxy regression"]
    fn local_http_proxy_probe_embedding() {
        assert_eq!(
            std::env::var("LUMEN_LOCAL_HTTP_PROXY_PROBE").as_deref(),
            Ok("1")
        );
        assert_eq!(
            local_request(http::json(r#"{"data":[{"index":0,"embedding":[1.0]}]}"#)).unwrap(),
            vec![vec![1.0]]
        );
    }

    #[test]
    fn vectors_are_finite_ordered_and_dimension_consistent() {
        let vectors = validate_embeddings(
            EmbeddingResponse {
                data: vec![
                    EmbeddingDatum {
                        index: 1,
                        embedding: vec![0.0, 1.0],
                    },
                    EmbeddingDatum {
                        index: 0,
                        embedding: vec![1.0, 0.0],
                    },
                ],
            },
            2,
        )
        .unwrap();
        assert_eq!(vectors[0], [1.0, 0.0]);
        assert!(
            validate_embeddings(
                EmbeddingResponse {
                    data: vec![EmbeddingDatum {
                        index: 0,
                        embedding: vec![f32::NAN]
                    },]
                },
                1
            )
            .is_err()
        );
        assert!(
            validate_embeddings(
                EmbeddingResponse {
                    data: vec![
                        EmbeddingDatum {
                            index: 0,
                            embedding: vec![1.0]
                        },
                        EmbeddingDatum {
                            index: 1,
                            embedding: vec![1.0, 2.0]
                        },
                    ]
                },
                2
            )
            .is_err()
        );
    }

    #[test]
    fn active_storage_key_tracks_the_validated_provider_route() {
        let registry = crate::gateway::registry::ProviderRegistry::in_memory();
        assert_eq!(
            active_model_key(&registry),
            "lumen.embed.local:local:nomic-embed-text-v1:extra.nomic-embed-text-v1.Q4_K_S.gguf"
        );
    }
}
