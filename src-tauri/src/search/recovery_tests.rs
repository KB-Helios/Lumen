use super::*;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::cell::RefCell;

static FTS_REWRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static FTS_DELETE_WORK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[test]
fn one_document_replacement_does_not_scan_the_whole_fts_inventory() {
    let mut work = Vec::new();
    for count in [16, 160] {
        let fixture = RecoveryFixture::new(&format!("fts-work-{count}"));
        let database = IndexDatabase::open(
            &fixture.0.join("index.sqlite"),
            Path::new("missing-vector.dll"),
        )
        .unwrap();
        for i in 0..count {
            let path = fixture.file(
                &format!("document-{i}.txt"),
                format!("originalquasar{i}").as_bytes(),
            );
            database
                .upsert_document(
                    &fixture.root(),
                    &tests::document(
                        path,
                        &format!("id-{i}"),
                        "hash",
                        &format!("originalquasar{i}"),
                    ),
                )
                .unwrap();
        }
        FTS_DELETE_WORK.store(0, Ordering::SeqCst);
        database.inspect_connection(|c| {
            c.trace_v2(
                TraceEventCodes::SQLITE_TRACE_PROFILE,
                Some(|event| {
                    if let TraceEvent::Profile(stmt, _) = event
                        && stmt.sql().starts_with("DELETE FROM search_fts")
                    {
                        FTS_DELETE_WORK.fetch_add(
                            stmt.get_status(rusqlite::StatementStatus::VmStep) as u64,
                            Ordering::SeqCst,
                        );
                    }
                }),
            )
        });
        let path = fixture.file("document-0.txt", b"replacementquasar");
        database
            .upsert_document(
                &fixture.root(),
                &tests::document(path, "id-0", "new-hash", "replacementquasar"),
            )
            .unwrap();
        database.inspect_connection(|c| c.trace_v2(TraceEventCodes::empty(), None));
        work.push(FTS_DELETE_WORK.load(Ordering::SeqCst));
        assert!(database.search("originalquasar0", 5).unwrap().is_empty());
        assert_eq!(
            database.search("replacementquasar", 5).unwrap()[0].stable_id,
            "id-0"
        );
        database.inspect_connection(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM search_fts", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                count
            );
            verify(c);
        });
    }
    println!("TASK13 FTS replacement native VM work16/160rows={work:?}");
    assert!(
        work[0] > 0 && work[1] <= work[0] * 3,
        "10x unrelated files must not require10x FTS deletion VM work: {work:?}"
    );
}

