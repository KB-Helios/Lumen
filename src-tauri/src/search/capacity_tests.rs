//! Opt-in real filesystem/core measurements. No app, IPC, provider or seeded capacity rows.
use super::*;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static FTS_DELETE_VM: AtomicU64 = AtomicU64::new(0);
static FTS_DELETE_COUNT: AtomicU64 = AtomicU64::new(0);
static FTS_UPDATE_VM: AtomicU64 = AtomicU64::new(0);
static FTS_UPDATE_COUNT: AtomicU64 = AtomicU64::new(0);

fn observe_sql(runtime: &IndexRuntime) {
    use rusqlite::trace::{TraceEvent, TraceEventCodes};
    runtime.database.inspect_connection(|c| {
        c.trace_v2(
            TraceEventCodes::SQLITE_TRACE_PROFILE,
            Some(|event| {
                if let TraceEvent::Profile(stmt, _) = event {
                    let sql = stmt.sql();
                    let counters = if sql.starts_with("DELETE FROM search_fts WHERE") {
                        Some((&FTS_DELETE_COUNT, &FTS_DELETE_VM))
                    } else if sql.starts_with("UPDATE search_fts") {
                        Some((&FTS_UPDATE_COUNT, &FTS_UPDATE_VM))
                    } else {
                        None
                    };
                    if let Some((count, vm)) = counters {
                        count.fetch_add(1, Ordering::Relaxed);
                        vm.fetch_add(
                            stmt.get_status(rusqlite::StatementStatus::VmStep) as u64,
                            Ordering::Relaxed,
                        );
                    }
                }
            }),
        )
    });
}

fn sql_work() -> serde_json::Value {
    json!({"fts_delete_count":FTS_DELETE_COUNT.load(Ordering::Relaxed),"fts_delete_vm_steps":FTS_DELETE_VM.load(Ordering::Relaxed),"fts_update_count":FTS_UPDATE_COUNT.load(Ordering::Relaxed),"fts_update_vm_steps":FTS_UPDATE_VM.load(Ordering::Relaxed)})
}

#[derive(Default)]
pub(crate) struct Metrics {
    scans: AtomicU64,
    scans_done: AtomicU64,
    selection_ns: AtomicU64,
    selection_candidates: AtomicU64,
    status_retry_candidates: AtomicU64,
    status_ns: AtomicU64,
    admission_ns: AtomicU64,
    extraction_ns: AtomicU64,
    commit_ns: AtomicU64,
    sleep_ns: AtomicU64,
    commits: AtomicU64,
    last_sleep_commit: AtomicU64,
    max_batch: AtomicU64,
    metadata_records: AtomicU64,
    metadata_ns: AtomicU64,
    pub errors: Mutex<Vec<(String, String)>>,
    events: Mutex<Vec<serde_json::Value>>,
}

impl Metrics {
    pub fn status_retry_candidates(&self, count: usize) {
        self.status_retry_candidates
            .fetch_add(count as u64, Ordering::Relaxed);
    }
    pub fn status(&self, elapsed: Duration) {
        self.status_ns
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }
    pub fn admission(&self, elapsed: Duration) {
        self.admission_ns
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }
    pub fn inventory_record(&self, elapsed: Duration) {
        self.metadata_records.fetch_add(1, Ordering::Relaxed);
        self.metadata_ns
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }
    pub fn database_error(&self, lane: &str, error: &super::super::index::IndexError) {
        let code = match error {
            super::super::index::IndexError::Database(error) => {
                format!("{:?}", error.sqlite_error_code())
            }
            _ => "non-SQLite".into(),
        };
        self.errors.lock().unwrap().push((lane.into(), code));
    }
    pub fn start_scan(&self, forced: bool) -> Instant {
        self.scans.fetch_add(1, Ordering::SeqCst);
        self.events
            .lock()
            .unwrap()
            .push(json!({"event":"scan_start", "forced":forced,
            "unix_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),
            "thread":format!("{:?}", std::thread::current().id())}));
        Instant::now()
    }
    pub fn finish_scan(&self, clock: Instant) {
        self.scans_done.fetch_add(1, Ordering::SeqCst);
        self.events
            .lock()
            .unwrap()
            .push(json!({"event":"scan_complete", "ms":clock.elapsed().as_secs_f64()*1000.0}));
    }
    pub fn traversal(&self, outcome: &traversal::TraversalOutcome, elapsed: Duration) {
        self.events.lock().unwrap().push(json!({"event":"traversal", "records":outcome.records.len(),
            "folders":outcome.records.iter().filter(|item| item.kind == FileKind::Folder).count(),
            "warnings":outcome.warnings.len(),"truncated":outcome.truncated,"ms":elapsed.as_secs_f64()*1000.0}));
    }
    pub fn selection(&self, elapsed: Duration) {
        self.selection_ns
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }
    pub fn candidates(&self, count: usize) {
        self.selection_candidates
            .fetch_add(count as u64, Ordering::Relaxed);
    }
    pub fn extraction(&self, elapsed: Duration) {
        self.extraction_ns
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }
    pub fn commit(&self, elapsed: Duration) {
        self.commit_ns
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
        self.commits.fetch_add(1, Ordering::Relaxed);
    }
    pub fn sleep(&self, elapsed: Duration) {
        self.sleep_ns
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
        let commits = self.commits.load(Ordering::Relaxed);
        let previous = self.last_sleep_commit.swap(commits, Ordering::Relaxed);
        self.max_batch
            .fetch_max(commits - previous, Ordering::Relaxed);
    }
    fn snapshot(&self) -> serde_json::Value {
        json!({"scans":self.scans.load(Ordering::SeqCst),"scans_done":self.scans_done.load(Ordering::SeqCst),
            "metadata_records":self.metadata_records.load(Ordering::Relaxed),"metadata_upsert_ms":self.metadata_ns.load(Ordering::Relaxed) as f64/1e6,
            "selection_ms":self.selection_ns.load(Ordering::Relaxed) as f64/1e6,
            "selection_candidates":self.selection_candidates.load(Ordering::Relaxed),
            "status_retry_candidates":self.status_retry_candidates.load(Ordering::Relaxed),
            "status_ms":self.status_ns.load(Ordering::Relaxed) as f64/1e6,
            "content_admission_ms":self.admission_ns.load(Ordering::Relaxed) as f64/1e6,
            "extraction_ms":self.extraction_ns.load(Ordering::Relaxed) as f64/1e6,
            "commit_ms":self.commit_ns.load(Ordering::Relaxed) as f64/1e6,
            "worker_sleep_ms":self.sleep_ns.load(Ordering::Relaxed) as f64/1e6,
            "commits":self.commits.load(Ordering::Relaxed),"max_commits_between_sleeps":self.max_batch.load(Ordering::Relaxed),"events":*self.events.lock().unwrap(),"errors":*self.errors.lock().unwrap()})
    }
}

