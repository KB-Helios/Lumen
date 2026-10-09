use std::collections::HashSet;
use std::fs;
use std::path::Path;

use super::metadata::file_record;
use super::root_policy::canonicalize_root;
use super::types::{FileListResponse, FileRecord, SearchFailure, SearchWarning};

const MAX_TRAVERSED_ITEMS: usize = 250_000;
pub const MAX_RESPONSE_ITEMS: usize = 10_000;
const MAX_WARNINGS: usize = 32;
const GENERATED_DIRECTORIES: [&str; 9] = [
    ".git",
    ".next",
    ".turbo",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "vendor",
];

pub struct TraversalOutcome {
    pub records: Vec<FileRecord>,
    pub warnings: Vec<SearchWarning>,
    pub truncated: bool,
}

#[derive(Clone, Debug)]
pub struct TraversalPolicy {
    pub exclusions: Vec<String>,
    pub include_hidden: bool,
    pub max_file_size_bytes: u64,
}

impl Default for TraversalPolicy {
    fn default() -> Self {
        Self {
            exclusions: Vec::new(),
            include_hidden: false,
            max_file_size_bytes: u64::MAX,
        }
    }
}

impl TraversalPolicy {
    pub fn new(
        exclusions: Vec<String>,
        include_hidden: bool,
        max_file_size_bytes: u64,
    ) -> Result<Self, SearchFailure> {
        if max_file_size_bytes == 0 {
            return Err(SearchFailure::new(
                "invalid-root",
                "The maximum indexed file size must be greater than zero.",
                None,
            ));
        }
        let mut normalized = Vec::with_capacity(exclusions.len());
        for exclusion in exclusions {
            let value = exclusion.trim().replace('\\', "/");
            if value.is_empty()
                || value.split('/').any(|part| part == "..")
                || value.starts_with('/')
                || value.starts_with("//")
                || value.as_bytes().get(1) == Some(&b':')
            {
                return Err(SearchFailure::new(
                    "invalid-root",
                    "Index exclusions must stay relative to the selected root.",
                    None,
                ));
            }
            normalized.push(value.to_ascii_lowercase());
        }
        Ok(Self {
            exclusions: normalized,
            include_hidden,
            max_file_size_bytes,
        })
    }
}

fn warning(path: &Path, message: impl Into<String>) -> SearchWarning {
    SearchWarning {
        message: message.into(),
        path: path.to_string_lossy().into_owned(),
    }
}

fn push_warning(warnings: &mut Vec<SearchWarning>, value: SearchWarning) {
    if warnings.len() < MAX_WARNINGS {
        warnings.push(value);
    }
}

fn is_generated_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| {
            GENERATED_DIRECTORIES
                .iter()
                .any(|ignored| name.eq_ignore_ascii_case(ignored))
        })
}

fn normalized_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn is_hidden(relative: &str) -> bool {
    relative
        .split('/')
        .any(|part| part.starts_with('.') && part.len() > 1)
}

fn is_excluded(relative: &str, exclusions: &[String]) -> bool {
    exclusions.iter().any(|pattern| {
        if let Some(suffix) = pattern.strip_prefix('*') {
            relative.ends_with(suffix)
        } else {
            relative == pattern
                || relative.starts_with(&format!("{pattern}/"))
                || relative.split('/').any(|part| part == pattern)
        }
    })
}

pub fn traverse(root: &Path) -> Result<TraversalOutcome, SearchFailure> {
    traverse_with_policy(root, &TraversalPolicy::default())
}

// `root` is the immutable canonical path captured at configuration admission.
pub(super) fn admitted_root_is_current(root: &Path) -> bool {
    fs::canonicalize(root).is_ok_and(|canonical| canonical == root)
        && root.ancestors().all(|ancestor| {
            fs::symlink_metadata(ancestor)
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        })
}