#[test]
fn legacy_fts_rowids_keep_unrelated_content_during_replacement() {
    let fixture = RecoveryFixture::new("legacy-fts-rowids");
    let database = IndexDatabase::open(
        &fixture.0.join("index.sqlite"),
        Path::new("missing-vector.dll"),
    )
    .unwrap();
    for i in 0..3 {
        let path = fixture.file(
            &format!("document-{i}.txt"),
            format!("legacyquasar{i}").as_bytes(),
        );
        database
            .upsert_document(
                &fixture.root(),
                &tests::document(
                    path,
                    &format!("id-{i}"),
                    "hash",
                    &format!("legacyquasar{i}"),
                ),
            )
            .unwrap();
    }
    database.inspect_connection(|c| {
        c.execute(
            "UPDATE search_fts SET rowid=50 WHERE CAST(chunk_id AS INTEGER)=1",
            [],
        )
        .unwrap();
    });
    for i in 0..3 {
        let path = fixture.file(
            &format!("document-{i}.txt"),
            format!("newquasar{i}").as_bytes(),
        );
        database
            .upsert_document(
                &fixture.root(),
                &tests::document(
                    path,
                    &format!("id-{i}"),
                    "new-hash",
                    &format!("newquasar{i}"),
                ),
            )
            .unwrap();
        assert!(
            database
                .search(&format!("legacyquasar{i}"), 5)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            database.search(&format!("newquasar{i}"), 5).unwrap()[0].stable_id,
            format!("id-{i}")
        );
    }
    database.inspect_connection(|c| {
        assert_eq!(
            c.query_row("SELECT count(*) FROM search_fts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        verify(c);
    });
}

#[test]
fn unchanged_inventory_preserves_content_without_rewriting_fts() {
    let fixture = RecoveryFixture::new("unchanged-inventory");
    let path = fixture.file("report.txt", b"retainedquasar");
    let database = IndexDatabase::open(
        &fixture.0.join("index.sqlite"),
        Path::new("missing-vector.dll"),
    )
    .unwrap();
    database
        .upsert_document(
            &fixture.root(),
            &tests::document(path.clone(), "retained", "hash", "retainedquasar"),
        )
        .unwrap();
    database.set_pinned("retained", true).unwrap();
    database.set_history_enabled(true);
    database.record_file_open("retained").unwrap();
    let changes_before = database.inspect_connection(|c| c.total_changes());
    let wal = fixture.0.join("index.sqlite-wal");
    let wal_before = fs::read(&wal).unwrap();
    let wal_modified = fs::metadata(&wal).unwrap().modified().unwrap();
    FTS_REWRITES.store(0, Ordering::SeqCst);
    database.inspect_connection(|c| {
        c.trace_v2(
            TraceEventCodes::SQLITE_TRACE_PROFILE,
            Some(|event| {
                if let TraceEvent::Profile(stmt, _) = event
                    && stmt.sql().starts_with("UPDATE search_fts")
                {
                    FTS_REWRITES.fetch_add(1, Ordering::SeqCst);
                }
            }),
        )
    });
    assert_eq!(
        database
            .upsert_metadata(&fixture.root(), "retained", &path, "same-metadata")
            .unwrap(),
        UpsertOutcome::Unchanged { revision: 1 }
    );
    database.inspect_connection(|c| c.trace_v2(TraceEventCodes::empty(), None));
    assert_eq!(
        database.inspect_connection(|c| c.total_changes()),
        changes_before,
        "unchanged inventory must perform no SQLite writes"
    );
    assert_eq!(
        fs::read(&wal).unwrap(),
        wal_before,
        "unchanged inventory must append no WAL frames"
    );
    assert_eq!(
        fs::metadata(&wal).unwrap().modified().unwrap(),
        wal_modified
    );
    assert_eq!(
        FTS_REWRITES.load(Ordering::SeqCst),
        0,
        "unchanged inventory must not scan/rewrite the FTS table"
    );
    assert_eq!(
        database.search("retainedquasar", 5).unwrap()[0].content_hash,
        "hash"
    );
    assert_eq!(
        database.recent_hits("", 5).unwrap()[0].stable_id,
        "retained"
    );
    database.inspect_connection(|c| {
        assert_eq!(
            c.query_row("SELECT count(*) FROM pins", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        verify(c);
    });
}

struct RecoveryFixture(PathBuf);
impl RecoveryFixture {
    fn new(label: &str) -> Self {
        let base = crate::search::indexing::capacity_tests::owned_base(label);
        fs::create_dir(base.join("root")).unwrap();
        Self(base)
    }
    fn root(&self) -> PathBuf {
        self.0.join("root")
    }
    fn file(&self, name: &str, body: &[u8]) -> PathBuf {
        let path = self.root().join(name);
        fs::write(&path, body).unwrap();
        path
    }
}

thread_local! {
    static INTERRUPT: RefCell<Option<(&'static str, rusqlite::InterruptHandle, bool)>> = const {RefCell::new(None)};
}

fn arm(connection: &Connection, target: &'static str) {
    INTERRUPT
        .with(|slot| *slot.borrow_mut() = Some((target, connection.get_interrupt_handle(), false)));
    connection.trace_v2(
        TraceEventCodes::SQLITE_TRACE_STMT,
        Some(|event| {
            if let TraceEvent::Stmt(_, sql) = event {
                INTERRUPT.with(|slot| {
                    if let Some((target, handle, reached)) = slot.borrow_mut().as_mut()
                        && !*reached
                        && sql.trim_start().starts_with(*target)
                    {
                        *reached = true;
                        std::thread::scope(|scope| {
                            scope.spawn(|| handle.interrupt()).join().unwrap();
                        });
                    }
                });
            }
        }),
    );
}

fn disarm(connection: &Connection) {
    connection.trace_v2(TraceEventCodes::empty(), None);
    assert!(
        INTERRUPT.with(|slot| slot.borrow_mut().take().unwrap().2),
        "target statement never started"
    );
}

fn verify(connection: &Connection) {
    assert!(connection.is_autocommit());
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
}

#[test]
fn interrupted_vector_reset_preserves_table_and_authoritative_data() {
    let fixture = RecoveryFixture::new("interrupt-vector-reset");
    let path = fixture.file("report.txt", b"retainedquasar report");
    let dbpath = fixture.root().parent().unwrap().join("index.sqlite");
    let extension = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/vector.dll");
    let database = IndexDatabase::open(&dbpath, &extension).unwrap();
    database
        .upsert_document(
            &fixture.root(),
            &tests::document(path.clone(), "retained", "hash", "retainedquasar report"),
        )
        .unwrap();
    database.set_history_enabled(true);
    database.set_pinned("retained", true).unwrap();
    database.record_file_open("retained").unwrap();
    database.record_user_query("retainedquasar", true).unwrap();
    let chunk = database.inspect_connection(|c| {
        c.query_row("SELECT id FROM chunks", [], |r| r.get::<_, i64>(0))
            .unwrap()
    });
    database
        .upsert_embedding(chunk, "model-a", 3, "hash", 1, &[1.0, 0.0, 0.0])
        .unwrap();
    database.queue_embedding_jobs("model-b").unwrap();
    let job = database
        .pending_embedding_jobs("model-b", 1)
        .unwrap()
        .remove(0);
    database.inspect_connection(|c| arm(c, "CREATE TABLE vector_embeddings"));
    let error = database
        .complete_embedding_job(&job, &[1.0, 0.0])
        .unwrap_err();
    assert!(
        matches!(error,IndexError::Database(ref e) if e.sqlite_error_code()==Some(rusqlite::ErrorCode::OperationInterrupted)),
        "{error:?}"
    );
    println!("TASK13 actual native complete_embedding_job vector reset error={error:?}");
    database.inspect_connection(|c| disarm(c));
    // This is the regression: the old DROP/CREATE batch leaves this table absent.
    database.inspect_connection(|c| {
        assert_eq!(
            c.query_row("SELECT count(*) FROM vector_embeddings", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        verify(c);
    });
    assert_eq!(
        database.search("retainedquasar", 5).unwrap()[0].stable_id,
        "retained"
    );
    drop(database);
    let reopened = IndexDatabase::open(&dbpath, &extension).unwrap();
    assert_eq!(
        reopened.recent_hits("", 5).unwrap()[0].stable_id,
        "retained"
    );
    assert_eq!(reopened.history_status().unwrap().entry_count, 2);
    assert!(reopened.complete_embedding_job(&job, &[1.0, 0.0]).unwrap());
    assert_eq!(
        reopened
            .search_embeddings("model-b", 2, &[1.0, 0.0], 5)
            .unwrap()[0]
            .stable_id,
        "retained"
    );
    reopened
        .upsert_document(
            &fixture.root(),
            &tests::document(path, "retained", "hash-new", "retainedquasar updated"),
        )
        .unwrap();
    reopened.inspect_connection(|c| {
        assert_eq!(
            c.query_row("SELECT count(*) FROM pins", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        verify(c);
    });
}

#[test]
fn interrupted_migrations_reopen_without_losing_authoritative_rows() {
    for version in 0..=4 {
        let fixture = RecoveryFixture::new(&format!("interrupt-migration-{version}"));
        let dbpath = fixture.root().parent().unwrap().join("migration.sqlite");
        let connection = Connection::open(&dbpath).unwrap();
        configure(&connection).unwrap();
        if version > 0 {
            migrate(&connection).unwrap();
            connection.execute_batch("INSERT INTO files(id,stable_id,root_path,path,name,content_hash,extraction_version,index_revision) VALUES(1,'kept','synthetic','synthetic/report.txt','report.txt','hash','lumen-extract-v2',1);
                INSERT INTO chunks(id,file_id,ordinal,text,extraction_kind,content_hash,index_revision) VALUES(1,1,0,'keptquasar','text','hash',1);
                INSERT INTO search_fts(file_id,chunk_id,name,path,body) VALUES(1,1,'report.txt','synthetic/report.txt','keptquasar');
                INSERT INTO query_history(query) VALUES('keptquasar');
                DROP TABLE file_inventory;").unwrap();
            if version <= 2 {
                connection.execute_batch("DROP TABLE pins; DROP TABLE file_access_history; DROP TABLE embedding_jobs;").unwrap();
                if version == 1 {
                    connection
                        .execute_batch("DROP TABLE vector_embeddings;")
                        .unwrap();
                }
            } else {
                connection.execute_batch("INSERT INTO pins(file_id) VALUES(1); INSERT INTO file_access_history(file_id) VALUES(1);").unwrap();
            }
            if version >= 2 {
                connection.execute_batch("INSERT INTO vector_embeddings(chunk_id,embedding,embedding_model,dimension,distance_metric,content_hash,index_revision) VALUES(1,x'0000803f','retained-model',1,'cosine','hash',1)").unwrap();
            }
            connection
                .pragma_update(None, "user_version", version)
                .unwrap();
            connection
                .execute_batch("DROP INDEX IF EXISTS enrichment_artifacts_file;")
                .unwrap();
        }
        let target = match version {
            0 => "CREATE TABLE chunks",
            1 | 2 => "CREATE TABLE pins",
            3 => "CREATE INDEX IF NOT EXISTS file_access_history_file_recent",
            _ => "CREATE INDEX IF NOT EXISTS enrichment_artifacts_file",
        };
        arm(&connection, target);
        let error = migrate(&connection).unwrap_err();
        disarm(&connection);
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::OperationInterrupted),
            "version={version} {error:?}"
        );
        let autocommit = connection.is_autocommit();
        if !autocommit {
            connection.execute_batch("ROLLBACK").unwrap();
        }
        println!(
            "TASK13 migration version={version} SQLite_INTERRUPT autocommit_after_error={autocommit}"
        );
        drop(connection);
        for _ in 0..2 {
            let database = IndexDatabase::open(&dbpath, Path::new("missing-vector.dll")).unwrap();
            database.inspect_connection(|c| {
                verify(c);
                assert_eq!(
                    c.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
                        .unwrap(),
                    4
                );
                assert_eq!(
                    c.query_row("SELECT count(*) FROM files", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    i64::from(version > 0)
                );
                if version > 0 {
                    assert_eq!(
                        c.query_row("SELECT text FROM chunks", [], |r| r.get::<_, String>(0))
                            .unwrap(),
                        "keptquasar"
                    );
                    assert_eq!(
                        c.query_row("SELECT content_hash FROM files", [], |r| r
                            .get::<_, String>(0))
                            .unwrap(),
                        "hash"
                    );
                    assert_eq!(
                        c.query_row(
                            "SELECT count(*) FROM search_fts WHERE search_fts MATCH 'keptquasar'",
                            [],
                            |r| r.get::<_, i64>(0)
                        )
                        .unwrap(),
                        1
                    );
                    assert_eq!(
                        c.query_row("SELECT count(*) FROM query_history", [], |r| r
                            .get::<_, i64>(0))
                            .unwrap(),
                        1
                    );
                    if version >= 3 {
                        assert_eq!(
                            c.query_row("SELECT count(*) FROM pins", [], |r| r.get::<_, i64>(0))
                                .unwrap(),
                            1
                        );
                    }
                    if version >= 2 {
                        assert_eq!(
                            c.query_row("SELECT content_hash FROM vector_embeddings", [], |r| {
                                r.get::<_, String>(0)
                            })
                            .unwrap(),
                            "hash"
                        );
                    }
                }
            });
        }
    }
}
