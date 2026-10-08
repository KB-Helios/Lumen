use super::*;
use crate::search::test_support::SearchFixture;
use std::sync::mpsc;
use std::time::Duration;

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
