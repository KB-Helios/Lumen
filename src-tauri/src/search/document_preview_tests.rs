use super::*;
use crate::search::{preview, test_support::SearchFixture};
use std::fs::File;
use std::io::Write;
use zip::write::SimpleFileOptions;

fn office(fixture: &SearchFixture, name: &str, entry: &str, xml: &str) -> PathBuf {
    let path = fixture.file(name, b"");
    let mut archive = zip::ZipWriter::new(File::create(&path).unwrap());
    archive
        .start_file(
            entry,
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
    archive.write_all(xml.as_bytes()).unwrap();
    archive.finish().unwrap();
    path
}

fn runtime(fixture: &SearchFixture) -> IndexRuntime {
    IndexRuntime::open(
        &fixture.root().parent().unwrap().join("preview.sqlite"),
        Path::new("missing.dll"),
        false,
    )
    .unwrap()
}

fn root(fixture: &SearchFixture) -> IndexRootRequest {
    IndexRootRequest {
        path: fixture.root().to_string_lossy().into_owned(),
        cloud_enrichment: false,
        exclusions: vec![],
        include_hidden: false,
        max_file_size_mb: 64,
    }
}

#[test]
fn cached_office_preview_requires_current_source_and_local_root_without_cloud_consent() {
    let fixture = SearchFixture::new("cached-office-preview");
    let path = office(
        &fixture,
        "brief.docx",
        "word/document.xml",
        "<w:document><w:p><w:t>Quarterly &amp; annual</w:t></w:p></w:document>",
    );
    let runtime = runtime(&fixture);
    runtime.synchronize_for_test(vec![root(&fixture)]).unwrap();
    let privacy = crate::privacy::PrivacyRuntime::default();
    let preview = preview::get_indexed_preview(&runtime, &privacy, fixture.root(), &path).unwrap();
    assert_eq!(preview.text.as_deref(), Some("Quarterly & annual"));
    assert_eq!(preview.kind, super::super::types::PreviewKind::Document);
    let mut bytes = std::fs::read(&path).unwrap();
    // Same length and preserved mtime still must fail the content hash fence.
    let times = std::fs::metadata(&path).unwrap().modified().unwrap();
    let offset = bytes
        .windows(9)
        .position(|part| part == b"Quarterly")
        .unwrap();
    bytes[offset] = b'X';
    std::fs::write(&path, bytes).unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(times))
        .unwrap();
    let preview = preview::get_indexed_preview(&runtime, &privacy, fixture.root(), &path).unwrap();
    assert!(preview.text.is_none());
    runtime.stop_index_worker();
}

#[test]
fn cached_preview_capture_cannot_survive_revision_generation_grant_or_privacy_changes() {
    let fixture = SearchFixture::new("cached-preview-fences");
    let path = office(
        &fixture,
        "brief.pptx",
        "ppt/slides/slide1.xml",
        "<p:sld><a:t>Slide excerpt</a:t></p:sld>",
    );
    let runtime = runtime(&fixture);
    runtime.synchronize_for_test(vec![root(&fixture)]).unwrap();
    let captured = runtime
        .capture_document_preview(fixture.root(), &path)
        .unwrap()
        .unwrap();
    assert!(runtime.document_preview_is_current(&captured).unwrap());
    let id = captured.hit.as_ref().unwrap().stable_id.clone();
    let connection =
        rusqlite::Connection::open(fixture.root().parent().unwrap().join("preview.sqlite"))
            .unwrap();
    connection
        .execute(
            "UPDATE files SET index_revision=index_revision+1 WHERE stable_id=?1",
            [&id],
        )
        .unwrap();
    assert!(!runtime.document_preview_is_current(&captured).unwrap());
    let captured = runtime
        .capture_document_preview(fixture.root(), &path)
        .unwrap()
        .unwrap();
    runtime.configure_roots(vec![], true).unwrap();
    assert!(!runtime.document_preview_is_current(&captured).unwrap());
    let privacy = crate::privacy::PrivacyRuntime::default();
    privacy.set_previews_enabled(false);
    assert_eq!(
        preview::get_indexed_preview(&runtime, &privacy, fixture.root(), &path)
            .unwrap_err()
            .code,
        "permission-denied"
    );
    runtime.stop_index_worker();
}

