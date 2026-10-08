use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFailure {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
    pub recoverable: bool,
}

impl SearchFailure {
    pub fn new(code: &str, message: impl Into<String>, path: Option<&std::path::Path>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            path: path.map(|value| value.to_string_lossy().into_owned()),
            recoverable: true,
        }
    }

    pub fn from_io(operation: &str, path: &std::path::Path, error: &std::io::Error) -> Self {
        let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
            "permission-denied"
        } else {
            "search-failed"
        };
        Self::new(code, format!("Could not {operation}: {error}"), Some(path))
    }
}

impl fmt::Display for SearchFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SearchFailure {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Folder,
    Pdf,
    Document,
    Spreadsheet,
    Presentation,
    Source,
    Image,
    Video,
    Audio,
    Archive,
    Executable,
    Model,
    Unknown,
}

impl FileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Pdf => "pdf",
            Self::Document => "document",
            Self::Spreadsheet => "spreadsheet",
            Self::Presentation => "presentation",
            Self::Source => "source",
            Self::Image => "image",
            Self::Video => "video",
            Self::Audio => "audio",
            Self::Archive => "archive",
            Self::Executable => "executable",
            Self::Model => "model",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilenamePolicyRequest {
    pub exclusions: Vec<String>,
    pub include_hidden: bool,
    pub max_file_size_mb: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecord {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub kind: FileKind,
    pub extension: Option<String>,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWarning {
    pub message: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListResponse {
    pub items: Vec<FileRecord>,
    pub total: usize,
    pub truncated: bool,
    pub warnings: Vec<SearchWarning>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilenameMatch {
    #[serde(flatten)]
    pub file: FileRecord,
    pub score: f64,
    pub ranges: Vec<[usize; 2]>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilenameSearchResponse {
    pub items: Vec<FilenameMatch>,
    pub total: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub warnings: Vec<SearchWarning>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewKind {
    Folder,
    Text,
    Source,
    Markdown,
    Pdf,
    Document,
    Presentation,
    Spreadsheet,
    Image,
    Audio,
    Video,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewChild {
    pub id: String,
    pub name: String,
    pub kind: FileKind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BasicPreview {
    pub kind: PreviewKind,
    pub title: String,
    pub subtitle: String,
    pub text: Option<String>,
    pub source_url: Option<String>,
    pub mime_type: Option<String>,
    pub children: Vec<PreviewChild>,
    pub metadata: BTreeMap<String, String>,
}
