use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::index::IndexedChunk;

const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_OFFICE_XML_BYTES: u64 = 16 * 1024 * 1024;
const CHUNK_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct ExtractedDocument {
    pub content_hash: String,
    pub extraction_version: String,
    pub chunks: Vec<IndexedChunk>,
    pub pending_enrichment: Option<String>,
}

fn failure(path: &Path, error: impl std::fmt::Display) -> ExtractionError {
    ExtractionError::Failed {
        path: path.to_string_lossy().into_owned(),
        message: error.to_string(),
    }
}

pub(super) fn chunks_from_text(
    text: &str,
    extraction_kind: &str,
    page: Option<u32>,
) -> Vec<IndexedChunk> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + CHUNK_BYTES).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        let fragment = text[start..end].trim();
        if !fragment.is_empty() {
            chunks.push(IndexedChunk {
                text: fragment.to_owned(),
                extraction_kind: extraction_kind.to_owned(),
                page,
                time_start_ms: None,
                time_end_ms: None,
            });
        }
        start = end;
    }
    chunks
}

fn xml_text(xml: &str, path: &Path) -> Result<String, ExtractionError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut text = String::new();
    loop {
        buffer.clear();
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Text(value)) => {
                let decoded = value.decode().map_err(|error| failure(path, error))?;
                let decoded =
                    quick_xml::escape::unescape(&decoded).map_err(|error| failure(path, error))?;
                if !decoded.trim().is_empty() {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    text.push_str(decoded.trim());
                }
            }
            Ok(Event::CData(value)) => {
                let decoded = value.decode().map_err(|error| failure(path, error))?;
                if !decoded.trim().is_empty() {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    text.push_str(decoded.trim());
                }
            }
            Ok(Event::GeneralRef(value)) => {
                let decoded = value.decode().map_err(|error| failure(path, error))?;
                let resolved = value
                    .resolve_char_ref()
                    .map_err(|error| failure(path, error))?
                    .or_else(|| match decoded.as_ref() {
                        "amp" => Some('&'),
                        "apos" => Some('\''),
                        "gt" => Some('>'),
                        "lt" => Some('<'),
                        "quot" => Some('"'),
                        _ => None,
                    });
                if let Some(character) = resolved {
                    if !text.is_empty() && !text.ends_with(char::is_whitespace) {
                        text.push(' ');
                    }
                    text.push(character);
                    text.push(' ');
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(failure(path, error)),
        }
    }
    Ok(text.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn is_office_text_entry(extension: &str, name: &str) -> bool {
    match extension {
        "docx" => {
            name == "word/document.xml"
                || (name.starts_with("word/header") && name.ends_with(".xml"))
                || (name.starts_with("word/footer") && name.ends_with(".xml"))
        }
        "xlsx" => {
            name == "xl/sharedStrings.xml"
                || (name.starts_with("xl/worksheets/") && name.ends_with(".xml"))
        }
        "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
        _ => false,
    }
}

fn extract_office(path: &Path, extension: &str) -> Result<Vec<IndexedChunk>, ExtractionError> {
    let file = File::open(path).map_err(|error| failure(path, error))?;
    let mut archive = ZipArchive::new(file).map_err(|error| failure(path, error))?;
    let mut total_bytes = 0_u64;
    let mut combined = String::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| failure(path, error))?;
        if !is_office_text_entry(extension, entry.name()) {
            continue;
        }
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > MAX_OFFICE_XML_BYTES {
            return Err(failure(
                path,
                "Office XML exceeds the 16 MiB extraction limit",
            ));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or_default());
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| failure(path, error))?;
        let xml = String::from_utf8(bytes).map_err(|error| failure(path, error))?;
        let extracted = xml_text(&xml, path)?;
        if !extracted.is_empty() {
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(&extracted);
        }
    }
    Ok(chunks_from_text(&combined, "office-xml", None))
}

fn extract_pdf(path: &Path) -> Result<(Vec<IndexedChunk>, Option<String>), ExtractionError> {
    let pages = pdf_extract::extract_text_by_pages(path).map_err(|error| failure(path, error))?;
    let chunks = pages
        .iter()
        .enumerate()
        .flat_map(|(index, text)| chunks_from_text(text, "pdf-text", u32::try_from(index + 1).ok()))
        .collect::<Vec<_>>();
    let pending = chunks.is_empty().then(|| "ocr".to_owned());
    Ok((chunks, pending))
}