pub(super) fn policy_record(
    root: &Path,
    path: &Path,
    policy: &TraversalPolicy,
) -> Result<Option<FileRecord>, SearchFailure> {
    if !admitted_root_is_current(root) {
        return Ok(None);
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(None);
    };
    let normalized = normalized_relative(root, path);
    if is_excluded(&normalized, &policy.exclusions)
        || (!policy.include_hidden && is_hidden(&normalized))
    {
        return Ok(None);
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Ok(None);
        }
        current.push(component);
        let Ok(metadata) = fs::symlink_metadata(&current) else {
            return Ok(None);
        };
        if metadata.file_type().is_symlink()
            || (metadata.is_dir() && is_generated_directory(&current))
        {
            return Ok(None);
        }
    }
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(None);
    };
    if metadata.is_file() && metadata.len() > policy.max_file_size_bytes {
        return Ok(None);
    }
    if !fs::canonicalize(path).is_ok_and(|canonical| canonical.starts_with(root)) {
        return Ok(None);
    }
    file_record(root, path).map(Some)
}

pub(super) fn record_matches_policy(record: &FileRecord, policy: &TraversalPolicy) -> bool {
    let relative = record.relative_path.replace('\\', "/").to_ascii_lowercase();
    let mut parts = relative.split('/').rev();
    let leaf = parts.next();
    let generated = parts.any(|part| GENERATED_DIRECTORIES.contains(&part))
        || (record.kind == super::types::FileKind::Folder
            && leaf.is_some_and(|part| GENERATED_DIRECTORIES.contains(&part)));
    !is_excluded(&relative, &policy.exclusions)
        && !generated
        && (policy.include_hidden || !is_hidden(&relative))
        && (record.kind == super::types::FileKind::Folder
            || record.size_bytes <= policy.max_file_size_bytes)
}

pub(super) fn stored_path_is_safe(root: &Path, path: &Path) -> bool {
    if !admitted_root_is_current(root) {
        return false;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return false;
        }
        current.push(component);
        if fs::symlink_metadata(&current).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return false;
        }
    }
    true
}

pub fn traverse_with_policy(
    root: &Path,
    policy: &TraversalPolicy,
) -> Result<TraversalOutcome, SearchFailure> {
    traverse_with_policy_until(root, policy, || false)
}

pub(super) fn traverse_with_policy_until(
    root: &Path,
    policy: &TraversalPolicy,
    cancelled: impl Fn() -> bool,
) -> Result<TraversalOutcome, SearchFailure> {
    traverse_with_policy_until_limit(root, policy, cancelled, MAX_TRAVERSED_ITEMS)
}

pub(super) fn traverse_with_policy_until_limit(
    root: &Path,
    policy: &TraversalPolicy,
    cancelled: impl Fn() -> bool,
    limit: usize,
) -> Result<TraversalOutcome, SearchFailure> {
    let root = canonicalize_root(root)?;
    let mut records = Vec::new();
    let mut warnings = Vec::new();
    let mut directories = vec![root.clone()];
    let mut visited = HashSet::new();
    let mut truncated = false;

    'walk: while let Some(directory) = directories.pop() {
        if cancelled() {
            break;
        }
        let canonical_directory = match fs::canonicalize(&directory) {
            Ok(value) if value.starts_with(&root) => value,
            Ok(_) => continue,
            Err(error) => {
                push_warning(
                    &mut warnings,
                    warning(&directory, format!("Directory was skipped: {error}")),
                );
                continue;
            }
        };
        if !visited.insert(canonical_directory.clone()) {
            continue;
        }

        let read_directory = match fs::read_dir(&canonical_directory) {
            Ok(value) => value,
            Err(error) => {
                push_warning(
                    &mut warnings,
                    warning(
                        &canonical_directory,
                        format!("Directory was skipped: {error}"),
                    ),
                );
                continue;
            }
        };
        let mut entries = Vec::new();
        for entry in read_directory {
            if cancelled() {
                break 'walk;
            }
            match entry {
                Ok(value) => entries.push(value),
                Err(error) => push_warning(
                    &mut warnings,
                    warning(
                        &canonical_directory,
                        format!("Directory entry was skipped: {error}"),
                    ),
                ),
            }
        }
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

        for entry in entries {
            if cancelled() {
                break 'walk;
            }
            if records.len() >= limit {
                truncated = true;
                break 'walk;
            }

            let path = entry.path();
            let relative = normalized_relative(&root, &path);
            if is_excluded(&relative, &policy.exclusions)
                || (!policy.include_hidden && is_hidden(&relative))
            {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(value) => value,
                Err(error) => {
                    push_warning(
                        &mut warnings,
                        warning(&path, format!("Item was skipped: {error}")),
                    );
                    continue;
                }
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if is_generated_directory(&path) {
                    continue;
                }
                match fs::canonicalize(&path) {
                    Ok(value) if value.starts_with(&root) => directories.push(value),
                    Ok(_) => continue,
                    Err(error) => {
                        push_warning(
                            &mut warnings,
                            warning(&path, format!("Directory was skipped: {error}")),
                        );
                        continue;
                    }
                }
            }

            if file_type.is_file()
                && entry
                    .metadata()
                    .is_ok_and(|metadata| metadata.len() > policy.max_file_size_bytes)
            {
                continue;
            }

            match file_record(&root, &path) {
                Ok(record) => records.push(record),
                Err(error) => push_warning(&mut warnings, warning(&path, error.message)),
            }
        }
    }

    records.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    Ok(TraversalOutcome {
        records,
        warnings,
        truncated,
    })
}

