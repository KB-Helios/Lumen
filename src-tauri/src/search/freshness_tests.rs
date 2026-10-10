use super::*;
use crate::search::test_support::SearchFixture;
use std::sync::mpsc;
use std::time::Duration;

#[cfg(windows)]
fn short_windows_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;
    use windows::core::PCWSTR;

    let input: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut output = vec![0u16; 32_768];
    let length = unsafe { GetShortPathNameW(PCWSTR(input.as_ptr()), Some(&mut output)) } as usize;
    assert!(length > 0 && length < output.len());
    PathBuf::from(std::ffi::OsString::from_wide(&output[..length]))
}

#[cfg(windows)]
#[test]
fn watcher_path_admission_expands_short_ancestors_for_deleted_paths() {
    let root = std::fs::canonicalize(std::env::var_os("ProgramFiles").unwrap()).unwrap();
    let short = short_windows_path(&root);
    assert_ne!(
        short, root,
        "short-alias fixture unavailable: ProgramFiles has no distinct 8.3 alias"
    );
    assert_eq!(index_worker::event_path(&root, &short), Some(root.clone()));
    let relative = Path::new("lumen-missing-event-fixture").join("İstanbul.txt");
    assert_eq!(
        index_worker::event_path(&root, &short.join(&relative)),
        Some(root.join(&relative))
    );
    assert_eq!(
        index_worker::event_path(&root, &short.join("..").join("outside.txt")),
        None
    );
}

#[cfg(windows)]
#[test]
fn watcher_path_admission_preserves_nested_verbatim_components() {
    let root = Path::new(r"\\?\C:\safe");
    assert_eq!(
        index_worker::event_path(root, Path::new(r"C:\safe\folder\İstanbul.txt")),
        Some(root.join("folder").join("İstanbul.txt"))
    );
}

#[cfg(windows)]
#[test]
fn watcher_short_path_expansion_never_admits_a_reparse_route() {
    let fixture = SearchFixture::new("short-path-reparse");
    fixture.file("notes.txt", b"privatequasar");
    let outside = fixture.outside_file("placeholder.txt", b"outside");
    let linked = outside.parent().unwrap().join("redirect");
    std::os::windows::fs::symlink_dir(fixture.root(), &linked).unwrap();
    let short_outside = short_windows_path(outside.parent().unwrap());
    let root = std::fs::canonicalize(fixture.root()).unwrap();
    assert_eq!(
        index_worker::event_path(&root, &short_outside.join("redirect").join("notes.txt")),
        None
    );
}

