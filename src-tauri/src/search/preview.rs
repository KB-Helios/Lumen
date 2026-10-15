use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine as _;

use super::metadata::file_record;
use super::root_policy::{canonicalize_confined, canonicalize_root};
use super::types::{BasicPreview, FileKind, PreviewChild, PreviewKind, SearchFailure};

const MAX_TEXT_BYTES: u64 = 64 * 1024;
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FOLDER_CHILDREN: usize = 48;

pub(super) fn confined_document_path(
    root: &Path,
    path: &Path,
) -> Result<Option<(PathBuf, PathBuf)>, SearchFailure> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Ok(None);
    }
    for ancestor in root.ancestors().chain(path.ancestors()) {
        let Ok(metadata) = fs::symlink_metadata(ancestor) else {
            return Ok(None);
        };
        if metadata.file_type().is_symlink() {
            return Ok(None);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Ok(None);
            }
        }
    }
    let root = canonicalize_root(root)?;
    let path = canonicalize_confined(&root, path)?;
    Ok(Some((root, path)))
}

pub(super) fn document_source_bytes(path: &Path) -> Option<Vec<u8>> {
    let maximum = super::extraction::MAX_SOURCE_BYTES;
    if fs::metadata(path).ok()?.len() > maximum {
        return None;
    }
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= maximum).then_some(bytes)
}

pub(super) fn get_indexed_preview(
    index: &super::IndexRuntime,
    privacy: &crate::privacy::PrivacyRuntime,
    root: &Path,
    path: &Path,
) -> Result<BasicPreview, SearchFailure> {
    privacy.ensure_previews_enabled()?;
    let mut preview = get_basic_preview_impl(root, path)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "pdf" | "docx" | "pptx" | "xlsx")
        && let Some(source) = index.capture_document_preview(root, path)?
    {
        if extension == "xlsx" {
            if let Ok(table) = super::extraction::xlsx_preview(&source.bytes, &source.path) {
                preview.rows = Some(table.rows);
                preview.columns = Some(table.columns);
                preview.metadata.insert(
                    "Preview".to_owned(),
                    "Worksheet sheet1.xml: A1:L40, cached values only".to_owned(),
                );
            } else {
                preview.metadata.insert(
                    "Preview".to_owned(),
                    "Worksheet unavailable, invalid or exceeds preview limits".to_owned(),
                );
            }
        } else if let Some(hit) = &source.hit
            && hit.extraction_kind != "metadata"
            && !hit.snippet.trim().is_empty()
            && !hit.snippet.contains('\0')
        {
            let mut end = hit.snippet.len().min(super::extraction::MAX_PREVIEW_BYTES);
            while !hit.snippet.is_char_boundary(end) {
                end -= 1;
            }
            preview.text = Some(hit.snippet[..end].to_owned());
            preview.metadata.insert(
                "Preview".to_owned(),
                "Indexed excerpt (up to 64 KiB)".to_owned(),
            );
            if let Some(page) = hit.page {
                preview.metadata.insert("Page".to_owned(), page.to_string());
            }
        }
        admit_document_preview(index, privacy, &source, &mut preview)?;
    }
    privacy.ensure_previews_enabled()?;
    Ok(preview)
}

pub(super) fn admit_document_preview(
    index: &super::IndexRuntime,
    privacy: &crate::privacy::PrivacyRuntime,
    source: &super::indexing::DocumentPreviewSource,
    preview: &mut BasicPreview,
) -> Result<(), SearchFailure> {
    privacy.ensure_previews_enabled()?;
    if !index.document_preview_is_current(source)? {
        preview.text = None;
        preview.rows = None;
        preview.columns = None;
        preview.metadata.remove("Page");
        preview.metadata.insert(
            "Preview".to_owned(),
            "Source or index changed; preview unavailable".to_owned(),
        );
    }
    privacy.ensure_previews_enabled()
}

