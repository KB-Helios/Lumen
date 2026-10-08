use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::{
    activity::{ActivityMode, ActivityRuntime, BackgroundPolicy},
    gateway::{
        GatewaySupervisor, LocalRuntimeSupervisor,
        mcp::{McpRuntime, ToolAccess},
        provisioning::ProvisioningManager,
        registry::ProviderRegistry,
    },
    window::ShortcutRegistration,
};

use super::extraction::extract_document;
use super::index::{
    DeletedIndexData, HistoryClearResult, HistoryStatus, IndexDatabase, IndexedDocument,
    IndexedHit, VectorStatus,
};
use super::index_worker;
use super::root_policy::canonicalize_root;
use super::traversal;
use super::types::{FileKind, FileRecord, SearchFailure};
use super::{embedding, ranking};

#[cfg(test)]
#[path = "freshness_tests.rs"]
mod freshness_tests;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRootRequest {
    pub path: String,
    #[serde(default)]
    pub cloud_enrichment: bool,
    #[serde(default)]
    pub exclusions: Vec<String>,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default = "default_max_file_size_mb")]
    pub max_file_size_mb: u64,
}

fn default_max_file_size_mb() -> u64 {
    256
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub phase: String,
    pub generation: u64,
    pub pending_items: u64,
    pub indexed_items: u64,
    pub queued_enrichment: u64,
    pub skipped_items: u64,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexDiagnostics {
    pub phase: String,
    pub schema_version: u32,
    pub indexed_files: u64,
    pub indexed_chunks: u64,
    pub history_entries: u64,
    pub history_enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTimingSample {
    pub name: &'static str,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogSample {
    pub component: &'static str,
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeActivityDiagnostics {
    pub mode: ActivityMode,
    pub background_policy: BackgroundPolicy,
    pub fullscreen: bool,
    pub on_battery: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGatewayDiagnostics {
    pub state: String,
    pub version: String,
    pub cloud_credential_configured: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMcpDiagnostics {
    pub services: u64,
    pub tools: u64,
    pub allowed: u64,
    pub ask: u64,
    pub denied: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeDiagnostics {
    pub state: String,
    pub profile: String,
    pub lemonade_version: Option<String>,
    pub required_lemonade_version: String,
    pub answer_model: String,
    pub embedding_model: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProvisioningDiagnostics {
    pub state: String,
    pub version: String,
    pub installed_version: Option<String>,
    pub progress: u8,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProviderDiagnostics {
    pub routes: u64,
    pub local_routes: u64,
    pub cloud_routes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnostics {
    pub app_version: &'static str,
    pub index: NativeIndexDiagnostics,
    pub vector: VectorStatus,
    pub activity: NativeActivityDiagnostics,
    pub gateway: NativeGatewayDiagnostics,
    pub mcp: NativeMcpDiagnostics,
    pub runtime: NativeRuntimeDiagnostics,
    pub provisioning: NativeProvisioningDiagnostics,
    pub providers: NativeProviderDiagnostics,
    pub shortcut: crate::window::ShortcutStatus,
    pub timings: Vec<NativeTimingSample>,
    pub logs: Vec<NativeLogSample>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridHit {
    #[serde(flatten)]
    pub hit: IndexedHit,
    pub metadata: FileRecord,
    pub match_source: String,
    pub semantic_score: Option<f64>,
    pub embedding_model: Option<String>,
    pub pinned: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SemanticPhase {
    Disabled,
    Ready,
    Degraded,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticRetrievalStatus {
    pub phase: SemanticPhase,
    pub reason: Option<String>,
}

impl SemanticRetrievalStatus {
    fn disabled() -> Self {
        Self {
            phase: SemanticPhase::Disabled,
            reason: None,
        }
    }

    fn degraded() -> Self {
        Self {
            phase: SemanticPhase::Degraded,
            reason: Some(
                "Semantic search unavailable; filename and content search remain available.".into(),
            ),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridSearchResponse {
    pub items: Vec<HybridHit>,
    pub semantic: SemanticRetrievalStatus,
}

impl HybridSearchResponse {
    fn lexical(items: Vec<HybridHit>) -> Self {
        Self {
            items,
            semantic: SemanticRetrievalStatus::disabled(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSearchStatus {
    pub vector_available: bool,
    pub semantic_available: bool,
    pub related_available: bool,
    pub indexed_chunks: u64,
    pub pending_jobs: u64,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchFilterRequest {
    pub id: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinUpdateResult {
    pub applied: bool,
    pub pinned: bool,
}

#[derive(Clone)]
pub struct IndexRuntime {
    database: Arc<IndexDatabase>,
    owned_database_path: Arc<PathBuf>,
    status: Arc<Mutex<IndexStatus>>,
    generation: Arc<AtomicU64>,
    synchronization: Arc<Mutex<()>>,
    pub(super) work: Arc<index_worker::WorkState>,
    worker: Option<Arc<index_worker::IndexWorker>>,
    embedding_worker_running: Arc<AtomicBool>,
    latest_search_request: Arc<AtomicU64>,
    #[cfg(test)]
    extraction_gate: Arc<Mutex<Option<ExtractionGate>>>,
    #[cfg(test)]
    commit_gate: Arc<Mutex<Option<ExtractionGate>>>,
}

#[cfg(test)]
type ExtractionGate = Arc<dyn Fn(&Path) + Send + Sync>;

fn search_failure(operation: &str, error: impl std::fmt::Display) -> SearchFailure {
    SearchFailure::new(
        "search-failed",
        format!("Could not {operation}: {error}"),
        None,
    )
}

fn stable_id(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let identity = format!(
        "{}\0{}",
        root.to_string_lossy().replace('\\', "/").to_lowercase(),
        relative.to_string_lossy().replace('\\', "/").to_lowercase(),
    );
    let digest = Sha256::digest(identity.as_bytes());
    let suffix = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("indexed:{suffix}")
}

impl IndexRuntime {
    pub fn open(
        path: &Path,
        vector_extension: &Path,
        history_enabled: bool,
    ) -> Result<Self, SearchFailure> {
        let database = IndexDatabase::open(path, vector_extension)
            .map_err(|error| search_failure("open the index", error))?;
        database.set_history_enabled(history_enabled);
        let (indexed_items, queued_enrichment) = database
            .counts()
            .map_err(|error| search_failure("read index status", error))?;
        let mut runtime = Self {
            database: Arc::new(database),
            owned_database_path: Arc::new(
                std::fs::canonicalize(path).map_err(|e| search_failure("locate owned index", e))?,
            ),
            status: Arc::new(Mutex::new(IndexStatus {
                phase: "ready".to_owned(),
                generation: 0,
                pending_items: 0,
                indexed_items,
                queued_enrichment,
                skipped_items: 0,
                message: "Local index ready".to_owned(),
            })),
            generation: Arc::new(AtomicU64::new(0)),
            synchronization: Arc::new(Mutex::new(())),
            work: Arc::new(index_worker::WorkState::default()),
            worker: None,
            embedding_worker_running: Arc::new(AtomicBool::new(false)),
            latest_search_request: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            extraction_gate: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            commit_gate: Arc::new(Mutex::new(None)),
        };
        runtime.worker = Some(index_worker::IndexWorker::start(runtime.clone()));
        Ok(runtime)
    }

    fn snapshot(&self) -> IndexStatus {
        self.status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn set_status(&self, status: IndexStatus) {
        *self
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = status;
    }

    pub(crate) fn answer_context(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<IndexedHit>, SearchFailure> {
        self.database
            .search(query, limit)
            .map_err(|error| search_failure("build answer context", error))
    }

    pub(crate) fn file_location(
        &self,
        stable_id: &str,
    ) -> Result<Option<(PathBuf, PathBuf)>, SearchFailure> {
        self.database
            .file_location(stable_id)
            .map_err(|error| search_failure("resolve an indexed file", error))
    }

    pub(crate) fn stable_id_for_path(&self, path: &Path) -> Result<Option<String>, SearchFailure> {
        self.database
            .stable_id_for_path(path)
            .map_err(|error| search_failure("resolve indexed file history", error))
    }

    pub(crate) fn pending_enrichment(
        &self,
    ) -> Result<Vec<super::EnrichmentJobRecord>, SearchFailure> {
        if !self.work.configured.load(Ordering::SeqCst) {
            return Ok(Vec::new());
        }
        let jobs = self
            .database
            .queued_jobs()
            .map_err(|error| search_failure("read enrichment jobs", error))?;
        let mut admitted = Vec::new();
        for job in jobs {
            if self.enrichment_dispatch_is_admitted(&job)? {
                admitted.push(job);
            }
        }
        Ok(admitted)
    }

    fn enrichment_dispatch_is_admitted(
        &self,
        job: &super::EnrichmentJobRecord,
    ) -> Result<bool, SearchFailure> {
        let _admission = self
            .synchronization
            .lock()
            .map_err(|e| search_failure("admit enrichment dispatch", e))?;
        if !self.work.configured.load(Ordering::SeqCst)
            || self.work.stop.load(Ordering::SeqCst)
            || !self
                .database
                .enrichment_job_is_queued(job)
                .map_err(|e| search_failure("validate queued enrichment", e))?
        {
            return Ok(false);
        }
        let Some((root_path, path)) = self
            .database
            .file_location(&job.file_id)
            .map_err(|e| search_failure("locate enrichment source", e))?
        else {
            return Ok(false);
        };
        let roots = self.work.roots.lock().unwrap_or_else(|e| e.into_inner());
        let Some(root) = roots
            .iter()
            .find(|root| root.cloud_enrichment && Path::new(&root.path) == root_path)
        else {
            return Ok(false);
        };
        Ok(
            traversal::policy_record(&root_path, &path, &Self::root_traversal_policy(root)?)?
                .is_some(),
        )
    }

    pub(crate) fn queue_embedding_jobs(&self, model: &str) -> Result<u64, SearchFailure> {
        self.database
            .queue_embedding_jobs(model)
            .map_err(|error| search_failure("queue embeddings", error))
    }

    pub(crate) fn pending_embedding_jobs(
        &self,
        model: &str,
        limit: usize,
    ) -> Result<Vec<super::index::EmbeddingJobRecord>, SearchFailure> {
        self.database
            .pending_embedding_jobs(model, limit)
            .map_err(|error| search_failure("read embedding jobs", error))
    }

    pub(crate) fn complete_embedding_job(
        &self,
        job: &super::index::EmbeddingJobRecord,
        values: &[f32],
    ) -> Result<bool, SearchFailure> {
        self.with_current_generation(self.current_generation(), || {
            self.database
                .complete_embedding_job(job, values)
                .map_err(|error| search_failure("store an embedding", error))
        })
        .map(|applied| applied.unwrap_or(false))
    }

    pub(crate) fn defer_embedding_job(
        &self,
        job: &super::index::EmbeddingJobRecord,
        error: &str,
    ) -> Result<(), SearchFailure> {
        self.database
            .defer_embedding_job(job, error)
            .map_err(|error| search_failure("defer an embedding", error))
    }

    #[cfg(test)]
    fn hybrid_search(
        &self,
        query: &str,
        query_vector: Option<&[f32]>,
        embedding_model: &str,
        limit: usize,
        weights: ranking::RankingWeights,
    ) -> Result<Vec<HybridHit>, SearchFailure> {
        self.hybrid_search_filtered(
            query,
            query_vector,
            embedding_model,
            limit,
            weights,
            "all",
            &[],
        )
        .map(|response| response.items)
    }

    #[allow(clippy::too_many_arguments)]
    fn hybrid_search_filtered(
        &self,
        query: &str,
        query_vector: Option<&[f32]>,
        embedding_model: &str,
        limit: usize,
        weights: ranking::RankingWeights,
        scope: &str,
        filters: &[SearchFilterRequest],
    ) -> Result<HybridSearchResponse, SearchFailure> {
        if limit == 0 {
            return Ok(HybridSearchResponse::lexical(Vec::new()));
        }
        // All filename and content candidates share stored metadata and one native ordering.
        // Apply policy filters before limiting candidates, including files with no text chunks.
        let mut inventory = self
            .database
            .inventory()
            .map_err(|error| search_failure("read filename inventory", error))?
            .into_iter()
            .filter(|item| {
                matches_metadata_scope(&item.metadata, scope)
                    && matches_metadata_filters(&item.metadata, filters)
            })
            .map(|item| (item.hit.stable_id.clone(), item))
            .collect::<HashMap<_, _>>();
        let lexical = self
            .database
            .search(query, 250_000)
            .map_err(|error| search_failure("search the local index", error))?;
        let (semantic, semantic_status) = match query_vector {
            Some(vector) => match self.database.search_embeddings(
                embedding_model,
                vector.len(),
                vector,
                250_000,
            ) {
                Ok(hits) => (
                    hits,
                    SemanticRetrievalStatus {
                        phase: SemanticPhase::Ready,
                        reason: None,
                    },
                ),
                Err(_) => (Vec::new(), SemanticRetrievalStatus::degraded()),
            },
            None => (Vec::new(), SemanticRetrievalStatus::disabled()),
        };
        let mut signals = HashMap::<String, (f64, Option<f64>)>::new();
        for hit in lexical {
            if let Some(item) = inventory.get_mut(&hit.stable_id) {
                signals
                    .entry(hit.stable_id.clone())
                    .or_insert((0.0, None))
                    .0 = 1.0 / (1.0 + hit.rank.abs());
                item.hit = hit;
            }
        }
        for hit in semantic {
            if inventory.contains_key(&hit.stable_id) {
                let score = (1.0 - hit.distance / 2.0).clamp(0.0, 1.0);
                let signal = signals.entry(hit.stable_id).or_insert((0.0, None));
                signal.1 = Some(signal.1.unwrap_or(0.0).max(score));
            }
        }
        let mut candidates = inventory
            .into_values()
            .filter_map(|item| {
                let filename = super::matching::filename_score(&item.hit.name, query);
                let (lexical, semantic) =
                    signals.remove(&item.hit.stable_id).unwrap_or((0.0, None));
                if filename.is_none() && lexical == 0.0 && semantic.is_none() {
                    return None;
                }
                let name = item.hit.name.clone();
                let recency = item.recency;
                let pinned = item.pinned;
                Some(ranking::RankingCandidate {
                    id: (item, semantic, filename.is_some()),
                    name,
                    lexical: lexical.max(filename.unwrap_or(0.0)),
                    semantic,
                    recency,
                    pinned,
                })
            })
            .collect::<Vec<_>>();
        // Stable input also gives equal-score results deterministic path ordering.
        candidates.sort_by(|left, right| left.id.0.hit.path.cmp(&right.id.0.hit.path));
        let items = ranking::rank_candidates(query, candidates, weights)
            .into_iter()
            .take(limit)
            .map(|ranked| {
                let (mut item, semantic, filename) = ranked.candidate.id;
                item.hit.rank = 1.0 - ranked.score;
                HybridHit {
                    hit: item.hit,
                    metadata: item.metadata,
                    match_source: if filename {
                        "filename"
                    } else if semantic.is_some() {
                        "semantic"
                    } else {
                        "content"
                    }
                    .into(),
                    semantic_score: semantic,
                    embedding_model: semantic.map(|_| embedding_model.to_owned()),
                    pinned: item.pinned,
                }
            })
            .collect();
        Ok(HybridSearchResponse {
            items,
            semantic: semantic_status,
        })
    }

    #[cfg(test)]
    fn related_search(
        &self,
        source_id: &str,
        query_vector: &[f32],
        embedding_model: &str,
        limit: usize,
    ) -> Result<Vec<HybridHit>, SearchFailure> {
        self.related_search_filtered(source_id, query_vector, embedding_model, limit, &[])
    }

    fn related_search_filtered(
        &self,
        source_id: &str,
        query_vector: &[f32],
        embedding_model: &str,
        limit: usize,
        filters: &[SearchFilterRequest],
    ) -> Result<Vec<HybridHit>, SearchFailure> {
        let semantic = self
            .database
            .search_embeddings(embedding_model, query_vector.len(), query_vector, 250_000)
            .map_err(|error| search_failure("search related files", error))?;
        let mut candidates = HashMap::<String, f64>::new();
        for hit in semantic {
            if hit.stable_id != source_id {
                let score = (1.0 - hit.distance / 2.0).clamp(0.0, 1.0);
                candidates
                    .entry(hit.stable_id)
                    .and_modify(|current| *current = current.max(score))
                    .or_insert(score);
            }
        }
        let mut related = Vec::new();
        for item in self
            .database
            .inventory()
            .map_err(|error| search_failure("read related metadata", error))?
        {
            if let Some(score) = candidates.get(&item.hit.stable_id) {
                if !matches_metadata_filters(&item.metadata, filters) {
                    continue;
                }
                let mut hit = item.hit;
                hit.rank = 1.0 - score;
                related.push(HybridHit {
                    hit,
                    metadata: item.metadata,
                    match_source: "related".into(),
                    semantic_score: Some(*score),
                    embedding_model: Some(embedding_model.into()),
                    pinned: item.pinned,
                });
            }
        }
        related.sort_by(|left, right| {
            left.hit
                .rank
                .total_cmp(&right.hit.rank)
                .then_with(|| left.hit.path.cmp(&right.hit.path))
        });
        related.truncate(limit);
        Ok(related)
    }

    fn recent_search_filtered(
        &self,
        query: &str,
        limit: usize,
        filters: &[SearchFilterRequest],
    ) -> Result<Vec<HybridHit>, SearchFailure> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut hits = Vec::new();
        for mut hit in self
            .database
            .recent_hits(query, 250_000)
            .map_err(|error| search_failure("search recent files", error))?
        {
            let metadata = self
                .database
                .inventory_record(&hit.stable_id)
                .map_err(|error| search_failure("read recent metadata", error))?;
            let Some(metadata) = metadata else {
                continue;
            };
            if !matches_metadata_filters(&metadata, filters) {
                continue;
            }
            let (_, pinned) = self
                .database
                .ranking_signals(&hit.stable_id)
                .map_err(|error| search_failure("read recent ranking", error))?;
            hit.rank = 1.0 - 1.0 / (1.0 + hits.len() as f64);
            hits.push(HybridHit {
                hit,
                metadata,
                match_source: "metadata".into(),
                semantic_score: None,
                embedding_model: None,
                pinned,
            });
            if hits.len() == limit {
                break;
            }
        }
        Ok(hits)
    }

    fn semantic_status(
        &self,
        embedding_model: &str,
    ) -> Result<SemanticSearchStatus, SearchFailure> {
        let vector = self.database.vector_status();
        let (indexed_chunks, pending_jobs, last_error) = self
            .database
            .embedding_status(embedding_model)
            .map_err(|error| search_failure("read semantic search status", error))?;
        let reason = if !vector.available {
            Some("The verified SQLite vector runtime is unavailable.".to_owned())
        } else if indexed_chunks > 0 {
            None
        } else if last_error.is_some() {
            Some(
                "The local embedding runtime is not ready; exact search remains available."
                    .to_owned(),
            )
        } else if pending_jobs > 0 {
            Some("Local embeddings are queued; exact search remains available.".to_owned())
        } else {
            Some("Index local text to prepare semantic and Related search.".to_owned())
        };
        Ok(SemanticSearchStatus {
            vector_available: vector.available,
            semantic_available: vector.available && indexed_chunks > 0,
            related_available: vector.available && indexed_chunks > 1,
            indexed_chunks,
            pending_jobs,
            reason,
        })
    }

    fn set_pinned(&self, stable_id: &str, pinned: bool) -> Result<bool, SearchFailure> {
        self.database
            .set_pinned(stable_id, pinned)
            .map_err(|error| search_failure("update the pin", error))
    }

    pub(crate) fn record_file_open(&self, stable_id: &str) -> Result<bool, SearchFailure> {
        self.database
            .record_file_open(stable_id)
            .map_err(|error| search_failure("record recent file history", error))
    }

    fn source_text(&self, stable_id: &str) -> Result<Option<String>, SearchFailure> {
        self.database
            .source_text(stable_id)
            .map_err(|error| search_failure("prepare related search", error))
    }

    pub(crate) fn start_index_lifecycle(&self, app: AppHandle) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            while !runtime.work.stop.load(Ordering::SeqCst) {
                let enabled = app.state::<ActivityRuntime>().snapshot().background_policy
                    == BackgroundPolicy::Normal;
                runtime.set_content_enabled(enabled);
                if enabled && runtime.work.configured.load(Ordering::SeqCst) {
                    let model =
                        embedding::active_model_key(app.state::<ProviderRegistry>().inner());
                    if runtime.queue_embedding_jobs(&model).is_ok() {
                        schedule_embedding_worker(app.clone(), runtime.clone());
                    }
                    if let Ok(jobs) = runtime.pending_enrichment() {
                        for job in jobs {
                            // Earlier submissions may await HTTP; revalidate each remaining job's
                            // current grant and queued hash immediately before its own dispatch.
                            if runtime
                                .enrichment_dispatch_is_admitted(&job)
                                .unwrap_or(false)
                            {
                                app.state::<crate::gateway::EnrichmentSupervisor>()
                                    .sync_jobs(std::slice::from_ref(&job))
                                    .await;
                            }
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    }

    fn begin_embedding_worker(&self) -> bool {
        self.embedding_worker_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn finish_embedding_worker(&self) {
        self.embedding_worker_running.store(false, Ordering::SeqCst);
    }

    fn begin_search(&self, request_id: u64) {
        self.latest_search_request
            .fetch_max(request_id, Ordering::SeqCst);
    }

    fn search_is_current(&self, request_id: u64) -> bool {
        self.latest_search_request.load(Ordering::SeqCst) == request_id
    }

    fn record_user_query(&self, query: &str, successful: bool) -> Result<(), SearchFailure> {
        self.database
            .record_user_query(query, successful)
            .map_err(|error| search_failure("record search history", error))
    }

    fn set_history_enabled(&self, enabled: bool) {
        self.database.set_history_enabled(enabled);
    }

    fn history_status(&self) -> Result<HistoryStatus, SearchFailure> {
        self.database
            .history_status()
            .map_err(|error| search_failure("read search history status", error))
    }

    fn clear_history(&self) -> Result<HistoryClearResult, SearchFailure> {
        self.database
            .clear_history()
            .map_err(|error| search_failure("clear search history", error))
    }

    fn native_index_diagnostics(
        &self,
    ) -> Result<(NativeIndexDiagnostics, VectorStatus), SearchFailure> {
        let (indexed_files, indexed_chunks) = self
            .database
            .operational_counts()
            .map_err(|error| search_failure("read index diagnostics", error))?;
        let history = self.history_status()?;
        let status = self.snapshot();
        let schema_version = self
            .database
            .schema_version()
            .map_err(|error| search_failure("read index schema version", error))?;
        Ok((
            NativeIndexDiagnostics {
                phase: status.phase,
                schema_version,
                indexed_files,
                indexed_chunks,
                history_entries: history.entry_count,
                history_enabled: history.enabled,
            },
            self.database.vector_status(),
        ))
    }

    fn delete_indexed_content(&self) -> Result<DeletedIndexData, SearchFailure> {
        let _synchronization = self
            .synchronization
            .lock()
            .map_err(|error| search_failure("lock the indexing worker", error))?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.work
            .roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.work
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.work
            .completed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.work.reconcile.store(true, Ordering::SeqCst);
        if let Some(worker) = &self.worker {
            worker.wake();
        }
        let deleted = self
            .database
            .delete_indexed_content()
            .map_err(|error| search_failure("delete generated index data", error))?;
        self.set_status(IndexStatus {
            phase: "ready".to_owned(),
            generation: self.generation.load(Ordering::SeqCst),
            pending_items: 0,
            indexed_items: 0,
            queued_enrichment: 0,
            skipped_items: 0,
            message: "Local index data deleted; source files were not changed".to_owned(),
        });
        Ok(deleted)
    }

    pub(crate) fn configure_roots(
        &self,
        roots: Vec<IndexRootRequest>,
        content_enabled: bool,
    ) -> Result<IndexStatus, SearchFailure> {
        let mut canonical = Vec::with_capacity(roots.len());
        let mut policies = HashMap::new();
        for mut root in roots {
            root.path = canonicalize_root(Path::new(&root.path))?
                .to_string_lossy()
                .into_owned();
            policies.insert(root.path.clone(), Self::root_traversal_policy(&root)?);
            canonical.push(root);
        }
        let _commit = self
            .synchronization
            .lock()
            .map_err(|e| search_failure("admit roots", e))?;
        let mut configured = self.work.roots.lock().unwrap_or_else(|e| e.into_inner());
        if !self.work.configured.load(Ordering::SeqCst) || *configured != canonical {
            self.work.configured.store(false, Ordering::SeqCst);
            self.generation.fetch_add(1, Ordering::SeqCst);
            *configured = canonical;
            self.work
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
            self.work
                .completed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
            let inventory = self
                .database
                .inventory()
                .map_err(|e| search_failure("read root inventory", e))?;
            let mut retained = HashMap::<String, HashSet<String>>::new();
            for item in inventory {
                if policies
                    .get(item.hit.root_path.to_string_lossy().as_ref())
                    .is_some_and(|policy| traversal::record_matches_policy(&item.metadata, policy))
                {
                    retained
                        .entry(item.hit.root_path.to_string_lossy().into_owned())
                        .or_default()
                        .insert(item.hit.stable_id);
                }
            }
            self.database
                .retain_inventory(&retained)
                .map_err(|e| search_failure("prune revoked roots", e))?;
            let cloud_roots = configured
                .iter()
                .filter(|root| root.cloud_enrichment)
                .map(|root| root.path.clone())
                .collect::<HashSet<_>>();
            self.database
                .retain_enrichment_roots(&cloud_roots)
                .map_err(|e| search_failure("invalidate revoked cloud jobs", e))?;
            self.work.reconcile.store(true, Ordering::SeqCst);
            self.work.configured.store(true, Ordering::SeqCst);
        }
        drop(configured);
        self.work
            .content_enabled
            .store(content_enabled, Ordering::SeqCst);
        self.refresh_worker_status()?;
        if let Some(worker) = &self.worker {
            worker.wake();
        }
        Ok(self.snapshot())
    }

    pub(crate) fn set_content_enabled(&self, enabled: bool) {
        self.work.content_enabled.store(enabled, Ordering::SeqCst);
        let _ = self.refresh_worker_status();
        if let Some(worker) = &self.worker {
            worker.wake();
        }
    }

    pub(crate) fn stop_index_worker(&self) {
        let _commit = self
            .synchronization
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(worker) = &self.worker {
            worker.stop();
        }
    }

    /// Capture before asynchronous enrichment. Admit its returned result under
    /// `with_current_generation`, then check its current file hash and root grant.
    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// The operation must be a short synchronous database commit, never provider I/O.
    pub fn with_current_generation<T>(
        &self,
        generation: u64,
        operation: impl FnOnce() -> Result<T, SearchFailure>,
    ) -> Result<Option<T>, SearchFailure> {
        let _commit = self
            .synchronization
            .lock()
            .map_err(|e| search_failure("admit current index generation", e))?;
        if self.current_generation() != generation || self.work.stop.load(Ordering::SeqCst) {
            return Ok(None);
        }
        operation().map(Some)
    }

    fn root_traversal_policy(
        root: &IndexRootRequest,
    ) -> Result<traversal::TraversalPolicy, SearchFailure> {
        let maximum = root
            .max_file_size_mb
            .checked_mul(1024 * 1024)
            .ok_or_else(|| search_failure("admit root policy", "invalid file size"))?;
        traversal::TraversalPolicy::new(root.exclusions.clone(), root.include_hidden, maximum)
    }

    pub(super) fn worker_failed(&self, _detail: &str) {
        let mut status = self.snapshot();
        status.phase = "degraded".into();
        status.message =
            "Some local indexing work could not finish; pending content will retry.".into();
        status.skipped_items = status.skipped_items.saturating_add(1);
        self.set_status(status);
    }

    fn refresh_worker_status(&self) -> Result<(), SearchFailure> {
        let (indexed_items, queued_enrichment) = self
            .database
            .counts()
            .map_err(|e| search_failure("read index status", e))?;
        let pending = self.work.pending.lock().unwrap_or_else(|e| e.into_inner());
        let pending_items = pending.len() as u64;
        let retries = pending
            .values()
            .filter(|item| item.retry_at > Instant::now())
            .count() as u64;
        drop(pending);
        let indexing = self.work.inventory_running.load(Ordering::SeqCst)
            || self.work.reconcile.load(Ordering::SeqCst);
        let paused = !self.work.content_enabled.load(Ordering::SeqCst) && pending_items > 0;
        let degraded = self.work.watcher_degraded.load(Ordering::SeqCst);
        let inventory_failed = self.work.inventory_failed.load(Ordering::SeqCst);
        self.set_status(IndexStatus {
            phase: if paused {
                "paused"
            } else if retries > 0 || inventory_failed {
                "degraded"
            } else if indexing || pending_items > 0 {
                "indexing"
            } else if degraded {
                "degraded"
            } else {
                "ready"
            }
            .into(),
            generation: self.generation.load(Ordering::SeqCst),
            pending_items,
            indexed_items,
            queued_enrichment,
            skipped_items: retries,
            message: if paused {
                "Content indexing paused; filenames remain searchable"
            } else if retries > 0 {
                "Some content could not be extracted; pending work will retry"
            } else if inventory_failed {
                "Local inventory reconciliation could not finish; bounded retry remains active"
            } else if indexing || pending_items > 0 {
                "Updating local inventory and pending content"
            } else if degraded {
                "File watching unavailable; bounded reconciliation remains active"
            } else {
                "Local index ready"
            }
            .into(),
        });
        Ok(())
    }

    fn inventory_record(
        &self,
        root: &IndexRootRequest,
        record: &FileRecord,
        generation: u64,
        force_content: bool,
    ) -> Result<(), SearchFailure> {
        let path = PathBuf::from(&record.path);
        if self.is_owned_index_path(&path) {
            return Ok(());
        }
        let root_path = PathBuf::from(&root.path);
        let id = stable_id(&root_path, &path);
        let signature = format!("{}:{}", record.size_bytes, record.modified_ms.unwrap_or(0));
        let _commit = self
            .synchronization
            .lock()
            .map_err(|e| search_failure("commit inventory", e))?;
        if self.generation.load(Ordering::SeqCst) != generation
            || self.work.stop.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        // Revalidate policy and symlink ancestors at the commit boundary.
        if traversal::policy_record(&root_path, &path, &Self::root_traversal_policy(root)?)?
            .is_none()
        {
            return Ok(());
        }
        self.database
            .upsert_metadata(&root_path, &id, &path, &signature)
            .map_err(|e| search_failure("update inventory", e))?;
        if force_content && record.kind != FileKind::Folder {
            self.work
                .completed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            self.database
                .upsert_document(
                    &root_path,
                    &IndexedDocument {
                        stable_id: id.clone(),
                        path: path.clone(),
                        content_hash: signature.clone(),
                        extraction_version: "metadata-v1".into(),
                        chunks: Vec::new(),
                    },
                )
                .map_err(|e| search_failure("invalidate dirty content", e))?;
        }
        if record.kind != FileKind::Folder
            && self
                .work
                .completed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&id)
                != Some(&signature)
        {
            let mut pending = self.work.pending.lock().unwrap_or_else(|e| e.into_inner());
            if force_content
                || !pending.get(&id).is_some_and(|item| {
                    item.signature == signature && item.generation == generation
                })
            {
                pending.insert(
                    id,
                    index_worker::PendingContent {
                        root: root_path,
                        path,
                        signature,
                        generation,
                        admission: self.work.next_admission.fetch_add(1, Ordering::SeqCst),
                        cloud_enrichment: root.cloud_enrichment,
                        retry_at: Instant::now(),
                    },
                );
            }
        }
        Ok(())
    }

    pub(super) fn reconcile_inventory(&self, force_content: bool) -> Result<(), SearchFailure> {
        let generation = self.generation.load(Ordering::SeqCst);
        let roots = self
            .work
            .roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let mut inventory = HashMap::<String, HashSet<String>>::new();
        let mut truncated = false;
        for root in roots {
            if self.generation.load(Ordering::SeqCst) != generation {
                return Ok(());
            }
            let root_path = PathBuf::from(&root.path);
            if !traversal::admitted_root_is_current(&root_path) {
                inventory.entry(root.path.clone()).or_default();
                truncated = true;
                continue;
            }
            let outcome = traversal::traverse_with_policy_until(
                &root_path,
                &Self::root_traversal_policy(&root)?,
                || {
                    self.generation.load(Ordering::SeqCst) != generation
                        || self.work.stop.load(Ordering::SeqCst)
                },
            )?;
            truncated |= outcome.truncated || !outcome.warnings.is_empty();
            let observed = inventory.entry(root.path.clone()).or_default();
            for record in outcome.records {
                if self.is_owned_index_path(Path::new(&record.path)) {
                    continue;
                }
                if self.generation.load(Ordering::SeqCst) != generation
                    || self.work.stop.load(Ordering::SeqCst)
                {
                    return Ok(());
                }
                observed.insert(stable_id(&root_path, Path::new(&record.path)));
                self.inventory_record(&root, &record, generation, force_content)?;
            }
        }
        let _commit = self
            .synchronization
            .lock()
            .map_err(|e| search_failure("reconcile inventory", e))?;
        if self.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        self.database
            .retain_inventory(&inventory)
            .map_err(|e| search_failure("remove stale inventory", e))?;
        let current = inventory.values().flatten().collect::<HashSet<_>>();
        self.work
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|id, _| current.contains(id));
        self.work
            .completed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|id, _| current.contains(id));
        if truncated {
            self.work.watcher_degraded.store(true, Ordering::SeqCst);
        }
        self.work.inventory_running.store(false, Ordering::SeqCst);
        self.work.inventory_failed.store(false, Ordering::SeqCst);
        self.refresh_worker_status()
    }

    pub(super) fn refresh_paths(&self, paths: Vec<PathBuf>) -> Result<(), SearchFailure> {
        let generation = self.generation.load(Ordering::SeqCst);
        let roots = self
            .work
            .roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for event in paths {
            for root in &roots {
                let root_path = PathBuf::from(&root.path);
                let Some(path) = index_worker::event_path(&root_path, &event) else {
                    continue;
                };
                if self.is_owned_index_path(&path) {
                    continue;
                }
                if path == root_path || path.is_dir() {
                    return self.reconcile_inventory(true);
                }
                if let Some(record) = traversal::policy_record(
                    &root_path,
                    &path,
                    &Self::root_traversal_policy(root)?,
                )? {
                    self.inventory_record(root, &record, generation, true)?;
                } else {
                    let _commit = self
                        .synchronization
                        .lock()
                        .map_err(|e| search_failure("remove changed inventory", e))?;
                    if self.generation.load(Ordering::SeqCst) != generation {
                        return Ok(());
                    }
                    let removed = self
                        .database
                        .remove_inventory_path(&root_path, &path)
                        .map_err(|e| search_failure("remove changed inventory", e))?;
                    self.work
                        .pending
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .retain(|_, pending| {
                            pending.root != root_path || !pending.path.starts_with(&path)
                        });
                    let mut completed = self
                        .work
                        .completed
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    for id in removed {
                        completed.remove(&id);
                    }
                }
            }
        }
        self.work.inventory_running.store(false, Ordering::SeqCst);
        self.refresh_worker_status()
    }

    fn is_owned_index_path(&self, path: &Path) -> bool {
        let owned = self.owned_database_path.to_string_lossy().to_lowercase();
        let path = path.to_string_lossy().to_lowercase();
        path == owned
            || path == format!("{owned}-wal")
            || path == format!("{owned}-shm")
            || path == format!("{owned}-journal")
    }

    pub(super) fn extract_pending(&self) -> Result<(), SearchFailure> {
        let next = self
            .work
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, item)| item.retry_at <= Instant::now())
            .min_by(|a, b| a.1.path.cmp(&b.1.path))
            .map(|(id, item)| (id.clone(), item.clone()));
        let Some((id, pending)) = next else {
            return Ok(());
        };
        {
            let _admission = self
                .synchronization
                .lock()
                .map_err(|e| search_failure("admit pending extraction", e))?;
            if self.current_generation() != pending.generation
                || !self.work.content_enabled.load(Ordering::SeqCst)
                || self.work.stop.load(Ordering::SeqCst)
            {
                return Ok(());
            }
            let roots = self.work.roots.lock().unwrap_or_else(|e| e.into_inner());
            let Some(root) = roots
                .iter()
                .find(|root| Path::new(&root.path) == pending.root)
            else {
                return Ok(());
            };
            if traversal::policy_record(
                &pending.root,
                &pending.path,
                &Self::root_traversal_policy(root)?,
            )?
            .is_none()
            {
                self.work
                    .pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                return Ok(());
            }
        }
        #[cfg(test)]
        let gate = self.extraction_gate.lock().unwrap().clone();
        #[cfg(test)]
        if let Some(gate) = gate {
            gate(&pending.path);
        }
        let extracted = extract_document(&pending.path);
        #[cfg(test)]
        let gate = self.commit_gate.lock().unwrap().clone();
        #[cfg(test)]
        if let Some(gate) = gate {
            gate(&pending.path);
        }
        let _commit = self
            .synchronization
            .lock()
            .map_err(|e| search_failure("commit content", e))?;
        if self.generation.load(Ordering::SeqCst) != pending.generation
            || !self.work.content_enabled.load(Ordering::SeqCst)
            || self.work.stop.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        let roots = self.work.roots.lock().unwrap_or_else(|e| e.into_inner());
        let Some(root) = roots
            .iter()
            .find(|root| Path::new(&root.path) == pending.root)
        else {
            return Ok(());
        };
        let Some(record) = traversal::policy_record(
            &pending.root,
            &pending.path,
            &Self::root_traversal_policy(root)?,
        )?
        else {
            return Ok(());
        };
        let signature = format!("{}:{}", record.size_bytes, record.modified_ms.unwrap_or(0));
        if signature != pending.signature {
            self.work.reconcile.store(true, Ordering::SeqCst);
            return Ok(());
        }
        let mut jobs = self.work.pending.lock().unwrap_or_else(|e| e.into_inner());
        if !jobs.get(&id).is_some_and(|item| {
            item.generation == pending.generation
                && item.signature == pending.signature
                && item.admission == pending.admission
        }) {
            return Ok(());
        }
        let extracted = match extracted {
            Ok(extracted) => extracted,
            Err(_) => {
                if let Some(job) = jobs.get_mut(&id) {
                    job.retry_at = Instant::now() + std::time::Duration::from_secs(5);
                }
                drop(jobs);
                drop(roots);
                self.worker_failed("extraction failed");
                return Ok(());
            }
        };
        let document = IndexedDocument {
            stable_id: id.clone(),
            path: pending.path,
            content_hash: extracted.content_hash,
            extraction_version: extracted.extraction_version,
            chunks: extracted.chunks,
        };
        self.database
            .upsert_document(&pending.root, &document)
            .map_err(|e| search_failure("store content", e))?;
        if pending.cloud_enrichment
            && let Some(kind) = extracted.pending_enrichment
        {
            self.database
                .enqueue_enrichment(
                    &id,
                    &kind,
                    if kind == "ocr" {
                        "lumen.vision.cloud"
                    } else {
                        "lumen.audio.cloud"
                    },
                )
                .map_err(|e| search_failure("queue enrichment", e))?;
        }
        self.work
            .completed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), signature);
        jobs.remove(&id);
        drop(jobs);
        drop(roots);
        self.refresh_worker_status()
    }

    #[cfg(test)]
    fn synchronize_with_content(
        &self,
        roots: Vec<IndexRootRequest>,
        content_enabled: bool,
    ) -> Result<IndexStatus, SearchFailure> {
        self.configure_roots(roots, content_enabled)?;
        let deadline = Instant::now() + std::time::Duration::from_secs(30);
        while Instant::now() < deadline {
            let status = self.snapshot();
            if matches!(status.phase.as_str(), "ready" | "degraded" | "paused")
                && !self.work.inventory_running.load(Ordering::SeqCst)
                && !self.work.reconcile.load(Ordering::SeqCst)
            {
                return Ok(status);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Err(search_failure("finish test indexing", "timed out"))
    }

    #[cfg(test)]
    pub(crate) fn synchronize_for_test(
        &self,
        roots: Vec<IndexRootRequest>,
    ) -> Result<IndexStatus, SearchFailure> {
        self.synchronize_with_content(roots, true)
    }
}

pub(super) fn matches_metadata_scope(metadata: &FileRecord, scope: &str) -> bool {
    match scope {
        "all" | "recent" | "related" => true,
        "files" => metadata.kind != FileKind::Folder,
        "folders" => metadata.kind == FileKind::Folder,
        "documents" => matches!(
            metadata.kind,
            FileKind::Pdf | FileKind::Document | FileKind::Spreadsheet | FileKind::Presentation
        ),
        "code" => metadata.kind == FileKind::Source,
        "images" => metadata.kind == FileKind::Image,
        _ => false,
    }
}

#[cfg(test)]
fn matches_scope(hit: &HybridHit, scope: &str) -> bool {
    matches_metadata_scope(&hit.metadata, scope)
}

pub(super) fn validate_search_options(
    scope: &str,
    filters: &[SearchFilterRequest],
    filename_priority: u8,
    recency: &str,
) -> Result<(), SearchFailure> {
    if !matches!(
        scope,
        "all" | "files" | "folders" | "documents" | "code" | "images" | "recent" | "related"
    ) || filename_priority > 100
        || !matches!(recency, "low" | "balanced" | "high")
        || filters.len() > 16
        || filters.iter().any(|filter| {
            !matches!(filter.id.as_str(), "extension" | "kind")
                || filter.value.is_empty()
                || filter.value.len() > 32
        })
    {
        return Err(SearchFailure::new(
            "search-failed",
            "The search options are invalid.",
            None,
        ));
    }
    Ok(())
}

pub(super) fn matches_metadata_filters(
    metadata: &FileRecord,
    filters: &[SearchFilterRequest],
) -> bool {
    filters.iter().all(|filter| match filter.id.as_str() {
        "extension" => metadata
            .extension
            .as_deref()
            .unwrap_or_default()
            .eq_ignore_ascii_case(filter.value.trim_start_matches('.')),
        "kind" => metadata.kind.as_str().eq_ignore_ascii_case(&filter.value),
        _ => false,
    })
}

#[cfg(test)]
fn matches_filters(hit: &HybridHit, filters: &[SearchFilterRequest]) -> bool {
    matches_metadata_filters(&hit.metadata, filters)
}

fn ranking_weights(
    filename_priority: u8,
    recency: &str,
    semantic_enabled: bool,
    reranking_enabled: bool,
    show_pinned: bool,
) -> ranking::RankingWeights {
    if !reranking_enabled {
        return ranking::RankingWeights {
            lexical: 1.0,
            semantic: if semantic_enabled { 0.35 } else { 0.0 },
            recency: 0.0,
            pin: 0.0,
        };
    }
    ranking::RankingWeights {
        lexical: 0.35 + f64::from(filename_priority) * 0.003,
        semantic: if semantic_enabled { 0.34 } else { 0.0 },
        recency: match recency {
            "low" => 0.02,
            "high" => 0.16,
            _ => 0.08,
        },
        pin: if show_pinned { 0.06 } else { 0.0 },
    }
}

fn schedule_embedding_worker(app: AppHandle, runtime: IndexRuntime) {
    if !runtime.begin_embedding_worker() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let activity = app.state::<crate::activity::ActivityRuntime>().snapshot();
            if activity.background_policy != crate::activity::BackgroundPolicy::Normal {
                break;
            }
            let gateway = app.state::<crate::gateway::GatewaySupervisor>();
            let local_runtime = app.state::<crate::gateway::LocalRuntimeSupervisor>();
            let registry = app.state::<crate::gateway::registry::ProviderRegistry>();
            let model_key = embedding::active_model_key(registry.inner());
            match embedding::process_pending(
                &runtime,
                gateway.inner(),
                local_runtime.inner(),
                &model_key,
            )
            .await
            {
                Ok(0) | Err(_) => break,
                Ok(_) => tokio::time::sleep(std::time::Duration::from_millis(25)).await,
            }
        }
        runtime.finish_embedding_worker();
    });
}

#[tauri::command]
pub fn get_index_status(state: State<'_, IndexRuntime>) -> IndexStatus {
    state.snapshot()
}

#[tauri::command]
pub async fn synchronize_index_roots(
    state: State<'_, IndexRuntime>,
    activity: State<'_, crate::activity::ActivityRuntime>,
    roots: Vec<IndexRootRequest>,
) -> Result<IndexStatus, SearchFailure> {
    state.configure_roots(
        roots,
        activity.snapshot().background_policy == crate::activity::BackgroundPolicy::Normal,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_hybrid(
    state: State<'_, IndexRuntime>,
    gateway: State<'_, crate::gateway::GatewaySupervisor>,
    local_runtime: State<'_, crate::gateway::LocalRuntimeSupervisor>,
    registry: State<'_, crate::gateway::registry::ProviderRegistry>,
    improvement: State<'_, std::sync::Arc<crate::improvement::coordinator::ImprovementRuntime>>,
    request_id: u64,
    query: String,
    scope: String,
    filters: Vec<SearchFilterRequest>,
    limit: usize,
    filename_priority: u8,
    recency: String,
    show_pinned: bool,
    semantic_enabled: bool,
    reranking_enabled: bool,
) -> Result<HybridSearchResponse, SearchFailure> {
    let version = improvement.capture(&registry);
    let began = std::time::Instant::now();
    let result = async {
        validate_search_options(&scope, &filters, filename_priority, &recency)?;
        let runtime = state.inner().clone();
        runtime.begin_search(request_id);
        let query_vector = if semantic_enabled && scope != "recent" {
            embedding::embed_query(&query, gateway.inner(), local_runtime.inner())
                .await
                .ok()
        } else {
            None
        };
        if !runtime.search_is_current(request_id) {
            return Ok(HybridSearchResponse::lexical(Vec::new()));
        }
        let embedding_unavailable = semantic_enabled && scope != "recent" && query_vector.is_none();
        let worker_runtime = runtime.clone();
        let worker_query = query.clone();
        let embedding_model = embedding::active_model_key(registry.inner());
        let weights = ranking_weights(
            filename_priority,
            &recency,
            semantic_enabled,
            reranking_enabled,
            show_pinned,
        );
        let worker_scope = scope.clone();
        let worker_filters = filters;
        let mut hits = tauri::async_runtime::spawn_blocking(move || {
            if worker_scope == "recent" {
                worker_runtime
                    .recent_search_filtered(&worker_query, limit.min(10_000), &worker_filters)
                    .map(HybridSearchResponse::lexical)
            } else {
                worker_runtime.hybrid_search_filtered(
                    &worker_query,
                    query_vector.as_deref(),
                    &embedding_model,
                    limit.min(10_000),
                    weights,
                    &worker_scope,
                    &worker_filters,
                )
            }
        })
        .await
        .map_err(|error| search_failure("join the index search", error))??;
        if !runtime.search_is_current(request_id) {
            return Ok(HybridSearchResponse::lexical(Vec::new()));
        }
        if embedding_unavailable {
            hits.semantic = SemanticRetrievalStatus::degraded();
        }
        hits.items.truncate(limit.min(10_000));
        runtime.record_user_query(&query, !hits.items.is_empty())?;
        Ok(hits)
    }
    .await;
    super::record_search_trace(&improvement, &version, began, &result);
    result
}

#[tauri::command]
pub async fn search_related(
    state: State<'_, IndexRuntime>,
    gateway: State<'_, crate::gateway::GatewaySupervisor>,
    local_runtime: State<'_, crate::gateway::LocalRuntimeSupervisor>,
    registry: State<'_, crate::gateway::registry::ProviderRegistry>,
    stable_id: String,
    limit: usize,
    filters: Vec<SearchFilterRequest>,
) -> Result<Vec<HybridHit>, SearchFailure> {
    validate_search_options("related", &filters, 50, "balanced")?;
    let source = state.source_text(&stable_id)?.ok_or_else(|| {
        SearchFailure::new(
            "search-failed",
            "The selected file has no indexed text for Related search.",
            None,
        )
    })?;
    let vector = embedding::embed_query(&source, gateway.inner(), local_runtime.inner())
        .await
        .map_err(|_| {
            SearchFailure::new(
                "search-failed",
                "Related search is unavailable until the local embedding runtime is ready.",
                None,
            )
        })?;
    let runtime = state.inner().clone();
    let embedding_model = embedding::active_model_key(registry.inner());
    tauri::async_runtime::spawn_blocking(move || {
        runtime.related_search_filtered(
            &stable_id,
            &vector,
            &embedding_model,
            limit.min(10_000),
            &filters,
        )
    })
    .await
    .map_err(|error| search_failure("join related search", error))?
}

#[tauri::command]
pub fn get_semantic_search_status(
    state: State<'_, IndexRuntime>,
    registry: State<'_, crate::gateway::registry::ProviderRegistry>,
) -> Result<SemanticSearchStatus, SearchFailure> {
    state.semantic_status(&embedding::active_model_key(registry.inner()))
}

#[tauri::command]
pub fn set_indexed_file_pinned(
    state: State<'_, IndexRuntime>,
    stable_id: String,
    pinned: bool,
) -> Result<PinUpdateResult, SearchFailure> {
    Ok(PinUpdateResult {
        applied: state.set_pinned(&stable_id, pinned)?,
        pinned,
    })
}

#[tauri::command]
pub fn set_history_enabled(state: State<'_, IndexRuntime>, enabled: bool) {
    state.set_history_enabled(enabled);
}

#[tauri::command]
pub fn get_search_history_status(
    state: State<'_, IndexRuntime>,
) -> Result<HistoryStatus, SearchFailure> {
    state.history_status()
}

#[tauri::command]
pub fn clear_search_history(
    state: State<'_, IndexRuntime>,
) -> Result<HistoryClearResult, SearchFailure> {
    state.clear_history()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn get_native_diagnostics(
    index: State<'_, IndexRuntime>,
    activity: State<'_, ActivityRuntime>,
    gateway: State<'_, GatewaySupervisor>,
    mcp: State<'_, McpRuntime>,
    runtime: State<'_, LocalRuntimeSupervisor>,
    provisioning: State<'_, ProvisioningManager>,
    providers: State<'_, ProviderRegistry>,
    shortcut: State<'_, ShortcutRegistration>,
) -> Result<NativeDiagnostics, SearchFailure> {
    let started = Instant::now();
    let (index, vector) = index.native_index_diagnostics()?;
    let activity = activity.snapshot();
    let gateway = gateway.health();
    let mcp = mcp.snapshot();
    let runtime = runtime.health();
    let provisioning = provisioning.snapshot();
    let routes = providers.routes();
    let local_routes = routes
        .iter()
        .filter(|route| !route.provider_id.is_cloud())
        .count() as u64;
    let mut allowed = 0_u64;
    let mut ask = 0_u64;
    let mut denied = 0_u64;
    for permission in &mcp.permissions {
        match permission.access {
            ToolAccess::Allow => allowed += 1,
            ToolAccess::Ask => ask += 1,
            ToolAccess::Deny => denied += 1,
        }
    }
    let logs = vec![
        NativeLogSample {
            component: "index",
            state: index.phase.clone(),
        },
        NativeLogSample {
            component: "vector",
            state: if vector.available {
                "ready"
            } else {
                "unavailable"
            }
            .to_owned(),
        },
        NativeLogSample {
            component: "gateway",
            state: gateway.state.to_owned(),
        },
        NativeLogSample {
            component: "runtime",
            state: runtime.state.to_owned(),
        },
    ];
    Ok(NativeDiagnostics {
        app_version: env!("CARGO_PKG_VERSION"),
        index,
        vector,
        activity: NativeActivityDiagnostics {
            mode: activity.mode,
            background_policy: activity.background_policy,
            fullscreen: activity.fullscreen,
            on_battery: activity.on_battery,
        },
        gateway: NativeGatewayDiagnostics {
            state: gateway.state.to_owned(),
            version: gateway.version.to_owned(),
            cloud_credential_configured: gateway.cloud_credential_configured,
        },
        mcp: NativeMcpDiagnostics {
            services: mcp.services.len() as u64,
            tools: mcp.permissions.len() as u64,
            allowed,
            ask,
            denied,
        },
        runtime: NativeRuntimeDiagnostics {
            state: runtime.state.to_owned(),
            profile: runtime.profile.to_owned(),
            lemonade_version: runtime.lemonade.version,
            required_lemonade_version: runtime.lemonade.required_version.to_owned(),
            answer_model: runtime.answer_model.to_owned(),
            embedding_model: runtime.embedding_model.to_owned(),
        },
        provisioning: NativeProvisioningDiagnostics {
            state: provisioning.state,
            version: provisioning.version,
            installed_version: provisioning.installed_version,
            progress: provisioning.progress,
        },
        providers: NativeProviderDiagnostics {
            routes: routes.len() as u64,
            local_routes,
            cloud_routes: routes.len() as u64 - local_routes,
        },
        shortcut: shortcut.snapshot(),
        timings: vec![NativeTimingSample {
            name: "native-diagnostics",
            duration_ms: started.elapsed().as_millis() as u64,
        }],
        logs,
    })
}

#[tauri::command]
pub async fn delete_index_data(
    state: State<'_, IndexRuntime>,
) -> Result<DeletedIndexData, SearchFailure> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.delete_indexed_content())
        .await
        .map_err(|error| search_failure("join the index deletion worker", error))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::test_support::SearchFixture;

    #[test]
    fn missing_vector_extension_preserves_content_only_and_filename_hits() {
        let fixture = SearchFixture::new("missing-vector-lexical");
        fixture.file("notes.md", b"quasar is only in this document body");
        fixture.file("quasar.md", b"unrelated body");
        let runtime = IndexRuntime::open(
            &fixture.root().parent().unwrap().join("index.sqlite"),
            &fixture.root().parent().unwrap().join("missing-vector.dll"),
            false,
        )
        .unwrap();
        runtime
            .synchronize_with_content(
                vec![IndexRootRequest {
                    path: fixture.root().to_string_lossy().into_owned(),
                    cloud_enrichment: false,
                    exclusions: vec![],
                    include_hidden: false,
                    max_file_size_mb: 1,
                }],
                true,
            )
            .unwrap();
        let response = runtime
            .hybrid_search_filtered(
                "quasar",
                Some(&[0.5, 0.5]),
                "missing",
                10,
                ranking::RankingWeights::default(),
                "all",
                &[],
            )
            .unwrap();
        assert_eq!(response.semantic.phase, SemanticPhase::Degraded);
        assert!(
            response
                .semantic
                .reason
                .as_deref()
                .unwrap()
                .contains("filename and content")
        );
        let hits = response.items;
        assert_eq!(
            hits.iter()
                .map(|hit| hit.hit.name.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["notes.md", "quasar.md"])
        );
        assert_eq!(
            hits.iter()
                .find(|hit| hit.hit.name == "notes.md")
                .unwrap()
                .match_source,
            "content"
        );
        let empty = runtime
            .hybrid_search_filtered(
                "nevermatches",
                Some(&[0.5, 0.5]),
                "missing",
                10,
                ranking::RankingWeights::default(),
                "all",
                &[],
            )
            .unwrap();
        assert!(empty.items.is_empty());
        assert_eq!(empty.semantic.phase, SemanticPhase::Degraded);
    }

    #[test]
    fn recency_uses_file_modification_and_open_history_instead_of_index_time() {
        let fixture = SearchFixture::new("meaningful-recency");
        let old = fixture.file("old-report.md", b"report");
        let recent = fixture.file("new-report.md", b"report");
        let now = std::time::SystemTime::now();
        for (path, age_days) in [(&old, 180), (&recent, 2)] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_modified(now - std::time::Duration::from_secs(age_days * 86400)),
                )
                .unwrap();
        }
        let runtime = IndexRuntime::open(
            &fixture.root().parent().unwrap().join("index.sqlite"),
            Path::new("missing-vector.dll"),
            true,
        )
        .unwrap();
        runtime
            .synchronize_with_content(
                vec![IndexRootRequest {
                    path: fixture.root().to_string_lossy().into_owned(),
                    cloud_enrichment: false,
                    exclusions: vec![],
                    include_hidden: false,
                    max_file_size_mb: 1,
                }],
                true,
            )
            .unwrap();
        let old_id = runtime
            .stable_id_for_path(&std::fs::canonicalize(old).unwrap())
            .unwrap()
            .unwrap();
        let new_id = runtime
            .stable_id_for_path(&std::fs::canonicalize(recent).unwrap())
            .unwrap()
            .unwrap();
        let old_score = runtime.database.ranking_signals(&old_id).unwrap().0;
        let new_score = runtime.database.ranking_signals(&new_id).unwrap().0;
        assert!(
            old_score < new_score,
            "indexing both today must not make their recency equal"
        );
        runtime.database.record_file_open(&old_id).unwrap();
        assert!(runtime.database.ranking_signals(&old_id).unwrap().0 > new_score);
    }

    #[test]
    fn unified_inventory_retains_folders_empty_and_unsupported_files() {
        let fixture = SearchFixture::new("unified-inventory");
        fixture.file("report.md", b"");
        fixture.file("report.tmp", &[0, 1]);
        fixture.file("report-folder/child.bin", &[0]);
        fixture.file("cache/report.md", b"excluded");
        fixture.file(".report.md", b"hidden");
        fixture.file("oversize-report.bin", &vec![0; 1024 * 1024 + 1]);
        let database_path = fixture.root().parent().unwrap().join("index.sqlite");
        let runtime =
            IndexRuntime::open(&database_path, Path::new("missing-vector.dll"), false).unwrap();
        let roots = vec![IndexRootRequest {
            path: fixture.root().to_string_lossy().into_owned(),
            cloud_enrichment: false,
            exclusions: vec!["cache".into()],
            include_hidden: false,
            max_file_size_mb: 1,
        }];
        runtime.synchronize_with_content(roots, true).unwrap();
        let hits = runtime
            .hybrid_search(
                "report",
                None,
                "missing",
                100,
                ranking::RankingWeights::default(),
            )
            .unwrap();
        assert_eq!(
            hits.iter()
                .map(|hit| hit.hit.name.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["report.md", "report.tmp", "report-folder"])
        );
        assert!(hits.iter().all(|hit| (0.0..=1.0).contains(&hit.hit.rank)));
        let md = vec![SearchFilterRequest {
            id: "extension".into(),
            value: ".md".into(),
        }];
        assert_eq!(
            hits.iter().filter(|hit| matches_filters(hit, &md)).count(),
            1
        );
        assert_eq!(
            hits.iter()
                .filter(|hit| matches_scope(hit, "folders"))
                .count(),
            1
        );
        assert_eq!(
            hits.iter()
                .filter(|hit| matches_scope(hit, "files"))
                .count(),
            2
        );
        let kind = vec![SearchFilterRequest {
            id: "kind".into(),
            value: "unknown".into(),
        }];
        assert_eq!(
            hits.iter()
                .filter(|hit| matches_filters(hit, &kind))
                .count(),
            1
        );
        drop(runtime);
        let reopened =
            IndexRuntime::open(&database_path, Path::new("missing-vector.dll"), false).unwrap();
        assert_eq!(
            reopened
                .hybrid_search(
                    "report",
                    None,
                    "missing",
                    100,
                    ranking::RankingWeights::default()
                )
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn applies_filters_before_limit_for_filename_and_content_candidates() {
        let fixture = SearchFixture::new("filtered-native-order");
        fixture.file("report.tmp", b"report");
        fixture.file("z-report.md", b"report");
        fixture.file("report-folder/child.bin", b"");
        let runtime = IndexRuntime::open(
            &fixture.root().parent().unwrap().join("index.sqlite"),
            Path::new("missing-vector.dll"),
            false,
        )
        .unwrap();
        runtime
            .synchronize_with_content(
                vec![IndexRootRequest {
                    path: fixture.root().to_string_lossy().into_owned(),
                    cloud_enrichment: false,
                    exclusions: vec![],
                    include_hidden: false,
                    max_file_size_mb: 1,
                }],
                true,
            )
            .unwrap();
        let filters = [SearchFilterRequest {
            id: "extension".into(),
            value: ".md".into(),
        }];
        let filtered = runtime
            .hybrid_search_filtered(
                "report",
                None,
                "missing",
                1,
                ranking::RankingWeights::default(),
                "files",
                &filters,
            )
            .unwrap();
        assert_eq!(filtered.items.len(), 1);
        assert_eq!(filtered.items[0].hit.name, "z-report.md");
        let folders = runtime
            .hybrid_search_filtered(
                "report",
                None,
                "missing",
                1,
                ranking::RankingWeights::default(),
                "folders",
                &[],
            )
            .unwrap();
        assert_eq!(folders.items[0].metadata.kind, FileKind::Folder);
    }

    #[test]
    fn metadata_reconciliation_prunes_revoked_roots_and_their_jobs_while_paused() {
        let fixture = SearchFixture::new("paused-root-revocation");
        fixture.file("scan.png", &[0, 1, 2]);
        let runtime = IndexRuntime::open(
            &fixture.root().parent().unwrap().join("index.sqlite"),
            Path::new("missing-vector.dll"),
            true,
        )
        .unwrap();
        runtime
            .synchronize_with_content(
                vec![IndexRootRequest {
                    path: fixture.root().to_string_lossy().into_owned(),
                    cloud_enrichment: true,
                    exclusions: vec![],
                    include_hidden: false,
                    max_file_size_mb: 1,
                }],
                true,
            )
            .unwrap();
        assert!(!runtime.pending_enrichment().unwrap().is_empty());
        runtime.synchronize_with_content(vec![], false).unwrap();
        assert!(runtime.pending_enrichment().unwrap().is_empty());
        assert!(
            runtime
                .hybrid_search(
                    "scan",
                    None,
                    "missing",
                    10,
                    ranking::RankingWeights::default()
                )
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn runtime_history_and_diagnostics_are_durable_and_redacted() {
        let fixture = SearchFixture::new("runtime-privacy-data");
        fixture.file("private-report.txt", b"quarterly private report");
        let database_path = fixture.root().parent().unwrap().join("index.sqlite");
        let vector_extension = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/vector.dll");
        let runtime = IndexRuntime::open(&database_path, &vector_extension, false).unwrap();
        runtime
            .synchronize_with_content(
                vec![IndexRootRequest {
                    path: fixture.root().to_string_lossy().into_owned(),
                    cloud_enrichment: false,
                    exclusions: Vec::new(),
                    include_hidden: false,
                    max_file_size_mb: 256,
                }],
                true,
            )
            .unwrap();

        assert_eq!(runtime.answer_context("quarterly", 10).unwrap().len(), 1);
        assert_eq!(runtime.history_status().unwrap().entry_count, 0);
        runtime.set_history_enabled(true);
        assert_eq!(runtime.answer_context("quarterly", 10).unwrap().len(), 1);
        assert_eq!(runtime.history_status().unwrap().entry_count, 0);
        runtime
            .database
            .record_user_query("quarterly", true)
            .unwrap();
        let status = runtime.history_status().unwrap();
        assert_eq!(status.entry_count, 1);
        assert!(status.enabled);

        let (diagnostics, vector) = runtime.native_index_diagnostics().unwrap();
        assert_eq!(diagnostics.indexed_files, 1);
        assert_eq!(diagnostics.indexed_chunks, 1);
        assert_eq!(diagnostics.phase, "ready");
        assert_eq!(diagnostics.schema_version, 4);
        assert_eq!(diagnostics.history_entries, 1);
        assert!(vector.available);
        let serialized = serde_json::to_string(&diagnostics).unwrap();
        assert!(!serialized.contains("private-report"));
        assert!(!serialized.contains(&fixture.root().to_string_lossy().into_owned()));

        let deleted = runtime.delete_indexed_content().unwrap();
        assert_eq!(deleted.deleted_files, 1);
        assert_eq!(deleted.deleted_chunks, 1);
        assert_eq!(runtime.history_status().unwrap().entry_count, 1);
        drop(runtime);

        let reopened = IndexRuntime::open(&database_path, &vector_extension, false).unwrap();
        let persisted = reopened.history_status().unwrap();
        assert_eq!(persisted.entry_count, 1);
        assert!(!persisted.enabled);
    }

    #[test]
    fn native_diagnostics_contract_serializes_only_bounded_typed_samples() {
        let diagnostics = NativeDiagnostics {
            app_version: "0.1.0",
            index: NativeIndexDiagnostics {
                phase: "ready".to_owned(),
                schema_version: 3,
                indexed_files: 4,
                indexed_chunks: 8,
                history_entries: 2,
                history_enabled: true,
            },
            vector: VectorStatus {
                available: true,
                version: Some("1.0.0".to_owned()),
                backend: Some("sqlite-vector".to_owned()),
                last_error: None,
            },
            activity: NativeActivityDiagnostics {
                mode: ActivityMode::Indexing,
                background_policy: BackgroundPolicy::Normal,
                fullscreen: false,
                on_battery: false,
            },
            gateway: NativeGatewayDiagnostics {
                state: "ready".to_owned(),
                version: "0.8.0".to_owned(),
                cloud_credential_configured: false,
            },
            mcp: NativeMcpDiagnostics {
                services: 1,
                tools: 3,
                allowed: 1,
                ask: 1,
                denied: 1,
            },
            runtime: NativeRuntimeDiagnostics {
                state: "ready".to_owned(),
                profile: "generic-local".to_owned(),
                lemonade_version: Some("11.5.2".to_owned()),
                required_lemonade_version: "11.5.2".to_owned(),
                answer_model: "qwen".to_owned(),
                embedding_model: "nomic".to_owned(),
            },
            provisioning: NativeProvisioningDiagnostics {
                state: "ready".to_owned(),
                version: "11.5.2".to_owned(),
                installed_version: Some("11.5.2".to_owned()),
                progress: 100,
            },
            providers: NativeProviderDiagnostics {
                routes: 2,
                local_routes: 1,
                cloud_routes: 1,
            },
            shortcut: crate::window::ShortcutStatus {
                registered: true,
                accelerator: Some("Alt + Space".to_owned()),
                error_code: None,
            },
            timings: vec![NativeTimingSample {
                name: "native-diagnostics",
                duration_ms: 1,
            }],
            logs: vec![NativeLogSample {
                component: "index",
                state: "ready".to_owned(),
            }],
        };

        let serialized = serde_json::to_value(diagnostics).unwrap();
        assert_eq!(serialized["index"]["schemaVersion"], 3);
        assert_eq!(serialized["shortcut"]["registered"], true);
        assert_eq!(serialized["timings"].as_array().unwrap().len(), 1);
        assert_eq!(serialized["logs"].as_array().unwrap().len(), 1);
        let text = serialized.to_string();
        assert!(!text.contains("C:\\"));
        assert!(!text.contains("prompt"));
        assert!(!text.contains("credential"));
    }

    #[test]
    fn cloud_jobs_require_explicit_root_consent() {
        let fixture = SearchFixture::new("index-runtime-consent");
        fixture.file("scan.png", &[0, 1, 2]);
        let database_path = fixture.root().join("index.sqlite");
        let vector_extension = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/vector.dll");
        let runtime = IndexRuntime::open(&database_path, &vector_extension, true).unwrap();

        let private = runtime
            .synchronize_with_content(
                vec![IndexRootRequest {
                    path: fixture.root().to_string_lossy().into_owned(),
                    cloud_enrichment: false,
                    exclusions: Vec::new(),
                    include_hidden: false,
                    max_file_size_mb: 256,
                }],
                true,
            )
            .unwrap();
        assert_eq!(private.queued_enrichment, 0);

        let consented = runtime
            .synchronize_with_content(
                vec![IndexRootRequest {
                    path: fixture.root().to_string_lossy().into_owned(),
                    cloud_enrichment: true,
                    exclusions: Vec::new(),
                    include_hidden: false,
                    max_file_size_mb: 256,
                }],
                true,
            )
            .unwrap();
        assert_eq!(consented.queued_enrichment, 1);
    }

    #[test]
    fn metadata_only_sync_adds_filename_without_reading_content() {
        let fixture = SearchFixture::new("index-runtime-metadata-only");
        fixture.file("new-report.txt", b"secret body term");
        let database_path = fixture.root().join("index.sqlite");
        let vector_extension = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/vector.dll");
        let runtime = IndexRuntime::open(&database_path, &vector_extension, true).unwrap();
        let roots = vec![IndexRootRequest {
            path: fixture.root().to_string_lossy().into_owned(),
            cloud_enrichment: true,
            exclusions: Vec::new(),
            include_hidden: false,
            max_file_size_mb: 256,
        }];

        runtime
            .synchronize_with_content(roots.clone(), false)
            .unwrap();
        assert_eq!(runtime.answer_context("report", 10).unwrap().len(), 1);
        assert!(runtime.answer_context("secret", 10).unwrap().is_empty());
        assert!(runtime.pending_enrichment().unwrap().is_empty());

        runtime.synchronize_with_content(roots, true).unwrap();
        assert_eq!(runtime.answer_context("secret", 10).unwrap().len(), 1);
    }

    #[test]
    fn semantic_recovery_and_related_results_exclude_the_source() {
        let fixture = SearchFixture::new("hybrid-related");
        fixture.file("alpha.txt", b"quiet lighthouse notes");
        fixture.file("beta.txt", b"harbor navigation notes");
        fixture.file("gamma.txt", b"garden planting notes");
        let database_path = fixture.root().join("index.sqlite");
        let vector_extension = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/vector.dll");
        let runtime = IndexRuntime::open(&database_path, &vector_extension, true).unwrap();
        runtime
            .synchronize_with_content(
                vec![IndexRootRequest {
                    path: fixture.root().to_string_lossy().into_owned(),
                    cloud_enrichment: false,
                    exclusions: Vec::new(),
                    include_hidden: false,
                    max_file_size_mb: 256,
                }],
                true,
            )
            .unwrap();
        runtime
            .queue_embedding_jobs(embedding::EMBEDDING_MODEL)
            .unwrap();
        let jobs = runtime
            .pending_embedding_jobs(embedding::EMBEDDING_MODEL, 8)
            .unwrap();
        for job in jobs {
            let vector = if job.text.contains("lighthouse") {
                [1.0, 0.0]
            } else if job.text.contains("harbor") {
                [0.95, 0.05]
            } else {
                [0.0, 1.0]
            };
            assert!(runtime.complete_embedding_job(&job, &vector).unwrap());
        }

        let recovered = runtime
            .hybrid_search(
                "seafaring",
                Some(&[1.0, 0.0]),
                embedding::EMBEDDING_MODEL,
                10,
                ranking::RankingWeights::default(),
            )
            .unwrap();
        assert_eq!(recovered[0].hit.name, "alpha.txt");
        assert_eq!(recovered[0].match_source, "semantic");
        let source_id = recovered[0].hit.stable_id.clone();

        let related = runtime
            .related_search(&source_id, &[1.0, 0.0], embedding::EMBEDDING_MODEL, 10)
            .unwrap();
        assert!(!related.iter().any(|hit| hit.hit.stable_id == source_id));
        assert_eq!(related[0].hit.name, "beta.txt");
        assert!(related.iter().all(|hit| hit.match_source == "related"));
    }
}