pub fn list_files_impl(root: &Path) -> Result<FileListResponse, SearchFailure> {
    let outcome = traverse(root)?;
    let total = outcome.records.len();
    Ok(FileListResponse {
        items: outcome
            .records
            .into_iter()
            .take(MAX_RESPONSE_ITEMS)
            .collect(),
        total,
        truncated: outcome.truncated || total > MAX_RESPONSE_ITEMS,
        warnings: outcome.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::test_support::SearchFixture;

    #[test]
    fn traversal_preserves_unicode_and_has_stable_ordering() {
        let fixture = SearchFixture::new("traversal");
        fixture.file("zeta.txt", b"z");
        fixture.file("Alpha.txt", b"a");
        fixture.file("International/Årsrapport 東京.md", b"unicode");

        let first = list_files_impl(fixture.root()).unwrap();
        let second = list_files_impl(fixture.root()).unwrap();
        let names = first
            .items
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(first.items, second.items);
        assert!(names.contains(&"Årsrapport 東京.md"));
        assert_eq!(first.total, 4);
    }

    #[test]
    fn traversal_skips_common_generated_directories() {
        let fixture = SearchFixture::new("generated-directories");
        fixture.file("package.json", b"{}");
        fixture.file("node_modules/dependency/package.json", b"{}");
        fixture.file("target/debug/generated.rs", b"");

        let response = list_files_impl(fixture.root()).unwrap();
        let relative_paths = response
            .items
            .iter()
            .map(|item| item.relative_path.as_str())
            .collect::<Vec<_>>();

        assert!(relative_paths.contains(&"package.json"));
        assert!(
            !relative_paths
                .iter()
                .any(|path| path.contains("node_modules"))
        );
        assert!(!relative_paths.iter().any(|path| path.contains("target")));
    }

    #[test]
    fn configured_policy_excludes_hidden_patterns_and_large_files() {
        let fixture = SearchFixture::new("configured-traversal-policy");
        fixture.file("keep.txt", b"keep");
        fixture.file(".private/secret.txt", b"secret");
        fixture.file("cache/result.txt", b"cached");
        fixture.file("notes.tmp", b"temporary");
        fixture.file("large.bin", b"0123456789");
        let policy = TraversalPolicy {
            exclusions: vec!["cache".to_owned(), "*.tmp".to_owned()],
            include_hidden: false,
            max_file_size_bytes: 5,
        };

        let outcome = traverse_with_policy(fixture.root(), &policy).unwrap();
        let paths = outcome
            .records
            .iter()
            .map(|item| item.relative_path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"keep.txt"));
        assert!(!paths.iter().any(|path| path.contains(".private")));
        assert!(!paths.iter().any(|path| path.contains("cache")));
        assert!(!paths.iter().any(|path| path.ends_with(".tmp")));
        assert!(!paths.contains(&"large.bin"));
    }

    #[test]
    fn configured_policy_rejects_parent_and_absolute_exclusions() {
        for exclusion in ["../private", "C:\\Private", "\\\\server\\share"] {
            let error = TraversalPolicy::new(vec![exclusion.to_owned()], false, 1024).unwrap_err();
            assert_eq!(error.code, "invalid-root");
        }
    }
}
