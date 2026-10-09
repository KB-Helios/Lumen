use std::path::Path;
use std::time::Instant;

use super::indexing::{
    SearchFilterRequest, matches_metadata_filters, matches_metadata_scope, validate_search_options,
};
use super::traversal::{MAX_RESPONSE_ITEMS, TraversalPolicy, traverse_with_policy};
use super::types::{FilenameMatch, FilenameSearchResponse, SearchFailure};

#[derive(Debug, PartialEq)]
struct MatchQuality {
    score: f64,
    ranges: Vec<[usize; 2]>,
}

fn filename_match(name: &str, query: &str, include_ranges: bool) -> Option<MatchQuality> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Some(MatchQuality {
            score: 0.5,
            ranges: Vec::new(),
        });
    }

    let normalized = name.to_lowercase();
    if normalized == query {
        return Some(MatchQuality {
            score: 1.0,
            ranges: if include_ranges {
                vec![[0, name.chars().count()]]
            } else {
                Vec::new()
            },
        });
    }
    if normalized.starts_with(&query) {
        return Some(MatchQuality {
            score: 0.94,
            ranges: if include_ranges {
                vec![[0, query.chars().count()]]
            } else {
                Vec::new()
            },
        });
    }
    if let Some(byte_index) = normalized.find(&query) {
        let start = normalized[..byte_index].chars().count();
        return Some(MatchQuality {
            score: (0.86 - (start as f64 * 0.002)).max(0.72),
            ranges: if include_ranges {
                vec![[start, start + query.chars().count()]]
            } else {
                Vec::new()
            },
        });
    }

    let mut name_chars = normalized.chars().enumerate();
    let mut first = None;
    let mut last = 0;
    let mut ranges = Vec::new();
    for query_character in query.chars() {
        let (index, _) = name_chars.find(|(_, candidate)| *candidate == query_character)?;
        first.get_or_insert(index);
        last = index;
        if include_ranges {
            ranges.push([index, index + 1]);
        }
    }
    let span = last - first.unwrap_or_default() + 1;
    Some(MatchQuality {
        score: (0.68 - (span.saturating_sub(query.chars().count()) as f64 * 0.01)).max(0.5),
        ranges,
    })
}

pub(super) fn filename_score(name: &str, query: &str) -> Option<f64> {
    filename_match(name, query, false).map(|quality| quality.score)
}

#[cfg(test)]
pub fn search_filenames_impl(
    root: &Path,
    query: &str,
) -> Result<FilenameSearchResponse, SearchFailure> {
    search_filenames_with_policy(root, query, &TraversalPolicy::default())
}

#[cfg(test)]
pub fn search_filenames_with_policy(
    root: &Path,
    query: &str,
    policy: &TraversalPolicy,
) -> Result<FilenameSearchResponse, SearchFailure> {
    search_filenames_filtered(root, query, policy, "all", &[])
}

pub fn search_filenames_filtered(
    root: &Path,
    query: &str,
    policy: &TraversalPolicy,
    scope: &str,
    filters: &[SearchFilterRequest],
) -> Result<FilenameSearchResponse, SearchFailure> {
    validate_search_options(scope, filters, 82, "balanced")?;
    let started = Instant::now();
    let outcome = traverse_with_policy(root, policy)?;
    let mut items = outcome
        .records
        .into_iter()
        .filter(|file| {
            matches_metadata_scope(file, scope) && matches_metadata_filters(file, filters)
        })
        .filter_map(|file| {
            filename_match(&file.name, query, true).map(|quality| FilenameMatch {
                file,
                score: quality.score,
                ranges: quality.ranges,
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| {
                left.file
                    .name
                    .chars()
                    .count()
                    .cmp(&right.file.name.chars().count())
            })
            .then_with(|| {
                left.file
                    .relative_path
                    .to_lowercase()
                    .cmp(&right.file.relative_path.to_lowercase())
            })
            .then_with(|| left.file.relative_path.cmp(&right.file.relative_path))
    });
    let total = items.len();
    items.truncate(MAX_RESPONSE_ITEMS);

    Ok(FilenameSearchResponse {
        items,
        total,
        truncated: outcome.truncated || total > MAX_RESPONSE_ITEMS,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        warnings: outcome.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::test_support::SearchFixture;

    #[test]
    fn fallback_filters_admit_eligible_files_below_ten_thousand_matches() {
        let fixture = SearchFixture::new("fallback-filter-cap");
        for index in 0..10_001 {
            fixture.file(&format!("report-{index:05}.tmp"), b"");
        }
        fixture.file("z-long-report.md", b"");
        for (scope, filters) in [
            (
                "all",
                vec![SearchFilterRequest {
                    id: "extension".into(),
                    value: ".MD".into(),
                }],
            ),
            (
                "all",
                vec![SearchFilterRequest {
                    id: "kind".into(),
                    value: "document".into(),
                }],
            ),
            ("documents", vec![]),
        ] {
            let response = search_filenames_filtered(
                fixture.root(),
                "report",
                &TraversalPolicy::default(),
                scope,
                &filters,
            )
            .unwrap();
            assert_eq!(
                response
                    .items
                    .iter()
                    .take(1)
                    .map(|item| item.file.name.as_str())
                    .collect::<Vec<_>>(),
                vec!["z-long-report.md"]
            );
            assert_eq!(response.total, 1);
            assert!(!response.truncated);
        }
    }

    #[test]
    fn ranks_exact_prefix_substring_and_fuzzy_matches_in_order() {
        let fixture = SearchFixture::new("matching");
        fixture.file("report", b"");
        fixture.file("report-summary.md", b"");
        fixture.file("quarterly-report.md", b"");
        fixture.file("release-progress-output-report.txt", b"");

        let response = search_filenames_impl(fixture.root(), "report").unwrap();
        let names = response
            .items
            .iter()
            .map(|item| item.file.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "report",
                "report-summary.md",
                "quarterly-report.md",
                "release-progress-output-report.txt"
            ]
        );
    }

    #[test]
    fn matching_is_case_insensitive_and_preserves_unicode() {
        let fixture = SearchFixture::new("unicode-matching");
        fixture.file("Årsrapport 東京.md", b"");

        let response = search_filenames_impl(fixture.root(), "ÅRS").unwrap();
        assert_eq!(response.items[0].file.name, "Årsrapport 東京.md");
    }
}