fn read_prefix(path: &Path, limit: u64) -> Result<(Vec<u8>, bool), SearchFailure> {
    let file =
        File::open(path).map_err(|error| SearchFailure::from_io("open a preview", path, &error))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| SearchFailure::from_io("read a preview", path, &error))?;
    let truncated = bytes.len() > usize::try_from(limit).unwrap_or(usize::MAX);
    bytes.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    Ok((bytes, truncated))
}

fn text_kind(extension: &str) -> Option<PreviewKind> {
    match extension {
        "md" | "markdown" => Some(PreviewKind::Markdown),
        "c" | "cc" | "cpp" | "cs" | "css" | "go" | "h" | "hpp" | "html" | "java" | "js" | "jsx"
        | "json" | "kt" | "kts" | "lua" | "php" | "py" | "rb" | "rs" | "scss" | "sh" | "sql"
        | "swift" | "toml" | "ts" | "tsx" | "vue" | "xml" | "yaml" | "yml" => {
            Some(PreviewKind::Source)
        }
        "log" | "rtf" | "txt" => Some(PreviewKind::Text),
        _ => None,
    }
}

fn image_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "gif" => Some("image/gif"),
        "ico" => Some("image/x-icon"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn passive_kind(kind: FileKind) -> PreviewKind {
    match kind {
        FileKind::Folder => PreviewKind::Folder,
        FileKind::Pdf => PreviewKind::Pdf,
        FileKind::Document => PreviewKind::Document,
        FileKind::Spreadsheet => PreviewKind::Spreadsheet,
        FileKind::Presentation => PreviewKind::Presentation,
        FileKind::Source => PreviewKind::Source,
        FileKind::Image => PreviewKind::Image,
        FileKind::Video => PreviewKind::Video,
        FileKind::Audio => PreviewKind::Audio,
        FileKind::Archive | FileKind::Executable | FileKind::Model | FileKind::Unknown => {
            PreviewKind::Unsupported
        }
    }
}

fn folder_children(root: &Path, path: &Path) -> Vec<PreviewChild> {
    let mut children = fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if file_type.is_symlink() {
                return None;
            }
            let child_path = canonicalize_confined(root, &entry.path()).ok()?;
            let record = file_record(root, &child_path).ok()?;
            Some(PreviewChild {
                id: record.relative_path.clone(),
                name: record.name,
                kind: record.kind,
            })
        })
        .collect::<Vec<_>>();
    children.sort_by_key(|item| item.name.to_lowercase());
    children.truncate(MAX_FOLDER_CHILDREN);
    children
}