fn emit(file: &Path, mut value: serde_json::Value) {
    value["unix_ms"] = json!(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let line = serde_json::to_string(&value).unwrap();
    println!("TASK13 {line}");
    let mut output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .unwrap();
    writeln!(output, "{line}").unwrap();
    output.sync_data().unwrap();
}

fn wait_for(
    runtime: &IndexRuntime,
    output: &Path,
    phase: &str,
    timeout: Duration,
    predicate: impl Fn() -> bool,
) -> Duration {
    let clock = Instant::now();
    let mut checkpoint = Instant::now();
    while !predicate() {
        assert!(
            clock.elapsed() < timeout,
            "Task13 {phase} incomplete: watchdog expired"
        );
        if checkpoint.elapsed() >= Duration::from_secs(10) {
            emit(
                output,
                json!({"phase":phase,"progress_s":clock.elapsed().as_secs_f64(),"status":runtime.snapshot(),"metrics":runtime.work.metrics.snapshot()}),
            );
            checkpoint = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    clock.elapsed()
}

fn query(
    runtime: &IndexRuntime,
    term: &str,
    filters: &[SearchFilterRequest],
) -> HybridSearchResponse {
    runtime
        .hybrid_search_filtered(
            term,
            None,
            "task13-disabled",
            5,
            ranking::RankingWeights::default(),
            "all",
            filters,
        )
        .unwrap()
}

fn watcher_changes(runtime: &IndexRuntime, root: &Path, files: usize, output: &Path) {
    for i in [1, files / 2, files - 1] {
        let path = root.join(format!("shard-{:03}/document-{i:06}.txt", i / 1000));
        let metadata = fs::metadata(&path).unwrap();
        let old_time = metadata.modified().unwrap();
        let original = fs::read_to_string(&path).unwrap();
        let replacement = original.replace(&format!("unique{i:06}"), &format!("edited{i:06}"));
        assert_eq!(replacement.len(), original.len());
        runtime.set_content_enabled(false);
        fs::write(&path, replacement).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old_time))
            .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), old_time);
        let clock = Instant::now();
        wait_for(
            runtime,
            output,
            "watcher_invalidation",
            Duration::from_secs(180),
            || {
                query(runtime, &format!("unique{i:06}"), &[])
                    .items
                    .is_empty()
            },
        );
        let invalidation = clock.elapsed().as_secs_f64() * 1000.0;
        assert!(
            query(runtime, &format!("edited{i:06}"), &[])
                .items
                .is_empty()
        );
        runtime.set_content_enabled(true);
        wait_for(
            runtime,
            output,
            "watcher_content",
            Duration::from_secs(180),
            || query(runtime, &format!("edited{i:06}"), &[]).items.len() == 1,
        );
        emit(
            output,
            json!({"phase":"watcher_same_size_mtime_edit","ordinal":i,"old_content_invalidated_ms":invalidation,"new_content_ms":clock.elapsed().as_secs_f64()*1000.0,"actual_watcher":true}),
        );
    }
    let renamed = root.join("shard-000/document-000001-renamed.txt");
    let old_name = root.join("shard-000/document-000001.txt");
    fs::rename(&old_name, &renamed).unwrap();
    let clock = Instant::now();
    wait_for(
        runtime,
        output,
        "watcher_rename",
        Duration::from_secs(180),
        || {
            query(runtime, "document-000001-renamed.txt", &[])
                .items
                .len()
                == 1
                && query(runtime, "document-000001.txt", &[])
                    .items
                    .iter()
                    .all(|item| Path::new(&item.metadata.path).file_name() != old_name.file_name())
        },
    );
    emit(
        output,
        json!({"phase":"watcher_rename","ms":clock.elapsed().as_secs_f64()*1000.0}),
    );
    let i = files / 2;
    fs::remove_file(root.join(format!("shard-{:03}/document-{i:06}.txt", i / 1000))).unwrap();
    let clock = Instant::now();
    wait_for(
        runtime,
        output,
        "watcher_delete",
        Duration::from_secs(180),
        || {
            query(runtime, &format!("edited{i:06}"), &[])
                .items
                .is_empty()
                && query(runtime, &format!("document-{i:06}.txt"), &[])
                    .items
                    .is_empty()
        },
    );
    emit(
        output,
        json!({"phase":"watcher_delete","ms":clock.elapsed().as_secs_f64()*1000.0,"post_files":files-1}),
    );
}

