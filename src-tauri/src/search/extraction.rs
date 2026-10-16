use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::index::IndexedChunk;

pub(super) const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_OFFICE_XML_BYTES: u64 = 16 * 1024 * 1024;
const CHUNK_BYTES: usize = 32 * 1024;
pub(super) const MAX_PREVIEW_BYTES: usize = 64 * 1024;
pub(super) const EXTRACTION_VERSION: &str = "lumen-extract-v2";
const MAX_PREVIEW_ROWS: usize = 40;
const MAX_PREVIEW_COLUMNS: usize = 12;

pub(super) struct WorksheetPreview {
    pub rows: Vec<Vec<String>>,
    pub columns: Vec<String>,
}

fn read_office_xml(
    input: &mut impl Read,
    declared_size: u64,
    total: &mut u64,
    path: &Path,
) -> Result<String, ExtractionError> {
    let remaining = MAX_OFFICE_XML_BYTES.saturating_sub(*total);
    if declared_size > remaining {
        return Err(failure(
            path,
            "Office XML exceeds the 16 MiB extraction limit",
        ));
    }
    let mut bytes = Vec::new();
    input
        .take(remaining + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| failure(path, error))?;
    if bytes.len() as u64 > remaining || bytes.len() as u64 != declared_size {
        return Err(failure(
            path,
            "Office XML exceeds its actual or declared byte limit",
        ));
    }
    *total += bytes.len() as u64;
    String::from_utf8(bytes).map_err(|error| failure(path, error))
}

fn xml_value(event: &Event<'_>, path: &Path) -> Result<Option<String>, ExtractionError> {
    match event {
        Event::Text(value) => {
            let decoded = value.decode().map_err(|error| failure(path, error))?;
            Ok(Some(
                quick_xml::escape::unescape(&decoded)
                    .map_err(|error| failure(path, error))?
                    .into_owned(),
            ))
        }
        Event::CData(value) => Ok(Some(
            value
                .decode()
                .map_err(|error| failure(path, error))?
                .into_owned(),
        )),
        Event::GeneralRef(value) => {
            let decoded = value.decode().map_err(|error| failure(path, error))?;
            let escaped = format!("&{decoded};");
            Ok(Some(
                quick_xml::escape::unescape(&escaped)
                    .map_err(|error| failure(path, error))?
                    .into_owned(),
            ))
        }
        _ => Ok(None),
    }
}

// Pull events stay bounded by actual XML bytes; reject incomplete trees and DTDs.
fn visit_office_xml(
    xml: &str,
    path: &Path,
    mut visit: impl FnMut(&Event<'_>, &Reader<&[u8]>) -> Result<(), ExtractionError>,
) -> Result<(), ExtractionError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().expand_empty_elements = true;
    let mut depth = 0_usize;
    let mut roots = 0;
    loop {
        let event = reader.read_event().map_err(|error| failure(path, error))?;
        match &event {
            Event::Start(_) => {
                if depth == 0 {
                    roots += 1;
                }
                depth += 1;
                if depth > 64 || roots > 1 {
                    return Err(failure(path, "Invalid worksheet XML depth or root"));
                }
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| failure(path, "Unmatched XML end"))?
            }
            Event::DocType(_) => return Err(failure(path, "Worksheet DTDs are unsupported")),
            Event::Eof => {
                return if depth == 0 && roots == 1 {
                    Ok(())
                } else {
                    Err(failure(path, "Incomplete worksheet XML"))
                };
            }
            _ => {}
        }
        visit(&event, &reader)?;
    }
}