#[cfg(windows)]
#[test]
fn watcher_path_admission_handles_drive_roots_unc_and_unicode() {
    assert_eq!(
        index_worker::event_path(Path::new(r"\\?\C:\"), Path::new(r"C:\notes.txt")),
        Some(PathBuf::from(r"\\?\C:\notes.txt"))
    );
    assert_eq!(
        index_worker::event_path(
            Path::new(r"\\?\UNC\server\share"),
            Path::new(r"\\server\share\notes.txt")
        ),
        Some(PathBuf::from(r"\\?\UNC\server\share\notes.txt"))
    );
    assert_eq!(
        index_worker::event_path(Path::new(r"C:\İnbox"), Path::new(r"C:\İnbox\İstanbul.txt")),
        Some(PathBuf::from(r"C:\İnbox\İstanbul.txt"))
    );
    assert_eq!(
        index_worker::event_path(Path::new(r"C:\safe"), Path::new(r"C:\safe2\outside.txt")),
        None
    );
}

fn setup(label: &str) -> (SearchFixture, IndexRuntime, Vec<IndexRootRequest>) {
    let fixture = SearchFixture::new(label);
    let runtime = IndexRuntime::open(
        &fixture.root().parent().unwrap().join("index.sqlite"),
        Path::new("missing-vector.dll"),
        true,
    )
    .unwrap();
    let roots = vec![IndexRootRequest {
        path: fixture.root().to_string_lossy().into_owned(),
        cloud_enrichment: false,
        exclusions: vec!["private".into()],
        include_hidden: false,
        max_file_size_mb: 256,
    }];
    (fixture, runtime, roots)
}

fn manual_setup(label: &str) -> (SearchFixture, IndexRuntime, Vec<IndexRootRequest>) {
    let (fixture, mut runtime, roots) = setup(label);
    drop(runtime.worker.take());
    runtime.work.stop.store(false, Ordering::SeqCst);
    (fixture, runtime, roots)
}

fn reopened_worker_preserves_unadmitted_policy(empty_policy: bool) {
    let (fixture, runtime, roots) = manual_setup("unadmitted-reopen");
    let path = fixture.file("saved.txt", b"savedquasar");
    admit(&runtime, roots.clone(), true);
    runtime.reconcile_inventory(false).unwrap();
    runtime.extract_pending().unwrap();
    let id = runtime
        .database
        .stable_id_for_path(&std::fs::canonicalize(path).unwrap())
        .unwrap()
        .unwrap();
    runtime.database.set_pinned(&id, true).unwrap();
    runtime.database.record_file_open(&id).unwrap();
    runtime
        .database
        .record_user_query("savedquasar", true)
        .unwrap();
    let db_path = runtime.owned_database_path.as_ref().clone();
    drop(runtime);
    let runtime = IndexRuntime::open(&db_path, Path::new("missing-vector.dll"), true).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let stage = std::sync::atomic::AtomicU64::new(0);
    *runtime.work.inventory_cycle_gate.lock().unwrap() = Some(Arc::new(move |_, before| {
        if before
            && stage
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            entered_tx.send(()).unwrap();
            let _ = release_rx.lock().unwrap().recv();
        } else if !before
            && stage
                .compare_exchange(1, 2, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            done_tx.send(()).unwrap();
        }
    }));
    runtime.worker.as_ref().unwrap().wake();
    entered_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    assert!(!runtime.work.configured.load(Ordering::SeqCst));
    runtime.work.periodic_due.store(true, Ordering::SeqCst);
    assert!(runtime.worker.as_ref().unwrap().overflow_for_test() > 0);
    release_tx.send(()).unwrap();
    done_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    assert_eq!(
        runtime.database.counts().unwrap().0,
        1,
        "unadmitted periodic work must preserve saved rows"
    );
    assert_eq!(runtime.database.search("savedquasar", 10).unwrap().len(), 1);
    assert!(runtime.database.ranking_signals(&id).unwrap().1);
    assert_eq!(runtime.database.history_status().unwrap().entry_count, 2);
    assert!(runtime.work.pending.lock().unwrap().is_empty());
    if empty_policy {
        admit(&runtime, Vec::new(), false);
        assert_eq!(runtime.database.counts().unwrap().0, 0);
        assert!(
            runtime
                .database
                .search("savedquasar", 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(runtime.database.history_status().unwrap().entry_count, 1);
    } else {
        admit(&runtime, roots, false);
        eventually(
            "deferred overflow forces content refresh after paused admission",
            || {
                !runtime.work.pending.lock().unwrap().is_empty()
                    && runtime
                        .database
                        .search("savedquasar", 10)
                        .unwrap()
                        .is_empty()
            },
        );
        assert!(runtime.database.ranking_signals(&id).unwrap().1);
        assert_eq!(runtime.database.history_status().unwrap().entry_count, 2);
        runtime.set_content_enabled(true);
        eventually("admitted content resumes", || {
            runtime.database.search("savedquasar", 10).unwrap().len() == 1
        });
    }
}

#[test]
fn reopened_periodic_worker_preserves_saved_rows_until_paused_policy_admission() {
    reopened_worker_preserves_unadmitted_policy(false);
}

#[test]
fn reopened_periodic_worker_distinguishes_uninitialized_from_admitted_empty_policy() {
    reopened_worker_preserves_unadmitted_policy(true);
}

#[test]
fn native_inventory_boundary_recovers_invalid_metadata_and_defers_stop() {
    let (fixture, runtime, mut roots) = manual_setup("failed-admission-stop");
    let path = fixture.file("saved.txt", b"savedquasar");
    admit(&runtime, roots.clone(), true);
    runtime.reconcile_inventory(false).unwrap();
    runtime.extract_pending().unwrap();
    let connection = rusqlite::Connection::open(runtime.owned_database_path.as_ref()).unwrap();
    let metadata: String = connection
        .query_row("SELECT metadata FROM file_inventory", [], |row| row.get(0))
        .unwrap();
    connection
        .execute("UPDATE file_inventory SET metadata = 'invalid'", [])
        .unwrap();
    roots[0].include_hidden = true;
    assert!(
        runtime.database.policy_inventory().unwrap()[0]
            .metadata
            .is_none()
    );
    runtime.configure_roots(roots.clone(), false).unwrap();
    assert!(runtime.work.configured.load(Ordering::SeqCst));
    assert_eq!(runtime.database.search("savedquasar", 10).unwrap().len(), 1);
    connection
        .execute("UPDATE file_inventory SET metadata = ?1", [metadata])
        .unwrap();
    admit(&runtime, roots, false);
    runtime.work.stop.store(true, Ordering::SeqCst);
    std::fs::remove_file(&path).unwrap();
    assert!(!runtime.reconcile_inventory(false).unwrap());
    assert!(!runtime.refresh_paths(vec![path]).unwrap());
    assert_eq!(runtime.database.search("savedquasar", 10).unwrap().len(), 1);
    runtime.work.stop.store(false, Ordering::SeqCst);
    assert!(runtime.reconcile_inventory(false).unwrap());
    assert_eq!(runtime.database.counts().unwrap().0, 0);
}

fn controlled_directory_refresh_generation_change(after_reconcile: bool) {
    let (fixture, runtime, mut roots) = manual_setup("mixed-refresh-generation");
    let path = fixture.file("saved.txt", b"firstquasar");
    admit(&runtime, roots.clone(), true);
    runtime.reconcile_inventory(false).unwrap();
    runtime.extract_pending().unwrap();
    runtime.set_content_enabled(false);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"nextnebulaa").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    *runtime.work.path_refresh_gate.lock().unwrap() = Some(Arc::new(move |delegated, before| {
        if (after_reconcile && delegated && !before) || (!after_reconcile && !delegated && before) {
            entered_tx.send(()).unwrap();
            let _ = release_rx.lock().unwrap().recv();
        }
    }));
    let batch = if after_reconcile {
        vec![fixture.root().to_path_buf()]
    } else {
        vec![fixture.root().to_path_buf(), path.clone()]
    };
    let original_generation = runtime.current_generation();
    let refresh_runtime = runtime.clone();
    let refresh_batch = batch.clone();
    let refresh = std::thread::spawn(move || refresh_runtime.refresh_paths(refresh_batch));
    entered_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    roots[0].include_hidden = true;
    admit(&runtime, roots, false);
    assert!(runtime.current_generation() > original_generation);
    release_tx.send(()).unwrap();
    let completed = refresh.join().unwrap().unwrap();
    *runtime.work.path_refresh_gate.lock().unwrap() = None;
    assert!(
        !completed,
        "a directory pass must not complete the original generation's deferred batch"
    );
    assert_eq!(runtime.database.search("firstquasar", 10).unwrap().len(), 1);
    // The worker keeps a false-completion batch dirty; exercise that same real retry.
    let retry = if after_reconcile {
        vec![fixture.root().to_path_buf(), path]
    } else {
        batch
    };
    assert!(runtime.refresh_paths(retry).unwrap());
    assert!(
        runtime
            .database
            .search("firstquasar", 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(runtime.work.pending.lock().unwrap().len(), 1);
    runtime.set_content_enabled(true);
    runtime.extract_pending().unwrap();
    assert_eq!(runtime.database.search("nextnebulaa", 10).unwrap().len(), 1);
}

#[test]
fn mixed_directory_file_batch_defers_when_generation_changes_before_file_admission() {
    controlled_directory_refresh_generation_change(false);
}

#[test]
fn directory_batch_defers_when_generation_changes_after_delegated_reconciliation() {
    controlled_directory_refresh_generation_change(true);
}

#[test]
fn metadata_outcome_reports_changed_revision_and_file_to_folder_drops_body() {
    let (fixture, runtime, _) = manual_setup("metadata-outcomes");
    let path = fixture.file("notes.txt", b"oldquasar");
    assert!(matches!(
        runtime
            .database
            .upsert_metadata(fixture.root(), "id", &path, "one")
            .unwrap(),
        super::super::index::UpsertOutcome::Updated { revision: 1 }
    ));
    assert!(matches!(
        runtime
            .database
            .upsert_metadata(fixture.root(), "id", &path, "one")
            .unwrap(),
        super::super::index::UpsertOutcome::Unchanged { revision: 1 }
    ));
    std::fs::write(&path, b"changedlonger").unwrap();
    assert!(matches!(
        runtime
            .database
            .upsert_metadata(fixture.root(), "id", &path, "two")
            .unwrap(),
        super::super::index::UpsertOutcome::Updated { revision: 2 }
    ));
    runtime
        .database
        .upsert_document(
            fixture.root(),
            &IndexedDocument {
                stable_id: "id".into(),
                path: path.clone(),
                content_hash: "body".into(),
                extraction_version: "text-v1".into(),
                chunks: vec![super::super::index::IndexedChunk {
                    text: "oldquasar".into(),
                    extraction_kind: "text".into(),
                    page: None,
                    time_start_ms: None,
                    time_end_ms: None,
                }],
            },
        )
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    runtime
        .database
        .upsert_metadata(fixture.root(), "id", &path, "folder")
        .unwrap();
    assert!(runtime.database.search("oldquasar", 10).unwrap().is_empty());
    assert_eq!(
        runtime
            .database
            .inventory_record("id")
            .unwrap()
            .unwrap()
            .kind,
        FileKind::Folder
    );
}

#[test]
fn directory_events_preserve_existing_body_and_enrichment() {
    let (fixture, runtime, mut roots) = manual_setup("directory-metadata-events");
    let path = fixture.file("notes.txt", b"keepquasar");
    let outside = fixture.outside_file("other-root/other.txt", b"otherquasar");
    roots.push(IndexRootRequest {
        path: outside.parent().unwrap().to_string_lossy().into_owned(),
        ..roots[0].clone()
    });
    admit(&runtime, roots, true);
    runtime.reconcile_inventory(false).unwrap();
    runtime.extract_pending().unwrap();
    runtime.extract_pending().unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();
    let id = stable_id(&std::fs::canonicalize(fixture.root()).unwrap(), &canonical);
    runtime
        .database
        .enqueue_enrichment(&id, "ocr", "lumen.vision.cloud")
        .unwrap();
    let before = runtime.database.counts().unwrap();
    let directory = fixture.root().join("new-folder");
    std::fs::create_dir(&directory).unwrap();
    runtime.refresh_paths(vec![directory.clone()]).unwrap();
    assert!(
        !runtime
            .database
            .search("keepquasar", 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(runtime.database.counts().unwrap().1, before.1);
    assert!(
        !runtime
            .database
            .search("otherquasar", 10)
            .unwrap()
            .is_empty()
    );
    #[cfg(windows)]
    {
        let linked = fixture.root().join("linked-directory");
        std::os::windows::fs::symlink_dir(outside.parent().unwrap(), &linked).unwrap();
        runtime.refresh_paths(vec![linked]).unwrap();
        assert!(
            !runtime
                .database
                .search("keepquasar", 10)
                .unwrap()
                .is_empty()
        );
        assert!(
            !runtime
                .database
                .search("otherquasar", 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(runtime.database.counts().unwrap().1, before.1);
    }
    let renamed = fixture.root().join("renamed-folder");
    std::fs::rename(&directory, &renamed).unwrap();
    runtime.refresh_paths(vec![directory, renamed]).unwrap();
    assert!(
        !runtime
            .database
            .search("keepquasar", 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(runtime.database.counts().unwrap().1, before.1);
}

#[test]
fn permanent_invalid_utf8_has_bounded_retries_and_truthful_metadata_only_state() {
    let (fixture, runtime, roots) = manual_setup("terminal-extraction");
    let path = fixture.file("broken.txt", &[0xff, 0xfe, 0xff]);
    admit(&runtime, roots, true);
    runtime.reconcile_inventory(false).unwrap();
    for attempt in 1..=6 {
        for pending in runtime.work.pending.lock().unwrap().values_mut() {
            pending.retry_at = Instant::now();
        }
        runtime.extract_pending().unwrap();
        assert_eq!(runtime.snapshot().skipped_items, 1);
        if attempt < 3 {
            let pending = runtime.work.pending.lock().unwrap();
            let job = pending.values().next().unwrap();
            assert_eq!(job.attempts, attempt);
            assert!(
                job.retry_at.duration_since(Instant::now())
                    > Duration::from_secs(if attempt == 1 { 4 } else { 9 })
            );
        }
    }
    assert!(
        runtime.work.pending.lock().unwrap().is_empty(),
        "permanent failure must reach a terminal signature"
    );
    assert_eq!(runtime.snapshot().phase, "degraded");
    assert_eq!(runtime.snapshot().skipped_items, 1);
    runtime.reconcile_inventory(false).unwrap();
    assert!(runtime.work.pending.lock().unwrap().is_empty());
    runtime.refresh_paths(vec![path.clone()]).unwrap();
    assert_eq!(
        runtime.work.pending.lock().unwrap().len(),
        1,
        "explicit dirty refresh retries a terminal signature"
    );
    runtime.extract_pending().unwrap();
    std::fs::write(&path, b"repairedquasar").unwrap();
    runtime.reconcile_inventory(false).unwrap();
    runtime.extract_pending().unwrap();
    assert!(
        !runtime
            .database
            .search("repairedquasar", 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(runtime.snapshot().skipped_items, 0);
}

#[test]
fn schema_three_inventory_backfill_preserves_chunks_vectors_and_enrichment() {
    let (fixture, runtime, mut roots) = manual_setup("legacy-content-backfill");
    fixture.file("saved.txt", b"savedquasar");
    roots[0].cloud_enrichment = true;
    admit(&runtime, roots.clone(), true);
    runtime.reconcile_inventory(false).unwrap();
    runtime.extract_pending().unwrap();
    let db_path = runtime.owned_database_path.as_ref().clone();
    drop(runtime);
    let connection = rusqlite::Connection::open(&db_path).unwrap();
    connection.execute_batch(
        "INSERT INTO vector_embeddings
         SELECT id, zeroblob(8), 'fixture', 2, 'cosine', content_hash, index_revision FROM chunks;
         INSERT INTO enrichment_artifacts(file_id, chunk_id, kind, provider, model, content_hash, payload)
         SELECT file_id, id, 'ocr', 'fixture', 'fixture', content_hash, '{}' FROM chunks;"
    ).unwrap();
    let snapshot = |connection: &rusqlite::Connection| {
        [
            "files",
            "chunks",
            "vector_embeddings",
            "enrichment_artifacts",
        ]
        .map(|table| {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let columns = statement.column_count();
            statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|column| row.get::<_, rusqlite::types::Value>(column))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        })
    };
    let before = snapshot(&connection);
    assert!(before.iter().all(|rows| !rows.is_empty()));
    connection
        .execute_batch("DROP TABLE file_inventory; PRAGMA user_version = 3;")
        .unwrap();
    drop(connection);
    let mut runtime = IndexRuntime::open(&db_path, Path::new("missing-vector.dll"), true).unwrap();
    drop(runtime.worker.take());
    runtime.work.stop.store(false, Ordering::SeqCst);
    admit(&runtime, roots, false);
    assert!(runtime.reconcile_inventory(false).unwrap());
    let connection = rusqlite::Connection::open(&db_path).unwrap();
    assert_eq!(snapshot(&connection), before);
    assert_eq!(runtime.database.inventory().unwrap().len(), 1);
    assert_eq!(runtime.database.search("savedquasar", 10).unwrap().len(), 1);
}

#[test]
fn schema_three_admission_and_scoped_deletion_preserve_legacy_siblings_and_history() {
    let (fixture, runtime, roots) = manual_setup("legacy-policy");
    let keep = fixture.file("keep.txt", b"keepquasar");
    let sibling = fixture.file("folder2/sibling.txt", b"siblingquasar");
    let removed = fixture.file("folder/removed.txt", b"removedquasar");
    let other = fixture.outside_file("other-root.txt", b"otherquasar");
    for (id, path, root) in [
        ("keep", &keep, fixture.root()),
        ("sibling", &sibling, fixture.root()),
        ("removed", &removed, fixture.root()),
        ("other", &other, other.parent().unwrap()),
    ] {
        runtime
            .database
            .upsert_metadata(root, id, path, "one")
            .unwrap();
    }
    runtime.database.set_pinned("keep", true).unwrap();
    let db_path = runtime.owned_database_path.as_ref().clone();
    drop(runtime);
    let connection = rusqlite::Connection::open(&db_path).unwrap();
    connection.execute("INSERT INTO file_access_history(file_id) SELECT id FROM files WHERE stable_id = 'keep'", []).unwrap();
    connection
        .execute_batch("DROP TABLE file_inventory; PRAGMA user_version = 3;")
        .unwrap();
    drop(connection);
    let mut runtime = IndexRuntime::open(&db_path, Path::new("missing-vector.dll"), true).unwrap();
    drop(runtime.worker.take());
    runtime.work.stop.store(false, Ordering::SeqCst);
    // Direct subtree removal must not derive its keep set from capped joined inventory.
    let canonical_root = std::fs::canonicalize(fixture.root()).unwrap();
    runtime
        .database
        .remove_inventory_path(&canonical_root, &canonical_root.join("folder"))
        .unwrap();
    let connection = rusqlite::Connection::open(&db_path).unwrap();
    let count: i64 = connection
        .query_row("SELECT count(*) FROM files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        count, 3,
        "siblings and other roots survive scoped removal without inventory rows"
    );
    admit(&runtime, roots, false);
    let count: i64 = connection
        .query_row("SELECT count(*) FROM files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        count, 2,
        "admitted legacy files survive and revoked roots are pruned"
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM pins", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM file_access_history", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn incomplete_valid_root_keeps_inventory_pending_and_completed_until_complete_retry() {
    let (fixture, runtime, roots) = manual_setup("incomplete-inventory");
    fixture.file("a.txt", b"alphaquasar");
    fixture.file("b.txt", b"betaquasar");
    fixture.file("c.txt", b"gammaquasar");
    admit(&runtime, roots, true);
    runtime.reconcile_inventory(false).unwrap();
    runtime.extract_pending().unwrap();
    runtime.extract_pending().unwrap();
    assert_eq!(runtime.work.pending.lock().unwrap().len(), 1);
    assert_eq!(runtime.work.completed.lock().unwrap().len(), 2);
    runtime.work.traversal_limit.store(1, Ordering::SeqCst);
    runtime.reconcile_inventory(false).unwrap();
    assert_eq!(runtime.database.inventory().unwrap().len(), 3);
    assert_eq!(runtime.work.pending.lock().unwrap().len(), 1);
    assert_eq!(runtime.work.completed.lock().unwrap().len(), 2);
    runtime.work.traversal_limit.store(0, Ordering::SeqCst);
    std::fs::remove_file(fixture.root().join("b.txt")).unwrap();
    runtime.reconcile_inventory(false).unwrap();
    assert_eq!(runtime.database.inventory().unwrap().len(), 2);
    assert_eq!(runtime.work.completed.lock().unwrap().len(), 1);
    std::fs::remove_dir_all(fixture.root()).unwrap();
    runtime.work.traversal_limit.store(1, Ordering::SeqCst);
    runtime.reconcile_inventory(false).unwrap();
    assert!(runtime.database.inventory().unwrap().is_empty());
    assert!(runtime.work.pending.lock().unwrap().is_empty());
    assert!(runtime.work.completed.lock().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn redirected_root_is_pruned_even_after_incomplete_inventory() {
    let (fixture, runtime, mut roots) = manual_setup("incomplete-root-redirect");
    let path = fixture.file("parent/root/a.txt", b"safequasar");
    fixture.file("parent/root/z.txt", b"safequasar");
    let root = path.parent().unwrap();
    roots[0].path = root.to_string_lossy().into_owned();
    admit(&runtime, roots, false);
    runtime.reconcile_inventory(false).unwrap();
    runtime.work.traversal_limit.store(1, Ordering::SeqCst);
    runtime.reconcile_inventory(false).unwrap();
    assert_eq!(runtime.database.inventory().unwrap().len(), 2);
    let redirected = fixture.outside_file("outside-root/forbidden.txt", b"forbiddenquasar");
    std::fs::rename(root, root.with_file_name("saved-root")).unwrap();
    std::os::windows::fs::symlink_dir(redirected.parent().unwrap(), root).unwrap();
    runtime.reconcile_inventory(false).unwrap();
    assert!(runtime.database.inventory().unwrap().is_empty());
    assert!(runtime.work.pending.lock().unwrap().is_empty());
    assert_eq!(runtime.snapshot().phase, "degraded");
}

#[test]
fn vanished_inventory_record_does_not_abort_other_private_files() {
    let (fixture, runtime, roots) = manual_setup("vanished-metadata");
    fixture.file("a-vanished.txt", b"gonequasar");
    fixture.file("z-keep.txt", b"keepquasar");
    admit(&runtime, roots, false);
    *runtime.work.inventory_record_gate.lock().unwrap() = Some(Arc::new(|path| {
        if path.file_name().unwrap() == "a-vanished.txt" {
            std::fs::remove_file(path).unwrap();
        }
    }));
    runtime.reconcile_inventory(false).unwrap();
    assert_eq!(runtime.database.inventory().unwrap().len(), 1);
    assert_eq!(runtime.work.pending.lock().unwrap().len(), 1);
}

#[test]
fn safety_inventory_is_uncapped_and_single_path_deletion_does_not_parse_other_rows() {
    let (fixture, runtime, _) = manual_setup("uncapped-policy-inventory");
    let path = fixture.file("keep.txt", b"keepquasar");
    runtime
        .database
        .upsert_metadata(fixture.root(), "seed", &path, "one")
        .unwrap();
    let connection = rusqlite::Connection::open(runtime.owned_database_path.as_ref()).unwrap();
    connection.execute_batch("WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n < 250001)
        INSERT INTO files(stable_id, root_path, path, name, content_hash, extraction_version, index_revision)
        SELECT 'row-' || n, root_path, path || '-' || n, name, content_hash, extraction_version, index_revision FROM ids, files WHERE stable_id = 'seed';
        INSERT INTO file_inventory(file_id, metadata) SELECT id,
        json_set((SELECT metadata FROM file_inventory WHERE file_id = (SELECT id FROM files WHERE stable_id = 'seed')), '$.path', path, '$.relativePath', 'keep.txt-' || id)
        FROM files WHERE stable_id != 'seed';").unwrap();
    assert_eq!(runtime.database.policy_inventory().unwrap().len(), 250002);
    // A corrupt unrelated row cannot turn scoped deletion into an inventory read.
    connection.execute("UPDATE file_inventory SET metadata = 'invalid' WHERE file_id = (SELECT id FROM files WHERE stable_id = 'seed')", []).unwrap();
    let root = std::fs::canonicalize(fixture.root()).unwrap();
    assert!(
        runtime
            .database
            .remove_inventory_path(&root, &root.join("absent-subtree"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM files", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        250002
    );
}

#[test]
fn forced_overflow_retries_signature_preserving_content_after_sqlite_failure() {
    let (fixture, mut runtime, roots) = manual_setup("overflow-retry");
    let path = fixture.file("notes.txt", b"firstquasar");
    admit(&runtime, roots, true);
    runtime.reconcile_inventory(false).unwrap();
    runtime.extract_pending().unwrap();
    runtime.set_content_enabled(false);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"nextnebulaa").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let connection = rusqlite::Connection::open(runtime.owned_database_path.as_ref()).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_inventory BEFORE UPDATE ON file_inventory BEGIN SELECT RAISE(ABORT, 'controlled failure'); END;").unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let once = std::sync::atomic::AtomicBool::new(false);
    *runtime.work.inventory_cycle_gate.lock().unwrap() = Some(Arc::new(move |_, before| {
        if before && !once.swap(true, Ordering::SeqCst) {
            entered_tx.send(()).unwrap();
            let _ = release_rx.lock().unwrap().recv();
        }
    }));
    runtime.worker = Some(index_worker::IndexWorker::start(runtime.clone()));
    entered_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    assert!(runtime.worker.as_ref().unwrap().overflow_for_test() > 0);
    release_tx.send(()).unwrap();
    eventually("controlled forced reconciliation fails", || {
        runtime.work.inventory_failed.load(Ordering::SeqCst)
    });
    connection
        .execute_batch("DROP TRIGGER fail_inventory;")
        .unwrap();
    runtime.work.periodic_due.store(true, Ordering::SeqCst);
    runtime.worker.as_ref().unwrap().wake();
    eventually("forced retry invalidates same-signature body", || {
        runtime
            .database
            .search("firstquasar", 10)
            .unwrap()
            .is_empty()
    });
    runtime.set_content_enabled(true);
    eventually("forced retry extracts changed body", || {
        !runtime
            .database
            .search("nextnebulaa", 10)
            .unwrap()
            .is_empty()
    });
}

// Baseline exercises the current real synchronization core on its native worker pool.
fn admit(runtime: &IndexRuntime, roots: Vec<IndexRootRequest>, enabled: bool) {
    runtime.configure_roots(roots, enabled).unwrap();
}

fn eventually(message: &str, mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if predicate() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(predicate(), "{message}");
}

#[test]
fn worker_edit_rename_and_delete_refresh_real_content() {
    let (fixture, runtime, roots) = setup("fresh-edits");
    let path = fixture.file("notes.txt", b"firstquasar");
    admit(&runtime, roots, true);
    eventually("initial content indexed", || {
        !runtime
            .answer_context("firstquasar", 10)
            .unwrap()
            .is_empty()
    });
    std::fs::write(&path, b"secondnebula-longer").unwrap();
    eventually("edits must refresh without a query scan", || {
        !runtime
            .answer_context("secondnebula", 10)
            .unwrap()
            .is_empty()
    });
    let renamed = fixture.root().join("renamed.txt");
    std::fs::rename(path, &renamed).unwrap();
    eventually("rename removes old identity", || {
        runtime.answer_context("notes", 10).unwrap().is_empty()
            && !runtime.answer_context("renamed", 10).unwrap().is_empty()
    });
    std::fs::remove_file(renamed).unwrap();
    eventually("deleted content removed", || {
        runtime
            .answer_context("secondnebula", 10)
            .unwrap()
            .is_empty()
    });
}

#[test]
fn worker_same_size_same_mtime_event_forces_content_refresh() {
    let (fixture, runtime, roots) = setup("fresh-same-stamp");
    let path = fixture.file("notes.txt", b"firstquasar");
    admit(&runtime, roots, true);
    eventually("initial content indexed", || {
        !runtime
            .answer_context("firstquasar", 10)
            .unwrap()
            .is_empty()
    });
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"nextnebulaa").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    eventually("same signature event refreshes hash", || {
        !runtime
            .answer_context("nextnebulaa", 10)
            .unwrap()
            .is_empty()
    });
    assert!(
        runtime
            .answer_context("firstquasar", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn periodic_reconciliation_preserves_delivered_dirty_content_events() {
    let (fixture, runtime, roots) = setup("fresh-periodic-dirty");
    let path = fixture.file("notes.txt", b"firstquasar");
    admit(&runtime, roots, true);
    eventually("initial content indexed", || {
        !runtime
            .answer_context("firstquasar", 10)
            .unwrap()
            .is_empty()
    });
    runtime.set_content_enabled(false);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let stage = std::sync::atomic::AtomicU64::new(0);
    *runtime.work.inventory_cycle_gate.lock().unwrap() = Some(Arc::new(move |dirty, before| {
        if before
            && dirty
            && stage
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            entered_tx.send(()).unwrap();
            let _ = release_rx.lock().unwrap().recv();
        } else if !before
            && stage
                .compare_exchange(1, 2, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            done_tx.send(()).unwrap();
            let _ = release_rx.lock().unwrap().recv();
        }
    }));
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"nextnebulaa").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    runtime.work.periodic_due.store(true, Ordering::SeqCst);
    release_tx.send(()).unwrap();
    done_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    let old = runtime.answer_context("firstquasar", 10).unwrap();
    let pending = runtime.work.pending.lock().unwrap().len();
    release_tx.send(()).unwrap();
    assert!(
        old.is_empty(),
        "periodic reconciliation must invalidate the delivered dirty body"
    );
    assert_eq!(
        pending, 1,
        "delivered dirty content remains pending while paused"
    );
    runtime.set_content_enabled(true);
    eventually("dirty body extracted after resume", || {
        !runtime
            .answer_context("nextnebulaa", 10)
            .unwrap()
            .is_empty()
    });
}

#[test]
fn worker_paused_content_stays_pending_and_resumes() {
    let (fixture, runtime, roots) = setup("fresh-pause");
    fixture.file("notes.txt", b"pendingnebula");
    admit(&runtime, roots.clone(), false);
    eventually("filename visible while paused", || {
        !runtime.answer_context("notes", 10).unwrap().is_empty()
            && runtime.snapshot().phase == "paused"
    });
    assert_eq!(runtime.snapshot().phase, "paused");
    assert!(
        runtime
            .answer_context("pendingnebula", 10)
            .unwrap()
            .is_empty()
    );
    admit(&runtime, roots, true);
    eventually("resume must extract pending file", || {
        !runtime
            .answer_context("pendingnebula", 10)
            .unwrap()
            .is_empty()
    });
}

#[test]
fn paused_dirty_content_is_not_an_authoritative_answer() {
    let (fixture, runtime, roots) = setup("fresh-dirty-pause");
    let path = fixture.file("notes.txt", b"oldquasar");
    admit(&runtime, roots, true);
    eventually("initial body indexed", || {
        !runtime.answer_context("oldquasar", 10).unwrap().is_empty()
    });
    runtime.set_content_enabled(false);
    std::fs::write(path, b"newnebula").unwrap();
    eventually("old answer body removed while paused", || {
        runtime.answer_context("oldquasar", 10).unwrap().is_empty()
            && runtime.snapshot().phase == "paused"
    });
    assert_eq!(
        runtime
            .hybrid_search("notes", None, "", 10, ranking::RankingWeights::default())
            .unwrap()
            .len(),
        1
    );
    assert!(runtime.answer_context("newnebula", 10).unwrap().is_empty());
    assert_eq!(runtime.snapshot().phase, "paused");
    runtime.set_content_enabled(true);
    eventually("dirty body retried on resume", || {
        !runtime.answer_context("newnebula", 10).unwrap().is_empty()
    });
}

#[test]
fn revoked_generation_rejects_downstream_derived_commits() {
    let (fixture, runtime, roots) = setup("fresh-derived-generation");
    fixture.file("notes.txt", b"allowedquasar");
    admit(&runtime, roots, true);
    let generation = runtime.current_generation();
    admit(&runtime, vec![], true);
    let mut committed = false;
    assert_eq!(
        runtime
            .with_current_generation(generation, || {
                committed = true;
                Ok(())
            })
            .unwrap(),
        None
    );
    assert!(!committed);
}

#[test]
fn blocked_first_real_extraction_does_not_block_inventory_or_root_revoke() {
    let (fixture, runtime, roots) = setup("fresh-blocked");
    fixture.file("a.txt", b"stalequasar");
    fixture.file("z.txt", b"laternebula");
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    *runtime.extraction_gate.lock().unwrap() = Some(Arc::new(move |_| {
        entered_tx.send(()).unwrap();
        release_rx.lock().unwrap().recv().unwrap();
    }));
    admit(&runtime, roots, true);
    entered_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    let query_runtime = runtime.clone();
    let (query_tx, query_rx) = mpsc::channel();
    std::thread::spawn(move || {
        query_tx
            .send(query_runtime.answer_context("z", 10).unwrap())
            .unwrap()
    });
    let result = query_rx.recv_timeout(Duration::from_millis(400));
    admit(&runtime, vec![], true);
    assert!(
        runtime.database.inventory().unwrap().is_empty(),
        "revocation prunes during blocked extraction"
    );
    *runtime.extraction_gate.lock().unwrap() = None;
    release_tx.send(()).unwrap();
    let result = result.expect("inventory queries must not wait for real extraction");
    assert_eq!(result.len(), 1);
    eventually("revoked generation cannot leave content", || {
        runtime
            .answer_context("stalequasar", 10)
            .unwrap()
            .is_empty()
    });
}

#[test]
fn worker_deletion_requires_re_admission_and_rebuilds_unchanged_signatures() {
    let (fixture, runtime, roots) = setup("fresh-delete-index");
    fixture.file("notes.txt", b"rebuildquasar");
    admit(&runtime, roots.clone(), true);
    eventually("initial content indexed", || {
        !runtime
            .answer_context("rebuildquasar", 10)
            .unwrap()
            .is_empty()
    });
    let generation = runtime.snapshot().generation;
    runtime.delete_indexed_content().unwrap();
    assert!(runtime.snapshot().generation > generation);
    assert!(
        runtime
            .answer_context("rebuildquasar", 10)
            .unwrap()
            .is_empty()
    );
    admit(&runtime, roots, true);
    eventually("re-admission rebuilds deleted content", || {
        !runtime
            .answer_context("rebuildquasar", 10)
            .unwrap()
            .is_empty()
    });
}

#[test]
fn directory_removal_cancels_pending_descendant_extractions() {
    let (fixture, runtime, roots) = setup("fresh-remove-pending-subtree");
    fixture.file("folder/notes.txt", b"pendingquasar");
    admit(&runtime, roots, false);
    eventually("descendant queued while paused", || {
        runtime.snapshot().pending_items == 1
    });
    let removed = fixture.root().join("folder");
    std::fs::remove_dir_all(&removed).unwrap();
    // Directory-only notification is a valid native backend event; real files were removed.
    runtime.refresh_paths(vec![removed]).unwrap();
    assert_eq!(
        runtime.snapshot().pending_items,
        0,
        "a removed subtree cannot retain pending child work"
    );
    assert_eq!(runtime.snapshot().phase, "ready");
}

#[test]
fn disappearing_selected_root_prunes_content_and_reports_degraded() {
    let (fixture, runtime, roots) = setup("fresh-root-disappears");
    fixture.file("notes.txt", b"disappearingquasar");
    admit(&runtime, roots, true);
    eventually("initial body indexed", || {
        !runtime
            .answer_context("disappearingquasar", 10)
            .unwrap()
            .is_empty()
    });
    std::fs::remove_dir_all(fixture.root()).unwrap();
    runtime.reconcile_inventory(false).unwrap();
    assert!(
        runtime
            .answer_context("disappearingquasar", 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(runtime.snapshot().phase, "degraded");
}

#[test]
fn changed_exclusions_prune_existing_hits_at_configuration_admission() {
    let (fixture, runtime, mut roots) = setup("fresh-policy-admission");
    fixture.file("notes.txt", b"privatequasar");
    admit(&runtime, roots.clone(), true);
    eventually("initial body indexed", || {
        !runtime
            .answer_context("privatequasar", 10)
            .unwrap()
            .is_empty()
    });
    roots[0].exclusions.push("notes.txt".into());
    let admitted = runtime.configure_roots(roots, false).unwrap();
    assert_eq!(
        admitted.indexed_items, 0,
        "changed policy must prune before returning its admission status"
    );
    assert!(
        runtime
            .answer_context("privatequasar", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn first_empty_admission_prunes_durable_rows_from_a_previous_run() {
    let (fixture, runtime, roots) = setup("fresh-empty-reopen");
    fixture.file("notes.txt", b"previousquasar");
    admit(&runtime, roots, true);
    eventually("initial durable body indexed", || {
        !runtime
            .answer_context("previousquasar", 10)
            .unwrap()
            .is_empty()
    });
    drop(runtime);
    let reopened = IndexRuntime::open(
        &fixture.root().parent().unwrap().join("index.sqlite"),
        Path::new("missing-vector.dll"),
        true,
    )
    .unwrap();
    let admitted = reopened.configure_roots(vec![], true).unwrap();
    assert_eq!(
        admitted.indexed_items, 0,
        "first empty grants must prune durable inventory"
    );
    assert!(
        reopened
            .answer_context("previousquasar", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn worker_overflow_reconciles_real_deleted_inventory_and_missed_edits() {
    let (fixture, runtime, roots) = setup("fresh-overflow");
    let path = fixture.file("notes.txt", b"firstquasar");
    fixture.file("remove.txt", b"removequasar");
    admit(&runtime, roots, true);
    eventually("initial content indexed", || {
        !runtime
            .answer_context("removequasar", 10)
            .unwrap()
            .is_empty()
    });
    runtime.set_content_enabled(false);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"nextnebulaa").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    std::fs::remove_file(fixture.root().join("remove.txt")).unwrap();
    assert!(
        runtime.worker.as_ref().unwrap().overflow_for_test() > 0,
        "the native bounded queue must actually overflow"
    );
    eventually("overflow reconciles deletion while paused", || {
        runtime
            .answer_context("removequasar", 10)
            .unwrap()
            .is_empty()
    });
    runtime.set_content_enabled(true);
    eventually("overflow retries missed content signatures", || {
        !runtime
            .answer_context("nextnebulaa", 10)
            .unwrap()
            .is_empty()
    });
    assert!(runtime.work.pending.lock().unwrap().len() <= 250_000);
}

#[test]
fn dirty_same_signature_event_fences_an_already_extracted_stale_body() {
    let (fixture, runtime, roots) = setup("fresh-commit-race");
    let path = fixture.file("notes.txt", b"firstquasar");
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    *runtime.commit_gate.lock().unwrap() = Some(Arc::new(move |_| {
        entered_tx.send(()).unwrap();
        release_rx.lock().unwrap().recv().unwrap();
    }));
    admit(&runtime, roots, true);
    entered_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"nextnebulaa").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    runtime.refresh_paths(vec![path]).unwrap();
    *runtime.commit_gate.lock().unwrap() = None;
    release_tx.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_millis(100);
    while Instant::now() < deadline {
        assert!(
            runtime
                .answer_context("firstquasar", 10)
                .unwrap()
                .is_empty(),
            "dirty-event admission must reject the old extracted body at commit"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    eventually(
        "superseded extraction cannot cache the dirty signature as complete",
        || {
            !runtime
                .answer_context("nextnebulaa", 10)
                .unwrap()
                .is_empty()
        },
    );
    assert!(
        runtime
            .answer_context("firstquasar", 10)
            .unwrap()
            .is_empty()
    );
}

#[cfg(windows)]
#[test]
fn watcher_events_do_not_follow_real_file_or_directory_symlinks() {
    let (fixture, runtime, roots) = setup("fresh-symlinks");
    fixture.file("visible.txt", b"visiblequasar");
    let outside = fixture.outside_file("secret.txt", b"forbiddenquasar");
    std::os::windows::fs::symlink_file(&outside, fixture.root().join("link.txt")).unwrap();
    std::os::windows::fs::symlink_dir(outside.parent().unwrap(), fixture.root().join("linked-dir"))
        .unwrap();
    admit(&runtime, roots, true);
    eventually("ordinary permitted file indexed", || {
        !runtime
            .answer_context("visiblequasar", 10)
            .unwrap()
            .is_empty()
    });
    std::fs::write(outside, b"changedforbiddenquasar").unwrap();
    fixture.file("next.txt", b"newvisiblequasar");
    eventually("subsequent event processed", || {
        !runtime
            .answer_context("newvisiblequasar", 10)
            .unwrap()
            .is_empty()
    });
    assert!(
        runtime
            .answer_context("forbiddenquasar", 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        runtime
            .answer_context("changedforbiddenquasar", 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        !runtime
            .database
            .inventory()
            .unwrap()
            .iter()
            .any(|item| item.hit.name.starts_with("link"))
    );
}

#[test]
fn worker_excluded_changes_are_never_admitted() {
    let (fixture, runtime, roots) = setup("fresh-policy");
    fixture.file("visible.txt", b"visiblequasar");
    admit(&runtime, roots, true);
    eventually("initial content indexed", || {
        !runtime
            .answer_context("visiblequasar", 10)
            .unwrap()
            .is_empty()
    });
    fixture.file("private/secret.txt", b"forbiddennebula");
    fixture.file("node_modules/secret.txt", b"forbiddennebula");
    fixture.file(".hidden.txt", b"forbiddennebula");
    fixture.file("new.txt", b"admittednebula");
    eventually("new permitted file indexed", || {
        !runtime
            .answer_context("admittednebula", 10)
            .unwrap()
            .is_empty()
    });
    assert!(
        runtime
            .answer_context("forbiddennebula", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn durable_enrichment_is_not_dispatchable_before_current_root_admission() {
    for first_admission in ["consented", "revoked", "empty"] {
        let (fixture, runtime, mut roots) = setup("fresh-startup-consent");
        fixture.file("scan.png", &[0, 1, 2]);
        roots[0].cloud_enrichment = true;
        admit(&runtime, roots.clone(), true);
        eventually("consented durable job created", || {
            runtime.database.queued_jobs().unwrap().len() == 1
        });
        drop(runtime);
        let reopened = IndexRuntime::open(
            &fixture.root().parent().unwrap().join("index.sqlite"),
            Path::new("missing-vector.dll"),
            true,
        )
        .unwrap();
        assert_eq!(
            reopened.database.queued_jobs().unwrap().len(),
            1,
            "fixture must reopen a real persisted queue"
        );
        assert!(
            reopened.pending_enrichment().unwrap().is_empty(),
            "startup may not dispatch durable jobs before current root admission"
        );
        if first_admission != "consented" {
            roots[0].cloud_enrichment = false;
            admit(
                &reopened,
                if first_admission == "empty" {
                    Vec::new()
                } else {
                    roots
                },
                false,
            );
            assert!(
                reopened.pending_enrichment().unwrap().is_empty(),
                "first empty/revoked admission must not dispatch durable work"
            );
            assert!(
                reopened.database.queued_jobs().unwrap().is_empty(),
                "revoked durable jobs are pruned at admission"
            );
            continue;
        }
        admit(&reopened, roots.clone(), false);
        assert_eq!(
            reopened.pending_enrichment().unwrap().len(),
            1,
            "current explicit consent admits the queued job"
        );
        let captured = reopened.pending_enrichment().unwrap().remove(0);
        assert!(reopened.enrichment_dispatch_is_admitted(&captured).unwrap());
        roots[0].cloud_enrichment = false;
        admit(&reopened, roots, false);
        assert!(
            reopened.pending_enrichment().unwrap().is_empty(),
            "revoked root cloud grant must not dispatch"
        );
        assert!(
            !reopened.enrichment_dispatch_is_admitted(&captured).unwrap(),
            "previously captured jobs must be revalidated before dispatch"
        );
        admit(&reopened, Vec::new(), false);
        assert!(
            reopened.pending_enrichment().unwrap().is_empty(),
            "empty configuration must not dispatch"
        );
    }
}

#[cfg(windows)]
#[test]
fn replaced_ancestor_cannot_redirect_pending_extraction() {
    ancestor_replacement(false);
}

#[cfg(windows)]
#[test]
fn replaced_ancestor_cannot_redirect_content_commit() {
    ancestor_replacement(true);
}

#[cfg(windows)]
fn ancestor_replacement(replace_at_commit: bool) {
    let (fixture, mut runtime, mut roots) = setup("fresh-ancestor");
    let path = fixture.file("parent/root/notes.txt", b"firstquasar");
    let ancestor = fixture.root().join("parent");
    let admitted_root = ancestor.join("root");
    roots[0].path = admitted_root.to_string_lossy().into_owned();
    let redirected = fixture.outside_file("redirect/root/notes.txt", b"nextnebulaa");
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::File::options()
        .write(true)
        .open(&redirected)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    admit(&runtime, roots, false);
    eventually("pending inventory prepared", || {
        runtime.snapshot().pending_items == 1 && runtime.snapshot().phase == "paused"
    });
    // Windows' live watch handle prevents ancestor rename. Detach the owned OS watcher,
    // retain actual pending work, and exercise its production extraction/commit core directly.
    drop(runtime.worker.take());
    runtime.work.stop.store(false, Ordering::SeqCst);
    let extraction_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let count = extraction_count.clone();
    *runtime.extraction_gate.lock().unwrap() = Some(Arc::new(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
    }));
    let (commit_tx, commit_rx) = mpsc::channel();
    let (release_commit_tx, release_commit_rx) = mpsc::channel();
    let release_commit_rx = Mutex::new(release_commit_rx);
    if replace_at_commit {
        *runtime.commit_gate.lock().unwrap() = Some(Arc::new(move |_| {
            commit_tx.send(()).unwrap();
            let _ = release_commit_rx.lock().unwrap().recv();
        }));
    }
    runtime.work.content_enabled.store(true, Ordering::SeqCst);
    let extract = if replace_at_commit {
        let cloned = runtime.clone();
        let task = std::thread::spawn(move || cloned.extract_pending());
        commit_rx.recv_timeout(Duration::from_secs(4)).unwrap();
        Some(task)
    } else {
        None
    };
    let saved = fixture.root().join("saved-parent");
    std::fs::rename(&ancestor, &saved).unwrap();
    std::os::windows::fs::symlink_dir(redirected.parent().unwrap().parent().unwrap(), &ancestor)
        .unwrap();
    if let Some(extract) = extract {
        release_commit_tx.send(()).unwrap();
        extract.join().unwrap().unwrap();
    } else {
        runtime.extract_pending().unwrap();
    }
    let outside_body = runtime.answer_context("nextnebulaa", 10).unwrap();
    let original_body = runtime.answer_context("firstquasar", 10).unwrap();
    runtime.work.content_enabled.store(false, Ordering::SeqCst);
    // Restore the fixture before assertions/unblocking so teardown only touches its owned tree.
    std::fs::remove_dir(&ancestor).unwrap();
    std::fs::rename(saved, ancestor).unwrap();
    assert!(
        outside_body.is_empty(),
        "redirected outside content must never be committed"
    );
    assert!(
        original_body.is_empty(),
        "a changed admitted boundary must reject a pending commit"
    );
    if !replace_at_commit {
        assert_eq!(
            extraction_count.load(Ordering::SeqCst),
            0,
            "reject the redirected boundary before actual extraction"
        );
    }
}