fn cancellation(root: &Path, base: &Path, roots: Vec<IndexRootRequest>, output: &Path) {
    let db = base.join("cancel-inventory.sqlite");
    let runtime = IndexRuntime::open(&db, Path::new("missing-vector.dll"), true).unwrap();
    runtime.configure_roots(roots, false).unwrap();
    wait_for(
        &runtime,
        output,
        "inventory_cancel_start",
        Duration::from_secs(1800),
        || {
            runtime.work.metrics.metadata_records.load(Ordering::SeqCst) >= 100
                && runtime.work.inventory_running.load(Ordering::SeqCst)
        },
    );
    let clock = Instant::now();
    runtime.stop_index_worker();
    let admission = clock.elapsed().as_secs_f64() * 1000.0;
    let count = runtime.database.counts().unwrap().0;
    let clock = Instant::now();
    drop(runtime);
    let joined = clock.elapsed().as_secs_f64() * 1000.0;
    let reopened = IndexRuntime::open(&db, Path::new("missing-vector.dll"), true).unwrap();
    assert_eq!(
        reopened.database.counts().unwrap().0,
        count,
        "no late inventory commit after Stop"
    );
    reopened.stop_index_worker();
    drop(reopened);
    emit(
        output,
        json!({"phase":"cancel_during_inventory","admission_ms":admission,"join_ms":joined,"records_at_stop":count,"no_late_commit":true,"source_exists":root.is_dir()}),
    );

    let local = base.join("cancel-content");
    fs::create_dir(&local).unwrap();
    fs::write(local.join("stop.txt"), b"cancelquasar").unwrap();
    let runtime = IndexRuntime::open(
        &base.join("cancel-content.sqlite"),
        Path::new("missing-vector.dll"),
        true,
    )
    .unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    *runtime.commit_gate.lock().unwrap() = Some(Arc::new(move |_| {
        entered_tx.send(()).unwrap();
        release_rx
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(30))
            .unwrap();
    }));
    runtime
        .configure_roots(
            vec![IndexRootRequest {
                path: local.to_string_lossy().into_owned(),
                cloud_enrichment: false,
                exclusions: vec![],
                include_hidden: false,
                max_file_size_mb: 64,
            }],
            true,
        )
        .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(30)).unwrap();
    let query_clock = Instant::now();
    assert_eq!(query(&runtime, "stop.txt", &[]).items.len(), 1);
    let query_ms = query_clock.elapsed().as_secs_f64() * 1000.0;
    let clock = Instant::now();
    runtime.stop_index_worker();
    let admission = clock.elapsed().as_secs_f64() * 1000.0;
    *runtime.commit_gate.lock().unwrap() = None;
    release_tx.send(()).unwrap();
    let database = runtime.database.clone();
    let clock = Instant::now();
    drop(runtime);
    assert!(database.search("cancelquasar", 5).unwrap().is_empty());
    emit(
        output,
        json!({"phase":"cancel_before_content_commit","admission_ms":admission,"query_during_extraction_barrier_ms":query_ms,"join_ms":clock.elapsed().as_secs_f64()*1000.0,"no_late_content":true}),
    );
    drop(database);
}