fn shared_strings(xml: &str, path: &Path) -> Result<Vec<String>, ExtractionError> {
    let mut strings = Vec::new();
    let mut current = None::<String>;
    let mut in_text = false;
    let mut phonetic_depth = 0_usize;
    visit_office_xml(xml, path, |event, _| {
        match event {
            Event::Start(value) if value.local_name().as_ref() == b"si" => {
                if current.is_some() || strings.len() >= 65_536 {
                    return Err(failure(path, "Shared string limit exceeded"));
                }
                current = Some(String::new());
            }
            Event::Start(value) if value.local_name().as_ref() == b"rPh" => phonetic_depth += 1,
            Event::End(value) if value.local_name().as_ref() == b"rPh" => phonetic_depth -= 1,
            Event::Start(value) if value.local_name().as_ref() == b"t" => {
                in_text = phonetic_depth == 0
            }
            Event::End(value) if value.local_name().as_ref() == b"t" => in_text = false,
            Event::End(value) if value.local_name().as_ref() == b"si" => strings.push(
                current
                    .take()
                    .ok_or_else(|| failure(path, "Invalid shared string"))?,
            ),
            _ if in_text => {
                if let (Some(current), Some(value)) = (&mut current, xml_value(event, path)?) {
                    if current.len() + value.len() > MAX_PREVIEW_BYTES {
                        return Err(failure(path, "Shared string exceeds preview limit"));
                    }
                    current.push_str(&value);
                }
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(strings)
}

fn cell_position(reference: &str) -> Option<(usize, usize)> {
    let letters = reference.bytes().take_while(u8::is_ascii_uppercase).count();
    if letters == 0 || letters == reference.len() {
        return None;
    }
    let mut column = 0_usize;
    for byte in reference.bytes().take(letters) {
        column = column
            .checked_mul(26)?
            .checked_add((byte - b'A' + 1) as usize)?;
    }
    let row = reference[letters..].parse::<usize>().ok()?;
    Some((row.checked_sub(1)?, column.checked_sub(1)?))
}

fn worksheet(
    xml: &str,
    strings: &[String],
    path: &Path,
) -> Result<WorksheetPreview, ExtractionError> {
    let mut rows = vec![vec![String::new(); MAX_PREVIEW_COLUMNS]; MAX_PREVIEW_ROWS];
    let mut position = None;
    let mut cell_type = String::new();
    let mut value = String::new();
    let mut has_value = false;
    let mut in_value = false;
    let mut in_inline = false;
    let mut phonetic_depth = 0_usize;
    let mut height = 0;
    let mut width = 0;
    let mut body_bytes = 0;
    visit_office_xml(xml, path, |event, reader| {
        match event {
            Event::Start(cell) if cell.local_name().as_ref() == b"c" => {
                position = None;
                cell_type.clear();
                value.clear();
                has_value = false;
                for attribute in cell.attributes() {
                    let attribute = attribute.map_err(|error| failure(path, error))?;
                    let decoded = attribute
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            reader.decoder(),
                        )
                        .map_err(|error| failure(path, error))?;
                    match attribute.key.as_ref() {
                        b"r" => position = cell_position(&decoded),
                        b"t" => cell_type = decoded.into_owned(),
                        _ => {}
                    }
                }
                if position.is_none() {
                    return Err(failure(path, "Missing or invalid cell reference"));
                }
            }
            Event::Start(tag) if tag.local_name().as_ref() == b"v" => {
                in_value = true;
                has_value = true;
            }
            Event::Start(tag) if tag.local_name().as_ref() == b"is" && cell_type == "inlineStr" => {
                has_value = true;
            }
            Event::Start(tag) if tag.local_name().as_ref() == b"rPh" => phonetic_depth += 1,
            Event::End(tag) if tag.local_name().as_ref() == b"rPh" => phonetic_depth -= 1,
            Event::Start(tag) if tag.local_name().as_ref() == b"t" && cell_type == "inlineStr" => {
                in_inline = phonetic_depth == 0
            }
            Event::End(tag) if tag.local_name().as_ref() == b"v" => in_value = false,
            Event::End(tag) if tag.local_name().as_ref() == b"t" => in_inline = false,
            Event::End(tag) if tag.local_name().as_ref() == b"c" => {
                let (row, column) = position
                    .take()
                    .ok_or_else(|| failure(path, "Invalid cell"))?;
                if row < MAX_PREVIEW_ROWS && column < MAX_PREVIEW_COLUMNS {
                    let decoded = if !has_value {
                        String::new()
                    } else {
                        match cell_type.as_str() {
                            "s" => strings
                                .get(
                                    value
                                        .trim()
                                        .parse::<usize>()
                                        .map_err(|error| failure(path, error))?,
                                )
                                .ok_or_else(|| failure(path, "Invalid shared string index"))?
                                .clone(),
                            "b" => match value.trim() {
                                "1" => "TRUE".to_owned(),
                                "0" => "FALSE".to_owned(),
                                _ => return Err(failure(path, "Invalid boolean value")),
                            },
                            "" | "n" | "str" | "inlineStr" | "e" | "d" => value.clone(),
                            _ => return Err(failure(path, "Unsupported cell value type")),
                        }
                    };
                    body_bytes = body_bytes - rows[row][column].len() + decoded.len();
                    // Reserve the maximum column-heading bytes (A through L).
                    if body_bytes + MAX_PREVIEW_COLUMNS > MAX_PREVIEW_BYTES {
                        return Err(failure(path, "Worksheet exceeds 64 KiB preview limit"));
                    }
                    rows[row][column] = decoded;
                    height = height.max(row + 1);
                    width = width.max(column + 1);
                }
            }
            _ if in_value || in_inline => {
                if let Some(fragment) = xml_value(event, path)? {
                    if value.len() + fragment.len() > MAX_PREVIEW_BYTES {
                        return Err(failure(path, "Cell exceeds preview limit"));
                    }
                    value.push_str(&fragment);
                }
            }
            _ => {}
        }
        Ok(())
    })?;
    rows.truncate(height);
    for row in &mut rows {
        row.truncate(width);
    }
    let columns = (0..width)
        .map(|index| ((b'A' + index as u8) as char).to_string())
        .collect();
    Ok(WorksheetPreview { rows, columns })
}

pub(super) fn xlsx_preview(bytes: &[u8], path: &Path) -> Result<WorksheetPreview, ExtractionError> {
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(failure(path, "Workbook exceeds source limit"));
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| failure(path, error))?;
    let mut total = 0;
    let strings = match archive.by_name("xl/sharedStrings.xml") {
        Ok(mut entry) => {
            let declared = entry.size();
            shared_strings(
                &read_office_xml(&mut entry, declared, &mut total, path)?,
                path,
            )?
        }
        Err(zip::result::ZipError::FileNotFound) => Vec::new(),
        Err(error) => return Err(failure(path, error)),
    };
    let mut sheet = archive
        .by_name("xl/worksheets/sheet1.xml")
        .map_err(|error| failure(path, error))?;
    let declared = sheet.size();
    worksheet(
        &read_office_xml(&mut sheet, declared, &mut total, path)?,
        &strings,
        path,
    )
}

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
    let mut text = String::new();
    visit_office_xml(xml, path, |event, _| {
        if let Some(fragment) = xml_value(event, path)? {
            text.push_str(&fragment);
        } else if matches!(event, Event::End(_)) {
            text.push(' ');
        }
        Ok(())
    })?;
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

fn extract_office(
    path: &Path,
    extension: &str,
    bytes: &[u8],
) -> Result<Vec<IndexedChunk>, ExtractionError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| failure(path, error))?;
    let mut total_bytes = 0_u64;
    let mut combined = String::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| failure(path, error))?;
        if !is_office_text_entry(extension, entry.name()) {
            continue;
        }
        let declared_size = entry.size();
        let xml = read_office_xml(&mut entry, declared_size, &mut total_bytes, path)?;
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

