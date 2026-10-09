use super::*;
use crate::search::test_support::SearchFixture;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::cell::Cell;
use std::time::Instant;

thread_local! { static FTS_DELETES: Cell<usize> = const { Cell::new(0) }; }

fn count_fts_deletes(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(_, sql) = event
        && sql.trim_start().starts_with("DELETE FROM search_fts")
    {
        FTS_DELETES.with(|count| count.set(count.get() + 1));
    }
}

fn seeded_cleanup(rows: i64, subtree: bool) {
    let fixture = SearchFixture::new("bulk-policy-cleanup");
    let db_path = fixture.root().parent().unwrap().join("cleanup.sqlite");
    let database = IndexDatabase::open(&db_path, Path::new("missing-vector.dll")).unwrap();
    {
        let connection = database.connection.lock().unwrap();
        connection.execute("WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n < ?1)
            INSERT INTO files(id, stable_id, root_path, path, name, content_hash, extraction_version, index_revision)
            SELECT n, 'row-' || n, CASE WHEN n = ?1 THEN 'other-root' ELSE 'root' END,
            CASE WHEN n > ?1-2 THEN 'keep/' ELSE 'root/doomed/' END || n || '.txt', 'doc', 'hash', 'text-v1', 1 FROM ids", [rows + 2]).unwrap();
        connection.execute_batch("INSERT INTO chunks(id,file_id,ordinal,text,extraction_kind,content_hash,index_revision)
            SELECT id*2,id,0,'cleanupquasar','text','hash',1 FROM files;
            INSERT INTO chunks(id,file_id,ordinal,text,extraction_kind,content_hash,index_revision)
            SELECT id*2+1,id,1,'secondnebula','text','hash',1 FROM files;
            INSERT INTO search_fts(rowid,file_id,chunk_id,name,path,body) SELECT id,file_id,id,'doc','path',text FROM chunks;
            INSERT INTO vector_embeddings SELECT id,zeroblob(8),'fixture',2,'cosine','hash',1 FROM chunks;
            INSERT INTO pins(file_id) SELECT id FROM files;
            INSERT INTO file_access_history(file_id) SELECT id FROM files;
            INSERT INTO embedding_jobs(chunk_id,embedding_model,content_hash,index_revision) SELECT id,'fixture','hash',1 FROM chunks;
            INSERT INTO enrichment_jobs(file_id,kind,route,content_hash,status) SELECT id,'ocr','fixture','hash','queued' FROM files;
            INSERT INTO enrichment_artifacts(file_id,chunk_id,kind,provider,model,content_hash,payload) SELECT file_id,id,'ocr','fixture','fixture','hash','{}' FROM chunks;
            INSERT INTO answer_cache(cache_key,file_id,query,mode,provider,model,content_hash,index_revision,answer) SELECT stable_id,id,'query','local','fixture','fixture','hash',1,'answer' FROM files;
            INSERT INTO query_history(query) VALUES ('keep user query');").unwrap();
        // Both survivors are legacy rows; one also has unrelated malformed metadata.
        connection
            .execute(
                "INSERT INTO file_inventory(file_id,metadata) VALUES (?1,'invalid')",
                [rows + 2],
            )
            .unwrap();
        FTS_DELETES.with(|count| count.set(0));
        connection.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(count_fts_deletes));
    }
    if subtree {
        // Use the native separator used by the production subtree predicate.
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "UPDATE files SET path = replace(path,'/',?1) WHERE id <= ?2",
                params![std::path::MAIN_SEPARATOR.to_string(), rows],
            )
            .unwrap();
        drop(connection);
    }
    let started = Instant::now();
    if subtree {
        let removed = database
            .remove_inventory_path(Path::new("root"), &Path::new("root").join("doomed"))
            .unwrap();
        assert_eq!(removed.len(), rows as usize);
        assert!(removed.contains(&"row-1".to_owned()));
        assert!(!removed.contains(&format!("row-{}", rows + 1)));
    } else {
        let retained = HashMap::from([
            (
                "root".to_owned(),
                HashSet::from([format!("row-{}", rows + 1)]),
            ),
            (
                "other-root".to_owned(),
                HashSet::from([format!("row-{}", rows + 2)]),
            ),
        ]);
        assert_eq!(database.retain_inventory(&retained).unwrap(), rows as u64);
    }
    println!(
        "private cleanup rows={rows} subtree={subtree} elapsed_ms={:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    let fts_deletes = FTS_DELETES.with(Cell::get);
    let connection = database.connection.lock().unwrap();
    connection.trace_v2(TraceEventCodes::empty(), None);
    for (table, expected) in [
        ("files", 2),
        ("chunks", 4),
        ("search_fts", 4),
        ("vector_embeddings", 4),
        ("pins", 2),
        ("file_access_history", 2),
        ("embedding_jobs", 4),
        ("enrichment_jobs", 2),
        ("enrichment_artifacts", 4),
        ("answer_cache", 2),
        ("query_history", 1),
        ("file_inventory", 1),
    ] {
        assert_eq!(
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            expected,
            "{table}"
        );
    }
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM files WHERE id <= ?1", [rows], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM search_fts WHERE CAST(file_id AS INTEGER) <= ?1",
                [rows],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        fts_deletes, 1,
        "scoped cleanup must execute one FTS scan rather than one per file"
    );
    let plans = connection
        .prepare("EXPLAIN QUERY PLAN DELETE FROM files WHERE id = -1")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        plans
            .iter()
            .any(|plan| plan.contains("SEARCH enrichment_artifacts")),
        "{plans:?}"
    );
    assert!(
        plans
            .iter()
            .any(|plan| plan.contains("SEARCH answer_cache")),
        "{plans:?}"
    );
    assert!(
        !plans
            .iter()
            .any(|plan| plan.contains("SCAN enrichment_artifacts")
                || plan.contains("SCAN answer_cache")),
        "{plans:?}"
    );
    drop(connection);
    // No-op and empty policies reuse the same owned connection without stale staging IDs.
    let retained = HashMap::from([
        (
            "root".to_owned(),
            HashSet::from([format!("row-{}", rows + 1)]),
        ),
        (
            "other-root".to_owned(),
            HashSet::from([format!("row-{}", rows + 2)]),
        ),
    ]);
    assert_eq!(database.retain_inventory(&retained).unwrap(), 0);
    assert!(
        database
            .remove_inventory_path(Path::new("root"), Path::new("absent"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(database.retain_inventory(&HashMap::new()).unwrap(), 2);
    assert_eq!(database.retain_inventory(&HashMap::new()).unwrap(), 0);
    let connection = database.connection.lock().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM search_fts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM sqlite_temp_master", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn scoped_cleanup_executes_one_fts_delete_per_batch() {
    seeded_cleanup(512, false);
    seeded_cleanup(512, true);
}

#[test]
fn large_private_cleanup_preserves_unaffected_and_legacy_rows() {
    seeded_cleanup(50_000, false);
    seeded_cleanup(50_000, true);
}

#[test]
fn failed_scoped_cleanup_rolls_back_rows_and_private_staging() {
    let fixture = SearchFixture::new("cleanup-rollback");
    let path = fixture.file("saved.txt", b"savedquasar");
    let database = IndexDatabase::open_memory().unwrap();
    database
        .upsert_document(
            fixture.root(),
            &IndexedDocument {
                stable_id: "saved".into(),
                path,
                content_hash: "hash".into(),
                extraction_version: "text-v1".into(),
                chunks: vec![IndexedChunk {
                    text: "savedquasar".into(),
                    extraction_kind: "text".into(),
                    page: None,
                    time_start_ms: None,
                    time_end_ms: None,
                }],
            },
        )
        .unwrap();
    database.set_pinned("saved", true).unwrap();
    database.record_file_open("saved").unwrap();
    database.connection.lock().unwrap().execute_batch("CREATE TRIGGER deny_delete BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT,'controlled failure'); END;").unwrap();
    assert!(database.retain_inventory(&HashMap::new()).is_err());
    assert_eq!(database.search("savedquasar", 10).unwrap().len(), 1);
    assert!(database.ranking_signals("saved").unwrap().1);
    assert_eq!(database.history_status().unwrap().entry_count, 1);
    {
        let connection = database.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM sqlite_temp_master", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        connection
            .execute_batch("DROP TRIGGER deny_delete;")
            .unwrap();
    }
    assert_eq!(database.retain_inventory(&HashMap::new()).unwrap(), 1);
}