pub fn extract_document(path: &Path) -> Result<ExtractedDocument, ExtractionError> {
    let metadata = fs::metadata(path).map_err(|error| failure(path, error))?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(failure(
            path,
            "File exceeds the 64 MiB local extraction limit",
        ));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| failure(path, error))?
        .take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| failure(path, error))?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(failure(
            path,
            "File exceeds the 64 MiB local extraction limit",
        ));
    }
    let digest = Sha256::digest(&bytes);
    let content_hash = digest
        .iter()
        .fold(String::with_capacity(64), |mut hash, byte| {
            write!(&mut hash, "{byte:02x}").expect("writing to a String cannot fail");
            hash
        });
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let (chunks, pending_enrichment) = match extension.as_str() {
        "c" | "cc" | "cpp" | "cs" | "css" | "csv" | "go" | "h" | "hpp" | "html" | "java" | "js"
        | "jsx" | "json" | "kt" | "kts" | "log" | "lua" | "md" | "markdown" | "php" | "py"
        | "rb" | "rs" | "scss" | "sh" | "sql" | "swift" | "toml" | "ts" | "tsx" | "txt" | "vue"
        | "xml" | "yaml" | "yml" => {
            if bytes.contains(&0) {
                (Vec::new(), None)
            } else {
                let text = String::from_utf8(bytes).map_err(|error| failure(path, error))?;
                (chunks_from_text(&text, "text", None), None)
            }
        }
        "docx" | "xlsx" | "pptx" => (extract_office(path, &extension)?, None),
        "pdf" => extract_pdf(path)?,
        "avif" | "bmp" | "gif" | "ico" | "jpeg" | "jpg" | "png" | "webp" => {
            (Vec::new(), Some("ocr".to_owned()))
        }
        "aac" | "avi" | "flac" | "m4a" | "m4v" | "mkv" | "mov" | "mp3" | "mp4" | "ogg" | "wav"
        | "webm" | "wma" | "wmv" => (Vec::new(), Some("transcription".to_owned())),
        _ => (Vec::new(), None),
    };

    Ok(ExtractedDocument {
        content_hash,
        extraction_version: "lumen-extract-v1".to_owned(),
        chunks,
        pending_enrichment,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum ExtractionError {
    #[error("Could not extract {path}: {message}")]
    Failed { path: String, message: String },
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::io::Write;

    use zip::write::SimpleFileOptions;

    use super::*;
    use crate::search::test_support::SearchFixture;

    #[test]
    fn extracts_utf8_text_into_bounded_chunks_with_a_content_hash() {
        let fixture = SearchFixture::new("text-extraction");
        let path = fixture.file("notes.txt", "Hello Ångström".repeat(8_000).as_bytes());

        let extracted = extract_document(&path).unwrap();
        assert_eq!(extracted.extraction_version, "lumen-extract-v1");
        assert_eq!(extracted.content_hash.len(), 64);
        assert!(extracted.chunks.len() > 1);
        assert!(
            extracted
                .chunks
                .iter()
                .all(|chunk| chunk.text.len() <= 32 * 1024)
        );
        assert_eq!(extracted.pending_enrichment, None);
    }

    #[test]
    fn extracts_office_xml_without_returning_markup() {
        let fixture = SearchFixture::new("office-extraction");
        let path = fixture.root().join("brief.docx");
        let file = File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(b"<w:document><w:p><w:t>Quarterly &amp; annual</w:t></w:p></w:document>")
            .unwrap();
        archive.finish().unwrap();

        let extracted = extract_document(&path).unwrap();
        assert_eq!(extracted.chunks.len(), 1);
        assert!(extracted.chunks[0].text.contains("Quarterly & annual"));
        assert!(!extracted.chunks[0].text.contains("<w:"));
        assert_eq!(extracted.chunks[0].extraction_kind, "office-xml");
    }

    #[test]
    fn routes_images_to_cloud_enrichment_without_exposing_binary_bytes() {
        let fixture = SearchFixture::new("image-extraction");
        let path = fixture.file("scan.png", &[0, 159, 146, 150]);

        let extracted = extract_document(&path).unwrap();
        assert!(extracted.chunks.is_empty());
        assert_eq!(extracted.pending_enrichment.as_deref(), Some("ocr"));
    }
}