pub fn get_basic_preview_impl(root: &Path, path: &Path) -> Result<BasicPreview, SearchFailure> {
    let root = canonicalize_root(root)?;
    let path = canonicalize_confined(&root, path)?;
    let record = file_record(&root, &path)?;
    let extension = record.extension.as_deref().unwrap_or_default();
    let mut metadata = BTreeMap::from([
        ("Path".to_owned(), record.relative_path.clone()),
        ("Size".to_owned(), record.size_bytes.to_string()),
        ("Type".to_owned(), extension.to_ascii_uppercase()),
    ]);
    if let Some(modified_ms) = record.modified_ms {
        metadata.insert("Modified".to_owned(), modified_ms.to_string());
    }

    let mut preview = BasicPreview {
        kind: passive_kind(record.kind),
        title: record.name,
        subtitle: record.path,
        text: None,
        rows: None,
        columns: None,
        source_url: None,
        mime_type: None,
        children: Vec::new(),
        metadata,
    };

    if matches!(extension, "pdf" | "docx" | "pptx" | "xlsx") {
        preview.metadata.insert(
            "Preview".to_owned(),
            "Content unavailable or awaiting current local indexing".to_owned(),
        );
    }

    if record.kind == FileKind::Folder {
        preview.children = folder_children(&root, &path);
        preview
            .metadata
            .insert("Items shown".to_owned(), preview.children.len().to_string());
        return Ok(preview);
    }

    if let Some(kind) = text_kind(extension) {
        let (bytes, truncated) = read_prefix(&path, MAX_TEXT_BYTES)?;
        let has_binary_controls = bytes.contains(&0);
        if has_binary_controls {
            preview.kind = PreviewKind::Unsupported;
            return Ok(preview);
        }
        match String::from_utf8(bytes) {
            Ok(text) => {
                if truncated {
                    preview
                        .metadata
                        .insert("Preview".to_owned(), "Truncated".to_owned());
                }
                preview.kind = kind;
                preview.text = Some(text);
            }
            Err(_) => preview.kind = PreviewKind::Unsupported,
        }
        return Ok(preview);
    }

    if let Some(mime_type) = image_mime(extension) {
        let (bytes, truncated) = read_prefix(&path, MAX_IMAGE_BYTES)?;
        if truncated {
            preview.metadata.insert(
                "Preview".to_owned(),
                "Image exceeds 4 MiB preview limit".to_owned(),
            );
        } else {
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            preview.source_url = Some(format!("data:{mime_type};base64,{encoded}"));
            preview.mime_type = Some(mime_type.to_owned());
        }
    }

    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::test_support::SearchFixture;

    #[test]
    fn binary_content_is_never_returned_as_text() {
        let fixture = SearchFixture::new("binary-preview");
        let path = fixture.file("payload.txt", &[0, 159, 146, 150]);

        let preview = get_basic_preview_impl(fixture.root(), &path).unwrap();
        assert_eq!(preview.kind, PreviewKind::Unsupported);
        assert!(preview.text.is_none());
    }

    #[test]
    fn text_preview_is_bounded() {
        let fixture = SearchFixture::new("bounded-preview");
        let path = fixture.file("large.txt", &vec![b'a'; 80 * 1024]);

        let preview = get_basic_preview_impl(fixture.root(), &path).unwrap();
        assert_eq!(preview.text.unwrap(), "a".repeat(64 * 1024));
        assert_eq!(
            preview.metadata.get("Preview"),
            Some(&"Truncated".to_owned())
        );
    }

    #[test]
    fn raster_images_use_bounded_data_urls() {
        let fixture = SearchFixture::new("image-preview");
        let path = fixture.file("sample.png", b"not-a-real-png-but-passive-bytes");

        let preview = get_basic_preview_impl(fixture.root(), &path).unwrap();
        assert_eq!(preview.kind, PreviewKind::Image);
        assert!(
            preview
                .source_url
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
    }

    #[test]
    fn unindexed_documents_have_an_honest_passive_state() {
        let fixture = SearchFixture::new("unindexed-document-preview");
        for name in ["brief.pdf", "brief.docx", "brief.pptx", "brief.xlsx"] {
            let path = fixture.file(name, b"pending extraction");
            let preview = get_basic_preview_impl(fixture.root(), &path).unwrap();
            assert!(preview.text.is_none());
            assert!(preview.rows.is_none());
            assert!(preview.metadata.contains_key("Preview"));
        }
    }

    #[test]
    fn raster_boundary_and_legacy_formats_keep_their_passive_contract() {
        let fixture = SearchFixture::new("preview-format-boundaries");
        for (size, available) in [(4 * 1024 * 1024, true), (4 * 1024 * 1024 + 1, false)] {
            let path = fixture.file("image.png", &vec![1; size]);
            assert_eq!(
                get_basic_preview_impl(fixture.root(), &path)
                    .unwrap()
                    .source_url
                    .is_some(),
                available
            );
        }
        for name in [
            "legacy.doc",
            "legacy.xls",
            "legacy.ppt",
            "document.odt",
            "archive.zip",
            "app.exe",
            "model.gguf",
            "music.mp3",
            "clip.mp4",
        ] {
            let path = fixture.file(name, b"passive metadata only");
            let preview = get_basic_preview_impl(fixture.root(), &path).unwrap();
            assert!(preview.text.is_none());
            assert!(preview.source_url.is_none());
            assert!(preview.rows.is_none());
        }
    }
}