fn check_database(runtime: &IndexRuntime) {
    runtime.database.inspect_connection(|connection| {
        assert!(connection.is_autocommit());
        assert_eq!(connection.query_row("PRAGMA integrity_check",[],|row|row.get::<_,String>(0)).unwrap(),"ok");
        assert_eq!(connection.query_row("SELECT count(*) FROM pragma_foreign_key_check",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(connection.query_row("SELECT count(*) FROM (SELECT file_id,ordinal,count(*) n FROM chunks GROUP BY file_id,ordinal HAVING n>1)",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(connection.query_row("SELECT count(*) FROM (SELECT file_id,chunk_id,count(*) n FROM search_fts GROUP BY file_id,chunk_id HAVING n>1)",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    });
}

pub(crate) fn owned_base(label: &str) -> PathBuf {
    assert!(
        label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    );
    let parent = Path::new("D:/CodexBuilds/Lumen/task13-owned");
    fs::create_dir_all(parent).unwrap();
    for ancestor in parent.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).unwrap();
        assert!(!metadata.file_type().is_symlink());
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(metadata.file_attributes() & 0x400, 0);
        }
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = parent.join(format!("{label}-{}-{nonce}", std::process::id()));
    fs::create_dir(&base).unwrap();
    fs::write(
        base.join("TASK13-OWNED"),
        b"synthetic task13 corpus; never ordinary index",
    )
    .unwrap();
    base
}

fn eventually(predicate: impl Fn() -> bool) {
    let clock = Instant::now();
    while !predicate() {
        assert!(
            clock.elapsed() < Duration::from_secs(30),
            "native fault fixture incomplete"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn constrain(runtime: &IndexRuntime) {
    runtime.database.inspect_connection(|c| {
        let pages:i64=c.query_row("PRAGMA page_count",[],|r|r.get(0)).unwrap();
        let size:i64=c.query_row("PRAGMA page_size",[],|r|r.get(0)).unwrap();
        let effective:i64=c.query_row(&format!("PRAGMA max_page_count={pages}"),[],|r|r.get(0)).unwrap();
        assert_eq!(effective,pages);
        println!("TASK13 same-native-connection page_count={pages} page_size={size} effective_max={effective}");
    });
}

#[test]
fn content_worker_batches_small_documents_with_bounded_rest() {
    let base = owned_base("batch-pacing");
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    for i in 0..40 {
        fs::write(root.join(format!("document-{i}.txt")), b"boundedquasar").unwrap();
    }
    let runtime = IndexRuntime::open(
        &base.join("index.sqlite"),
        Path::new("missing-vector.dll"),
        true,
    )
    .unwrap();
    runtime
        .configure_roots(
            vec![IndexRootRequest {
                path: root.to_string_lossy().into_owned(),
                cloud_enrichment: false,
                exclusions: vec![],
                include_hidden: false,
                max_file_size_mb: 64,
            }],
            true,
        )
        .unwrap();
    eventually(|| runtime.work.completed.lock().unwrap().len() == 40);
    std::thread::sleep(Duration::from_millis(60));
    let batch = runtime.work.metrics.max_batch.load(Ordering::Relaxed);
    assert!(
        batch > 1 && batch <= 8,
        "small documents need bounded batches between the retained25ms rests, observed {batch}"
    );
    runtime.stop_index_worker();
    drop(runtime);
}

#[test]
fn pending_selection_and_status_do_not_rescan_every_remaining_successful_job() {
    let base = owned_base("pending-selection");
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    for i in 0..40 {
        fs::write(root.join(format!("doc-{i:03}.txt")), b"selectionquasar").unwrap();
    }
    let runtime = IndexRuntime::open(
        &base.join("index.sqlite"),
        Path::new("missing-vector.dll"),
        true,
    )
    .unwrap();
    runtime
        .configure_roots(
            vec![IndexRootRequest {
                path: root.to_string_lossy().into_owned(),
                cloud_enrichment: false,
                exclusions: vec![],
                include_hidden: false,
                max_file_size_mb: 64,
            }],
            true,
        )
        .unwrap();
    eventually(|| runtime.work.completed.lock().unwrap().len() == 40);
    let candidates = runtime
        .work
        .metrics
        .selection_candidates
        .load(Ordering::Relaxed);
    assert!(
        candidates <= 40 * 3,
        "40successful jobs must not examine the triangular820 pending candidates, observed{candidates}"
    );
    eventually(|| runtime.snapshot().phase == "ready");
    let status_candidates = runtime
        .work
        .metrics
        .status_retry_candidates
        .load(Ordering::Relaxed);
    assert_eq!(
        status_candidates, 0,
        "status must not traverse pending entries after each successful job"
    );
    let status = runtime.snapshot();
    assert_eq!(status.pending_items, 0);
    assert_eq!(status.skipped_items, 0);
    assert_eq!(status.indexed_items, 40);
    runtime.stop_index_worker();
    drop(runtime);
}

#[test]
fn complete_reconciliation_clears_truncation_without_sticky_watcher_failure() {
    let base = owned_base("cap-recovery");
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    for name in ["a.txt", "b.txt", "c.txt", "z.txt"] {
        fs::write(root.join(name), b"boundedquasar").unwrap();
    }
    let runtime = IndexRuntime::open(
        &base.join("index.sqlite"),
        Path::new("missing-vector.dll"),
        true,
    )
    .unwrap();
    // Small deterministic fault fixture only; acceptance workloads leave this hook at zero.
    runtime.work.traversal_limit.store(3, Ordering::SeqCst);
    runtime
        .configure_roots(
            vec![IndexRootRequest {
                path: root.to_string_lossy().into_owned(),
                cloud_enrichment: false,
                exclusions: vec![],
                include_hidden: false,
                max_file_size_mb: 64,
            }],
            true,
        )
        .unwrap();
    eventually(|| {
        runtime.work.inventory_incomplete.load(Ordering::SeqCst)
            && runtime.work.completed.lock().unwrap().len() == 3
    });
    assert_eq!(runtime.snapshot().phase, "degraded");
    fs::remove_file(root.join("z.txt")).unwrap();
    runtime.work.periodic_due.store(true, Ordering::SeqCst);
    runtime.worker.as_ref().unwrap().wake();
    eventually(|| !runtime.work.inventory_incomplete.load(Ordering::SeqCst));
    assert_eq!(
        runtime.snapshot().phase,
        "ready",
        "complete inventory must not manufacture a permanent watcher failure"
    );
    runtime.stop_index_worker();
    drop(runtime);
}

#[test]
fn a_long_directory_reconciliation_anchors_the_periodic_deadline() {
    let base = owned_base("periodic-anchor");
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("notes.txt"), b"anchorquasar").unwrap();
    let runtime = IndexRuntime::open(
        &base.join("index.sqlite"),
        Path::new("missing-vector.dll"),
        true,
    )
    .unwrap();
    runtime
        .configure_roots(
            vec![IndexRootRequest {
                path: root.to_string_lossy().into_owned(),
                cloud_enrichment: false,
                exclusions: vec![],
                include_hidden: false,
                max_file_size_mb: 64,
            }],
            true,
        )
        .unwrap();
    eventually(|| runtime.work.completed.lock().unwrap().len() == 1);
    std::thread::sleep(Duration::from_millis(250));
    let first = runtime.work.metrics.scans.load(Ordering::SeqCst);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let held = std::sync::atomic::AtomicBool::new(false);
    *runtime.work.path_refresh_gate.lock().unwrap() = Some(Arc::new(move |directory, entering| {
        if entering && !held.swap(true, Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(31));
        }
        if directory && !entering {
            let _ = done_tx.send(());
        }
    }));
    fs::create_dir(root.join("new-directory")).unwrap();
    done_rx.recv_timeout(Duration::from_secs(45)).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        runtime.work.metrics.scans.load(Ordering::SeqCst),
        first + 1,
        "a just-completed directory reconciliation must not immediately trigger another periodic scan"
    );
    *runtime.work.path_refresh_gate.lock().unwrap() = None;
    runtime.stop_index_worker();
    drop(runtime);
}

#[test]
fn sqlite_full_native_inventory_and_content_recover_on_same_connection() {
    for lane in ["inventory", "content"] {
        let base = owned_base(&format!("full-{lane}"));
        let root = base.join("root");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("retained-a.txt"),
            b"retainedquasar authoritative a",
        )
        .unwrap();
        fs::write(
            root.join("retained-b.txt"),
            b"retainednebula authoritative b",
        )
        .unwrap();
        let db = base.join("index.sqlite");
        let runtime = IndexRuntime::open(&db, Path::new("missing-vector.dll"), true).unwrap();
        let roots = vec![IndexRootRequest {
            path: root.to_string_lossy().into_owned(),
            cloud_enrichment: false,
            exclusions: vec![],
            include_hidden: false,
            max_file_size_mb: 64,
        }];
        runtime.configure_roots(roots, true).unwrap();
        eventually(|| runtime.work.completed.lock().unwrap().len() == 2);
        let stable = query(&runtime, "retained-a.txt", &[]).items[0]
            .hit
            .stable_id
            .clone();
        runtime.database.set_pinned(&stable, true).unwrap();
        runtime.database.record_file_open(&stable).unwrap();
        runtime
            .database
            .record_user_query("retainedquasar", true)
            .unwrap();
        runtime.set_content_enabled(false);
        if lane == "inventory" {
            constrain(&runtime);
            // Real long filenames force inventory B-tree/metadata allocation, never SQL seeds.
            for i in 0..80 {
                fs::write(
                    root.join(format!("growth-{i:03}-{}.txt", "m".repeat(160))),
                    b"growthbody",
                )
                .unwrap();
            }
        } else {
            fs::write(
                root.join("growth-content.txt"),
                "allocatedquasar ".repeat(80_000),
            )
            .unwrap();
            eventually(|| {
                runtime
                    .work
                    .pending
                    .lock()
                    .unwrap()
                    .values()
                    .any(|p| p.path.ends_with("growth-content.txt"))
            });
            constrain(&runtime);
            runtime.set_content_enabled(true);
        }
        eventually(|| {
            runtime
                .work
                .metrics
                .errors
                .lock()
                .unwrap()
                .iter()
                .any(|(at, code)| at == lane && code == "Some(DiskFull)")
        });
        if lane == "content" {
            assert!(
                runtime
                    .work
                    .pending
                    .lock()
                    .unwrap()
                    .values()
                    .any(|job| job.path.ends_with("growth-content.txt"))
            );
            assert!(
                !runtime
                    .work
                    .completed
                    .lock()
                    .unwrap()
                    .contains_key(&stable_id(
                        &fs::canonicalize(&root).unwrap(),
                        &fs::canonicalize(root.join("growth-content.txt")).unwrap()
                    ))
            );
        }
        runtime.set_content_enabled(false);
        assert_eq!(
            query(&runtime, "retainedquasar", &[]).items[0]
                .hit
                .stable_id,
            stable
        );
        assert_eq!(query(&runtime, "retainednebula", &[]).items.len(), 1);
        assert!(query(&runtime, "allocatedquasar", &[]).items.is_empty());
        assert!(query(&runtime, "retained-a.txt", &[]).items[0].pinned);
        assert_eq!(runtime.database.history_status().unwrap().entry_count, 2);
        check_database(&runtime);
        println!(
            "TASK13 actual lane={lane} SQLITE_FULL retained_authoritative=true errors={:?}",
            runtime.work.metrics.errors.lock().unwrap()
        );
        runtime.database.inspect_connection(|c| {
            c.pragma_update(None, "max_page_count", 1_073_741_823_i64)
                .unwrap();
        });
        runtime.set_content_enabled(true);
        eventually(|| {
            runtime.work.metrics.commits.load(Ordering::SeqCst)
                >= if lane == "inventory" { 82 } else { 3 }
                && runtime.work.pending.lock().unwrap().is_empty()
        });
        if lane == "content" {
            assert_eq!(query(&runtime, "allocatedquasar", &[]).items.len(), 1);
        }
        check_database(&runtime);
        runtime.stop_index_worker();
        drop(runtime);
        let reopened = IndexRuntime::open(&db, Path::new("missing-vector.dll"), true).unwrap();
        check_database(&reopened);
        assert_eq!(
            query(&reopened, "retainedquasar", &[]).items[0]
                .hit
                .stable_id,
            stable
        );
        assert_eq!(reopened.database.history_status().unwrap().entry_count, 2);
        assert_eq!(
            reopened.database.recent_hits("", 5).unwrap()[0].stable_id,
            stable
        );
        reopened.stop_index_worker();
        drop(reopened);
        println!(
            "TASK13 {lane} retry/reopen/integrity/FK/teardown succeeded; owned fixture {}",
            base.display()
        );
    }
}

#[test]
#[ignore = "owned D-drive capacity; run explicitly with LUMEN_TASK13_FILES=1000,50000,249750"]
fn native_filesystem_capacity() {
    let files: usize = std::env::var("LUMEN_TASK13_FILES")
        .expect("explicit corpus size")
        .parse()
        .unwrap();
    assert!([1_000, 50_000, 249_750].contains(&files));
    let parent = Path::new("D:/CodexBuilds/Lumen/task13-owned");
    fs::create_dir_all(parent).unwrap();
    for ancestor in parent.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).unwrap();
        assert!(!metadata.file_type().is_symlink());
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(
                metadata.file_attributes() & 0x400,
                0,
                "reparse ancestor refused"
            );
        }
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = parent.join(format!("capacity-{files}-{}-{nonce}", std::process::id()));
    fs::create_dir(&base).unwrap();
    fs::write(
        base.join("TASK13-OWNED"),
        b"synthetic task13 corpus; never ordinary index",
    )
    .unwrap();
    let output = base.join("events.jsonl");
    emit(
        &output,
        json!({"phase":"ownership","base":base,"pid":std::process::id(),"executable":std::env::current_exe().unwrap(),"profile":if cfg!(debug_assertions){"debug"}else{"release"},"files":files,"content_bytes_each":96,"os_cache_flushed":false}),
    );
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    let shards = files.div_ceil(1000);
    let mut bytes = 0;
    for shard in 0..shards {
        fs::create_dir(root.join(format!("shard-{shard:03}"))).unwrap();
    }
    for i in 0..files {
        let mut text = format!(
            "commonbody unique{i:06} {} ",
            if i == 0 { "sparsequasar" } else { "ordinary" }
        );
        text.extend(std::iter::repeat_n('x', 96 - text.len()));
        bytes += text.len();
        fs::write(
            root.join(format!("shard-{:03}/document-{i:06}.txt", i / 1000)),
            text,
        )
        .unwrap();
        if (i + 1) % 10000 == 0 {
            emit(&output, json!({"phase":"corpus_creation","created":i+1}));
        }
    }
    let beyond = root.join("shard-000/zzzz-beyond-cap.txt");
    if files == 249_750 {
        fs::write(&beyond, b"beyondcapquasar").unwrap();
    }
    // Excluded entries are manifest canaries and never count toward accepted-record capacity.
    fs::create_dir(root.join("node_modules")).unwrap();
    fs::write(root.join("node_modules/excluded.txt"), b"excludedcanary").unwrap();
    emit(
        &output,
        json!({"phase":"corpus_complete","files":files,"accepted_directories":shards,"expected_first_pass_records":files+shards,"extra_beyond_cap_files":usize::from(files==249_750),"bytes":bytes,"excluded_files":1,"excluded_directories":1}),
    );
    let db = base.join("index.sqlite");
    let clock = Instant::now();
    let runtime = IndexRuntime::open(&db, Path::new("task13-no-vector.dll"), true).unwrap();
    if std::env::var("LUMEN_TASK13_ATTRIBUTION_ONLY").as_deref() == Ok("1") {
        observe_sql(&runtime);
    }
    emit(
        &output,
        json!({"phase":"open","ms":clock.elapsed().as_secs_f64()*1000.0}),
    );
    let roots = vec![IndexRootRequest {
        path: root.to_string_lossy().into_owned(),
        cloud_enrichment: false,
        exclusions: vec![],
        include_hidden: false,
        max_file_size_mb: 64,
    }];
    let clock = Instant::now();
    runtime.configure_roots(roots.clone(), false).unwrap();
    emit(
        &output,
        json!({"phase":"admit","ms":clock.elapsed().as_secs_f64()*1000.0}),
    );
    let inventory_probed = std::cell::Cell::new(false);
    let inventory = wait_for(
        &runtime,
        &output,
        "inventory",
        Duration::from_secs(7200),
        || {
            if !inventory_probed.get()
                && runtime.work.metrics.metadata_records.load(Ordering::SeqCst)
                    >= (files / 2) as u64
            {
                let clock = Instant::now();
                assert_eq!(query(&runtime, "document-000000.txt", &[]).items.len(), 1);
                emit(
                    &output,
                    json!({"phase":"query_during_metadata_application","ms":clock.elapsed().as_secs_f64()*1000.0,"inventory_running":runtime.work.inventory_running.load(Ordering::SeqCst),"metadata_records":runtime.work.metrics.metadata_records.load(Ordering::SeqCst)}),
                );
                inventory_probed.set(true);
            }
            runtime.work.metrics.scans_done.load(Ordering::SeqCst) > 0
                && !runtime.work.inventory_running.load(Ordering::SeqCst)
        },
    );
    assert_eq!(
        runtime.database.counts().unwrap().0,
        (files + shards) as u64
    );
    assert_eq!(runtime.work.pending.lock().unwrap().len(), files);
    assert_eq!(runtime.work.traversal_limit.load(Ordering::SeqCst), 0);
    assert_eq!(
        runtime.work.inventory_incomplete.load(Ordering::SeqCst),
        files == 249_750
    );
    assert!(query(&runtime, "zzzz-beyond-cap.txt", &[]).items.is_empty());
    assert_eq!(
        query(&runtime, "document-000000.txt", &[]).items[0].match_source,
        "filename"
    );
    assert!(query(&runtime, "sparsequasar", &[]).items.is_empty());
    emit(
        &output,
        json!({"phase":"inventory_complete","ms":inventory.as_secs_f64()*1000.0,"status":runtime.snapshot(),"metrics":runtime.work.metrics.snapshot()}),
    );
    runtime.set_content_enabled(true);
    if std::env::var("LUMEN_TASK13_ATTRIBUTION_ONLY").as_deref() == Ok("1") {
        let first = wait_for(
            &runtime,
            &output,
            "maintenance_before_first_content_incomplete",
            Duration::from_secs(1800),
            || runtime.work.metrics.commits.load(Ordering::SeqCst) > 0,
        );
        emit(
            &output,
            json!({"phase":"first_content_after_maintenance_incomplete","wait_ms":first.as_secs_f64()*1000.0,"sql_vm_work":sql_work(),"capacity_pass":false}),
        );
        let clock = Instant::now();
        let observed = wait_for(
            &runtime,
            &output,
            "content_attribution_incomplete",
            Duration::from_secs(60),
            || clock.elapsed() >= Duration::from_secs(15),
        );
        emit(
            &output,
            json!({"phase":"incomplete_attribution_only","elapsed_ms":observed.as_secs_f64()*1000.0,"metrics":runtime.work.metrics.snapshot(),"status":runtime.snapshot(),"sql_vm_work":sql_work(),"capacity_pass":false}),
        );
        runtime.stop_index_worker();
        drop(runtime);
        emit(
            &output,
            json!({"phase":"incomplete_attribution_teardown_joined","capacity_pass":false}),
        );
        panic!("Task13 attribution sample deliberately incomplete; no capacity pass");
    }
    let content = wait_for(
        &runtime,
        &output,
        "content",
        Duration::from_secs(14400),
        || {
            runtime.work.pending.lock().unwrap().is_empty()
                && runtime.work.metrics.commits.load(Ordering::SeqCst) >= files as u64
        },
    );
    assert!(runtime.work.failed.lock().unwrap().is_empty());
    assert_eq!(runtime.database.counts().unwrap().1, 0);
    let pinned = query(&runtime, "document-000000.txt", &[]).items[0]
        .hit
        .stable_id
        .clone();
    assert!(runtime.database.set_pinned(&pinned, true).unwrap());
    assert!(runtime.database.record_file_open(&pinned).unwrap());
    emit(
        &output,
        json!({"phase":"content_complete","ms":content.as_secs_f64()*1000.0,"status":runtime.snapshot(),"metrics":runtime.work.metrics.snapshot()}),
    );
    if files == 249_750 {
        assert_eq!(runtime.snapshot().phase, "degraded");
        fs::remove_file(&beyond).unwrap();
        let cleared = wait_for(
            &runtime,
            &output,
            "cap_recovery",
            Duration::from_secs(7200),
            || {
                !runtime.work.inventory_incomplete.load(Ordering::SeqCst)
                    && !runtime.work.inventory_running.load(Ordering::SeqCst)
                    && runtime.snapshot().phase == "ready"
            },
        );
        assert_eq!(runtime.snapshot().phase, "ready");
        assert_eq!(runtime.database.counts().unwrap().0, 250_000);
        emit(
            &output,
            json!({"phase":"cap_recovered","ms":cleared.as_secs_f64()*1000.0,"accepted_records":250000,"status":runtime.snapshot()}),
        );
    }
    for (name, term, filtered) in [
        ("exact_filename", "document-000000.txt", false),
        ("sparse_content", "sparsequasar", false),
        ("no_match", "missingnebula", false),
        ("common_limit5", "commonbody", false),
        ("extension_filter", "commonbody", true),
    ] {
        let filters = if filtered {
            vec![SearchFilterRequest {
                id: "extension".into(),
                value: "txt".into(),
            }]
        } else {
            vec![]
        };
        let before = runtime.work.metrics.scans.load(Ordering::SeqCst);
        let mut samples = Vec::new();
        for sample in 0..31 {
            let clock = Instant::now();
            let result = query(&runtime, term, &filters);
            let elapsed = clock.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(result.semantic.phase, SemanticPhase::Disabled);
            match name {
                "exact_filename" => {
                    assert_eq!(result.items.len(), 1);
                    assert_eq!(result.items[0].hit.stable_id, pinned);
                    assert_eq!(result.items[0].match_source, "filename");
                }
                "sparse_content" => {
                    assert_eq!(result.items.len(), 1);
                    assert_eq!(result.items[0].hit.stable_id, pinned);
                    assert_eq!(result.items[0].match_source, "content");
                    assert!(result.items[0].hit.snippet.contains("sparsequasar"));
                }
                "no_match" => assert!(result.items.is_empty()),
                _ => assert_eq!(result.items.len(), 5),
            }
            if sample == 0 {
                emit(
                    &output,
                    json!({"phase":"first_query","workload":name,"ms":elapsed}),
                );
            } else {
                samples.push(elapsed);
            }
        }
        let mut ordered = samples.clone();
        ordered.sort_by(f64::total_cmp);
        emit(
            &output,
            json!({"phase":"warm_queries","workload":name,"raw_ms":samples,"p50_ms":ordered[14],"p95_ms":ordered[28],"percentile":"nearest-rank ceil(q*N)-1 N=30","scan_delta_including_maintenance":runtime.work.metrics.scans.load(Ordering::SeqCst)-before,"query_thread":format!("{:?}",std::thread::current().id()),"metrics":runtime.work.metrics.snapshot()}),
        );
    }
    watcher_changes(&runtime, &root, files, &output);
    check_database(&runtime);
    emit(&output, json!({"phase":"settled_start","seconds":35}));
    std::thread::sleep(Duration::from_secs(35));
    emit(
        &output,
        json!({"phase":"settled_complete","metrics":runtime.work.metrics.snapshot()}),
    );
    let clock = Instant::now();
    runtime.stop_index_worker();
    emit(
        &output,
        json!({"phase":"stop_admission","ms":clock.elapsed().as_secs_f64()*1000.0}),
    );
    let clock = Instant::now();
    drop(runtime);
    emit(
        &output,
        json!({"phase":"teardown_joined","ms":clock.elapsed().as_secs_f64()*1000.0}),
    );
    let clock = Instant::now();
    let reopened = IndexRuntime::open(&db, Path::new("task13-no-vector.dll"), true).unwrap();
    assert_eq!(
        reopened.database.counts().unwrap().0,
        (files + shards - 1) as u64
    );
    assert_eq!(
        query(&reopened, "sparsequasar", &[]).items[0].hit.stable_id,
        pinned
    );
    assert_eq!(
        reopened.database.recent_hits("", 5).unwrap()[0].stable_id,
        pinned
    );
    assert!(query(&reopened, "document-000000.txt", &[]).items[0].pinned);
    check_database(&reopened);
    emit(
        &output,
        json!({"phase":"reopen_unadmitted","ms":clock.elapsed().as_secs_f64()*1000.0,"scans":reopened.work.metrics.snapshot()}),
    );
    reopened.configure_roots(roots.clone(), false).unwrap();
    let admission = wait_for(
        &reopened,
        &output,
        "reopen_inventory",
        Duration::from_secs(7200),
        || reopened.work.metrics.scans_done.load(Ordering::SeqCst) > 0,
    );
    assert_eq!(
        reopened.database.counts().unwrap().0,
        (files + shards - 1) as u64
    );
    check_database(&reopened);
    emit(
        &output,
        json!({"phase":"reopen_readmitted_inventory","ms":admission.as_secs_f64()*1000.0,"pending_content":reopened.work.pending.lock().unwrap().len()}),
    );
    reopened.set_content_enabled(true);
    let recontent = wait_for(
        &reopened,
        &output,
        "reopen_content",
        Duration::from_secs(14400),
        || {
            reopened.work.pending.lock().unwrap().is_empty()
                && reopened.work.metrics.commits.load(Ordering::SeqCst) >= (files - 1) as u64
        },
    );
    check_database(&reopened);
    assert_eq!(
        query(&reopened, "sparsequasar", &[]).items[0].hit.stable_id,
        pinned
    );
    emit(
        &output,
        json!({"phase":"reopen_content_complete","ms":recontent.as_secs_f64()*1000.0,"metrics":reopened.work.metrics.snapshot()}),
    );
    reopened.stop_index_worker();
    drop(reopened);
    cancellation(&root, &base, roots, &output);
    assert_eq!(
        fs::read(root.join("node_modules/excluded.txt")).unwrap(),
        b"excludedcanary"
    );
    emit(
        &output,
        json!({"phase":"complete","corpus_preserved":true,"teardown_joined":true,"database_bytes":fs::metadata(&db).unwrap().len()}),
    );
}
