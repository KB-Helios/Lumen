use super::*;
use crate::search::test_support::SearchFixture;

#[test]
fn enrichment_long_output_reuses_bounded_chunks_and_rolls_back_on_artifact_failure() {
    let fixture = SearchFixture::new("enrichment-rollback");
    let database = IndexDatabase::open(
        &fixture.root().join("index.sqlite"),
        Path::new("missing.dll"),
    )
    .unwrap();
    let path = fixture.file("source.png", b"fixture");
    database
        .upsert_document(fixture.root(), &tests::document(path, "source", "a", ""))
        .unwrap();
    database
        .enqueue_enrichment("source", "ocr", "fixture-route")
        .unwrap();
    let job = database.queued_jobs().unwrap().remove(0);
    {
        let connection = database.connection.lock().unwrap();
        connection.execute_batch("CREATE TRIGGER reject_artifact BEFORE INSERT ON enrichment_artifacts BEGIN SELECT RAISE(ABORT,'owned fixture'); END").unwrap();
    }
    assert!(
        database
            .complete_enrichment(&job, &"z".repeat(64 * 1024), "fixture", "fixture")
            .is_err()
    );
    {
        let connection = database.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM chunks", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT status FROM enrichment_jobs", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "queued"
        );
        connection
            .execute_batch("DROP TRIGGER reject_artifact")
            .unwrap();
    }
    assert!(
        database
            .complete_enrichment(&job, &"z".repeat(64 * 1024), "fixture", "fixture")
            .unwrap()
    );
    let connection = database.connection.lock().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT MAX(length(text)) FROM chunks", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        32 * 1024
    );
}

#[test]
fn enrichment_completion_is_transactional_searchable_and_duplicate_safe() {
    for kind in ["ocr", "transcription"] {
        let fixture = SearchFixture::new("enrichment-commit");
        let database = IndexDatabase::open(
            &fixture.root().join("index.sqlite"),
            Path::new("missing.dll"),
        )
        .unwrap();
        let path = fixture.file("source.png", b"fixture");
        database
            .upsert_document(fixture.root(), &tests::document(path, "source", "a", ""))
            .unwrap();
        database
            .enqueue_enrichment("source", kind, "fixture-route")
            .unwrap();
        let job = database.queued_jobs().unwrap().remove(0);
        assert!(
            database
                .complete_enrichment(&job, "quasar searchable enrichment", "fixture", "fixture")
                .unwrap()
        );
        assert_eq!(
            database.search("quasar", 10).unwrap()[0].stable_id,
            "source"
        );
        assert!(
            !database
                .complete_enrichment(&job, "duplicate", "fixture", "fixture")
                .unwrap()
        );
        let connection = database.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM enrichment_artifacts", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM chunks WHERE text LIKE '%quasar%'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
}

#[test]
fn enrichment_completion_refuses_invalid_output_and_superseded_hash() {
    let fixture = SearchFixture::new("enrichment-stale");
    let database = IndexDatabase::open(
        &fixture.root().join("index.sqlite"),
        Path::new("missing.dll"),
    )
    .unwrap();
    let path = fixture.file("source.png", b"fixture");
    database
        .upsert_document(
            fixture.root(),
            &tests::document(path.clone(), "source", "a", ""),
        )
        .unwrap();
    database
        .enqueue_enrichment("source", "ocr", "fixture-route")
        .unwrap();
    let job = database.queued_jobs().unwrap().remove(0);
    for text in [
        "".to_owned(),
        "bad\0text".to_owned(),
        "x".repeat(64 * 1024 + 1),
    ] {
        assert!(
            database
                .complete_enrichment(&job, &text, "fixture", "fixture")
                .is_err()
        );
    }
    database
        .upsert_document(
            fixture.root(),
            &tests::document(path, "source", "b", "freshbody"),
        )
        .unwrap();
    assert!(
        !database
            .complete_enrichment(&job, "staletext", "fixture", "fixture")
            .unwrap()
    );
    assert!(database.search("staletext", 10).unwrap().is_empty());
}