fn extract_pdf(
    path: &Path,
    bytes: &[u8],
) -> Result<(Vec<IndexedChunk>, Option<String>), ExtractionError> {
    let pages =
        pdf_extract::extract_text_from_mem_by_pages(bytes).map_err(|error| failure(path, error))?;
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
    extract_captured_document(path, &bytes)
}

fn extract_captured_document(
    path: &Path,
    bytes: &[u8],
) -> Result<ExtractedDocument, ExtractionError> {
    let digest = Sha256::digest(bytes);
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
                let text = std::str::from_utf8(bytes).map_err(|error| failure(path, error))?;
                (chunks_from_text(text, "text", None), None)
            }
        }
        "docx" | "xlsx" | "pptx" => (extract_office(path, &extension, bytes)?, None),
        "pdf" => extract_pdf(path, bytes)?,
        "avif" | "bmp" | "gif" | "ico" | "jpeg" | "jpg" | "png" | "webp" => {
            (Vec::new(), Some("ocr".to_owned()))
        }
        "aac" | "avi" | "flac" | "m4a" | "m4v" | "mkv" | "mov" | "mp3" | "mp4" | "ogg" | "wav"
        | "webm" | "wma" | "wmv" => (Vec::new(), Some("transcription".to_owned())),
        _ => (Vec::new(), None),
    };

    Ok(ExtractedDocument {
        content_hash,
        extraction_version: EXTRACTION_VERSION.to_owned(),
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
        assert_eq!(extracted.extraction_version, "lumen-extract-v2");
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

    #[test]
    fn worksheet_values_preserve_shared_rich_inline_sparse_and_cached_cells() {
        let fixture = SearchFixture::new("xlsx-values");
        let path = fixture.root().join("book.xlsx");
        let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, xml) in [
            (
                "xl/sharedStrings.xml",
                "<sst><si><r><t>Rich </t></r><r><t>&amp; text</t></r></si></sst>",
            ),
            (
                "xl/worksheets/sheet1.xml",
                "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"C1\" t=\"inlineStr\"><is><t>&lt;script&gt;</t></is></c><c r=\"D1\"><v>42</v></c><c r=\"E1\" t=\"b\"><v>1</v></c><c r=\"F1\"><f>1+2</f><v>3</v></c><c r=\"G1\"><f>missing()</f></c></row><row r=\"3\"><c r=\"B3\" t=\"str\"><v>cached</v></c></row></sheetData></worksheet>",
            ),
            ("../../outside.xml", "<ignored>never extracted</ignored>"),
        ] {
            archive
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(xml.as_bytes()).unwrap();
        }
        let bytes = archive.finish().unwrap().into_inner();
        let table = xlsx_preview(&bytes, &path).unwrap();
        assert_eq!(
            table.rows[0],
            ["Rich & text", "", "<script>", "42", "TRUE", "3", ""]
        );
        assert_eq!(table.rows[1], vec![""; 7]);
        assert_eq!(table.rows[2][1], "cached");
        assert_eq!(table.columns, ["A", "B", "C", "D", "E", "F", "G"]);
        assert!(
            !fixture
                .root()
                .parent()
                .unwrap()
                .join("outside.xml")
                .exists()
        );
    }

    #[test]
    fn office_xml_reads_enforce_actual_bytes_even_when_declared_size_is_small() {
        let fixture = SearchFixture::new("office-actual-bound");
        let mut total = MAX_OFFICE_XML_BYTES - 4;
        let mut bytes = std::io::Cursor::new(b"unbounded input".as_slice());
        assert!(read_office_xml(&mut bytes, 1, &mut total, fixture.root()).is_err());
        assert_eq!(bytes.position(), 5);
    }

    #[test]
    fn office_extraction_hash_and_text_come_from_the_same_captured_bytes() {
        let fixture = SearchFixture::new("office-captured-source");
        for (name, entry) in [
            ("brief.docx", "word/document.xml"),
            ("slides.pptx", "ppt/slides/slide1.xml"),
        ] {
            let path = fixture.root().join(name);
            let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            archive
                .start_file(entry, SimpleFileOptions::default())
                .unwrap();
            archive
                .write_all(b"<document><t>Captured original</t></document>")
                .unwrap();
            let captured = archive.finish().unwrap().into_inner();
            std::fs::write(&path, b"pathname replaced before parsing").unwrap();
            let document = extract_captured_document(&path, &captured).unwrap();
            assert_eq!(document.chunks[0].text, "Captured original");
            assert_eq!(
                document.content_hash,
                Sha256::digest(&captured)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            assert_eq!(document.extraction_version, EXTRACTION_VERSION);
        }
    }

    #[test]
    fn pdf_extraction_uses_captured_bytes_without_reopening_a_replaced_path() {
        let fixture = SearchFixture::new("pdf-captured-source");
        let path = fixture.file("brief.pdf", b"replaced invalid pathname contents");
        let captured = crate::search::test_support::small_pdf(Some("Captured PDF text"));
        let document = extract_captured_document(&path, &captured).unwrap();
        assert!(document.chunks[0].text.contains("Captured PDF text"));
        assert_eq!(
            document.content_hash,
            Sha256::digest(&captured)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
    }

    fn workbook(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, xml) in entries {
            archive
                .start_file(
                    *name,
                    SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .unwrap();
            archive.write_all(xml.as_bytes()).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    #[test]
    fn review_xlsx_shared_strings_exclude_phonetic_hints_from_plain_and_rich_values() {
        let fixture = SearchFixture::new("xlsx-shared-phonetic");
        let bytes = workbook(&[
            (
                "xl/sharedStrings.xml",
                "<sst><si><t>東京</t><rPh sb=\"0\" eb=\"2\"><t>とうきょう</t></rPh></si><si><r><t>東</t></r><r><t>京</t></r><rPh sb=\"0\" eb=\"2\"><t>とうきょう</t></rPh></si></sst>",
            ),
            (
                "xl/worksheets/sheet1.xml",
                "<worksheet><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></worksheet>",
            ),
        ]);
        let table = xlsx_preview(&bytes, &fixture.root().join("phonetic.xlsx")).unwrap();
        assert_eq!(table.rows[0], ["東京", "東京"]);
    }

    #[test]
    fn review_xlsx_inline_strings_exclude_phonetic_hints_from_plain_and_rich_values() {
        let fixture = SearchFixture::new("xlsx-inline-phonetic");
        let bytes = workbook(&[(
            "xl/worksheets/sheet1.xml",
            "<worksheet><c r=\"A1\" t=\"inlineStr\"><is><t>東京</t><rPh sb=\"0\" eb=\"2\"><t>とうきょう</t></rPh></is></c><c r=\"B1\" t=\"inlineStr\"><is><r><t>東</t></r><r><t>京</t></r><rPh sb=\"0\" eb=\"2\"><t>とうきょう</t></rPh></is></c></worksheet>",
        )]);
        let table = xlsx_preview(&bytes, &fixture.root().join("phonetic.xlsx")).unwrap();
        assert_eq!(table.rows[0], ["東京", "東京"]);
    }

    #[test]
    fn review_xlsx_absent_typed_cached_values_are_blank_and_preserve_real_neighbors() {
        let fixture = SearchFixture::new("xlsx-absent-cached-values");
        let bytes = workbook(&[(
            "xl/worksheets/sheet1.xml",
            "<worksheet><c r=\"A1\" t=\"b\"><f>1=1</f></c><c r=\"B1\" t=\"s\"><f>CONCAT(&quot;a&quot;,&quot;b&quot;)</f></c><c r=\"C1\" t=\"s\"/><c r=\"D1\" t=\"inlineStr\"><is/></c><c r=\"E1\"><v>7</v></c></worksheet>",
        )]);
        let table = xlsx_preview(&bytes, &fixture.root().join("cached.xlsx")).unwrap();
        assert_eq!(table.rows[0], ["", "", "", "", "7"]);
    }

    #[test]
    fn review_xlsx_present_malformed_typed_values_still_reject_the_sheet() {
        let fixture = SearchFixture::new("xlsx-present-invalid-values");
        for (cell_type, cached) in [
            ("b", "<v/>"),
            ("b", "<v>2</v>"),
            ("s", "<v/>"),
            ("s", "<v>bad</v>"),
            ("s", "<v>9</v>"),
        ] {
            let xml = format!(
                "<worksheet><c r=\"A1\" t=\"{cell_type}\">{cached}</c><c r=\"B1\"><v>7</v></c></worksheet>"
            );
            let bytes = workbook(&[
                ("xl/sharedStrings.xml", "<sst><si><t>real</t></si></sst>"),
                ("xl/worksheets/sheet1.xml", &xml),
            ]);
            assert!(
                xlsx_preview(&bytes, &fixture.root().join("invalid.xlsx")).is_err(),
                "present invalid {cell_type} {cached} must fail"
            );
        }
    }

    #[test]
    fn worksheets_reject_invalid_indices_malformed_xml_zip_dtds_and_oversized_text() {
        let fixture = SearchFixture::new("xlsx-rejections");
        let path = fixture.root().join("book.xlsx");
        for xml in [
            "<worksheet><c r=\"A1\" t=\"s\"><v>9</v></c></worksheet>",
            "<worksheet><c r=\"A1\" t=\"b\"><v>invalid</v></c></worksheet>",
            "<worksheet><c r=\"A1\"><v>&unknown;</v></c></worksheet>",
            "<worksheet><c r=\"A1\"><v>incomplete",
            "<!DOCTYPE worksheet [<!ENTITY file SYSTEM 'file:///outside'>]><worksheet/>",
        ] {
            assert!(xlsx_preview(&workbook(&[("xl/worksheets/sheet1.xml", xml)]), &path).is_err());
        }
        assert!(xlsx_preview(b"invalid zip", &path).is_err());
        let oversized = format!(
            "<worksheet><c r=\"A1\" t=\"inlineStr\"><is><t>{}</t></is></c></worksheet>",
            "😀".repeat(16_385)
        );
        assert!(
            xlsx_preview(
                &workbook(&[("xl/worksheets/sheet1.xml", &oversized)]),
                &path
            )
            .is_err()
        );
    }

    #[test]
    fn worksheet_limits_dimensions_and_aggregate_xml_including_forged_size_headers() {
        let fixture = SearchFixture::new("xlsx-limits");
        let path = fixture.root().join("book.xlsx");
        let xml = "<worksheet><c r=\"A1\"><v>1</v></c><c r=\"M1\"><v>outside</v></c><c r=\"L40\"><v>last</v></c><c r=\"A41\"><v>outside</v></c></worksheet>";
        let table = xlsx_preview(&workbook(&[("xl/worksheets/sheet1.xml", xml)]), &path).unwrap();
        assert_eq!(table.rows.len(), 40);
        assert_eq!(table.columns.len(), 12);
        assert_eq!(table.rows[39][11], "last");
        assert!(table.rows.iter().flatten().all(|value| value != "outside"));
        let oversized = format!(
            "<worksheet>{}</worksheet>",
            " ".repeat(MAX_OFFICE_XML_BYTES as usize)
        );
        let mut bytes = workbook(&[("xl/worksheets/sheet1.xml", &oversized)]);
        assert!(xlsx_preview(&bytes, &path).is_err());
        let central = bytes
            .windows(4)
            .position(|value| value == b"PK\x01\x02")
            .unwrap();
        bytes[central + 24..central + 28].copy_from_slice(&1_u32.to_le_bytes());
        assert!(xlsx_preview(&bytes, &path).is_err());
        let strings = format!(
            "<sst>{}</sst>",
            " ".repeat((MAX_OFFICE_XML_BYTES - 50) as usize)
        );
        assert!(
            xlsx_preview(
                &workbook(&[
                    ("xl/sharedStrings.xml", &strings),
                    ("xl/worksheets/sheet1.xml", xml)
                ]),
                &path
            )
            .is_err()
        );
    }
}