#[test]
fn legacy_extraction_records_cannot_supply_document_preview_bodies() {
    let fixture = SearchFixture::new("legacy-preview-provenance");
    let path = office(
        &fixture,
        "brief.docx",
        "word/document.xml",
        "<document><t>Legacy excerpt</t></document>",
    );
    let runtime = runtime(&fixture);
    runtime.synchronize_for_test(vec![root(&fixture)]).unwrap();
    let connection =
        rusqlite::Connection::open(fixture.root().parent().unwrap().join("preview.sqlite"))
            .unwrap();
    connection
        .execute("UPDATE files SET extraction_version='lumen-extract-v1'", [])
        .unwrap();
    let preview = preview::get_indexed_preview(
        &runtime,
        &crate::privacy::PrivacyRuntime::default(),
        fixture.root(),
        &path,
    )
    .unwrap();
    assert!(preview.text.is_none());
    let id = runtime
        .stable_id_for_path(&std::fs::canonicalize(&path).unwrap())
        .unwrap()
        .unwrap();
    runtime.set_pinned(&id, true).unwrap();
    runtime.set_history_enabled(true);
    runtime.record_file_open(&id).unwrap();
    runtime.stop_index_worker();
    drop(runtime);
    // A fresh worker has no completed signatures: ordinary root admission
    // re-extracts legacy rows, preserving identity, pins and open history.
    let reopened = self::runtime(&fixture);
    reopened.synchronize_for_test(vec![root(&fixture)]).unwrap();
    let preview = preview::get_indexed_preview(
        &reopened,
        &crate::privacy::PrivacyRuntime::default(),
        fixture.root(),
        &path,
    )
    .unwrap();
    assert_eq!(preview.text.as_deref(), Some("Legacy excerpt"));
    assert!(reopened.database.ranking_signals(&id).unwrap().1);
    let count: i64 = connection
        .query_row("SELECT count(*) FROM file_access_history", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
    reopened.stop_index_worker();
}

#[test]
fn real_pdf_and_presentation_excerpts_and_no_text_pdf_stay_passive() {
    let fixture = SearchFixture::new("document-fixtures");
    let pdf = fixture.file(
        "brief.pdf",
        &crate::search::test_support::small_pdf(Some("Real PDF excerpt")),
    );
    let scan = fixture.file("scan.pdf", &crate::search::test_support::small_pdf(None));
    let pptx = office(
        &fixture,
        "slides.pptx",
        "ppt/slides/slide1.xml",
        "<p:sld><a:t>Slide &lt;script&gt; excerpt</a:t></p:sld>",
    );
    let runtime = runtime(&fixture);
    runtime.synchronize_for_test(vec![root(&fixture)]).unwrap();
    let privacy = crate::privacy::PrivacyRuntime::default();
    for (path, expected) in [
        (&pdf, "Real PDF excerpt"),
        (&pptx, "Slide <script> excerpt"),
    ] {
        let preview =
            preview::get_indexed_preview(&runtime, &privacy, fixture.root(), path).unwrap();
        assert!(preview.text.unwrap().contains(expected));
    }
    let preview = preview::get_indexed_preview(&runtime, &privacy, fixture.root(), &scan).unwrap();
    assert!(preview.text.is_none());
    assert!(preview.metadata.contains_key("Preview"));
    runtime.stop_index_worker();
}

#[test]
fn pending_metadata_only_removed_oversized_and_revoked_sources_never_admit_bodies() {
    let fixture = SearchFixture::new("document-unavailable");
    let path = office(
        &fixture,
        "brief.docx",
        "word/document.xml",
        "<document><t>Excerpt</t></document>",
    );
    let runtime = runtime(&fixture);
    runtime
        .configure_roots(vec![root(&fixture)], false)
        .unwrap();
    let privacy = crate::privacy::PrivacyRuntime::default();
    let preview = preview::get_indexed_preview(&runtime, &privacy, fixture.root(), &path).unwrap();
    assert!(preview.text.is_none());
    runtime.synchronize_for_test(vec![root(&fixture)]).unwrap();
    let captured = runtime
        .capture_document_preview(fixture.root(), &path)
        .unwrap()
        .unwrap();
    let mut preview = preview::get_basic_preview_impl(fixture.root(), &path).unwrap();
    preview.text = Some("captured body".to_owned());
    privacy.set_previews_enabled(false);
    assert_eq!(
        preview::admit_document_preview(&runtime, &privacy, &captured, &mut preview)
            .unwrap_err()
            .code,
        "permission-denied"
    );
    privacy.set_previews_enabled(true);
    runtime.delete_indexed_content().unwrap();
    preview::admit_document_preview(&runtime, &privacy, &captured, &mut preview).unwrap();
    assert!(preview.text.is_none());
    assert!(!runtime.document_preview_is_current(&captured).unwrap());
    std::fs::remove_file(&path).unwrap();
    assert!(!runtime.document_preview_is_current(&captured).unwrap());
    let oversized = fixture.file("large.pdf", b"");
    File::options()
        .write(true)
        .open(&oversized)
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    assert!(preview::document_source_bytes(&oversized).is_none());
    runtime.stop_index_worker();
}

#[cfg(windows)]
#[test]
fn document_admission_rejects_original_symlinks_and_junctions_inside_and_outside_root() {
    let fixture = SearchFixture::new("document-reparse");
    let path = office(
        &fixture,
        "real/brief.docx",
        "word/document.xml",
        "<document><t>Excerpt</t></document>",
    );
    let outside = fixture.outside_file("brief.docx", b"outside");
    for (name, target) in [("inside-link.docx", &path), ("outside-link.docx", &outside)] {
        let linked = fixture.root().join(name);
        std::os::windows::fs::symlink_file(target, &linked).unwrap();
        assert!(
            preview::confined_document_path(fixture.root(), &linked)
                .unwrap()
                .is_none()
        );
        std::fs::remove_file(linked).unwrap();
    }
    for (name, target) in [
        ("inside-junction", path.parent().unwrap()),
        ("outside-junction", outside.parent().unwrap()),
    ] {
        let linked = fixture.root().join(name);
        // This fixture creates only owned temporary directory junctions.
        let status = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&linked)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        assert!(
            preview::confined_document_path(fixture.root(), &linked.join("brief.docx"))
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir(linked).unwrap();
    }
}

#[test]
fn worksheet_preview_reaches_the_native_dto_without_content_indexing_or_cloud_consent() {
    let fixture = SearchFixture::new("native-worksheet-dto");
    let path = office(
        &fixture,
        "book.xlsx",
        "xl/worksheets/sheet1.xml",
        "<worksheet><c r=\"C2\" t=\"inlineStr\"><is><t>Literal &lt;script&gt;</t></is></c></worksheet>",
    );
    let runtime = runtime(&fixture);
    runtime
        .configure_roots(vec![root(&fixture)], false)
        .unwrap();
    let preview = preview::get_indexed_preview(
        &runtime,
        &crate::privacy::PrivacyRuntime::default(),
        fixture.root(),
        &path,
    )
    .unwrap();
    assert_eq!(
        preview.rows.as_ref().unwrap()[1],
        ["", "", "Literal <script>"]
    );
    assert_eq!(preview.columns.as_ref().unwrap(), &["A", "B", "C"]);
    let dto = serde_json::to_value(&preview).unwrap();
    assert_eq!(dto["rows"][1][2], "Literal <script>");
    assert_eq!(dto["columns"][2], "C");
    runtime.stop_index_worker();
}

#[test]
fn cached_document_body_is_bounded_in_utf8_and_refuses_mismatched_chunk_provenance() {
    let fixture = SearchFixture::new("cached-preview-body-budget");
    let path = office(
        &fixture,
        "brief.docx",
        "word/document.xml",
        "<document><t>Excerpt</t></document>",
    );
    let runtime = runtime(&fixture);
    runtime.synchronize_for_test(vec![root(&fixture)]).unwrap();
    let connection =
        rusqlite::Connection::open(fixture.root().parent().unwrap().join("preview.sqlite"))
            .unwrap();
    connection
        .execute("UPDATE chunks SET text=?1", ["😀".repeat(20_000)])
        .unwrap();
    let preview = preview::get_indexed_preview(
        &runtime,
        &crate::privacy::PrivacyRuntime::default(),
        fixture.root(),
        &path,
    )
    .unwrap();
    assert_eq!(preview.text.unwrap(), "😀".repeat(16_384));
    connection
        .execute("UPDATE chunks SET content_hash='superseded'", [])
        .unwrap();
    let preview = preview::get_indexed_preview(
        &runtime,
        &crate::privacy::PrivacyRuntime::default(),
        fixture.root(),
        &path,
    )
    .unwrap();
    assert!(preview.text.is_none());
    connection.execute("UPDATE chunks SET content_hash=(SELECT content_hash FROM files WHERE files.id=chunks.file_id), index_revision=index_revision+1", []).unwrap();
    let preview = preview::get_indexed_preview(
        &runtime,
        &crate::privacy::PrivacyRuntime::default(),
        fixture.root(),
        &path,
    )
    .unwrap();
    assert!(preview.text.is_none());
    runtime.stop_index_worker();
}
