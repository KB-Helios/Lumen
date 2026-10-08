use std::path::Path;
use std::time::Instant;

use super::traversal::{MAX_RESPONSE_ITEMS, TraversalPolicy, traverse_with_policy};
use super::types::{FilenameMatch, FilenameSearchResponse, SearchFailure};

#[derive(Debug, PartialEq)]
struct MatchQuality {
    score: f64,
    ranges: Vec<[usize; 2]>,
}

fn filename_match(name: &str, query: &str) -> Option<MatchQuality> {
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
            ranges: vec![[0, name.chars().count()]],
        });
    }
    if normalized.starts_with(&query) {
        return Some(MatchQuality {
            score: 0.94,
            ranges: vec![[0, query.chars().count()]],
        });
    }
    if let Some(byte_index) = normalized.find(&query) {
        let start = normalized[..byte_index].chars().count();
        return Some(MatchQuality {
            score: (0.86 - (start as f64 * 0.002)).max(0.72),
            ranges: vec![[start, start + query.chars().count()]],
        });
    }

    let name_chars = normalized.chars().collect::<Vec<_>>();
    let mut search_index = 0;
    let mut matched = Vec::new();
    for query_character in query.chars() {
        let offset = name_chars[search_index..]
            .iter()
            .position(|candidate| *candidate == query_character)?;
        search_index += offset;
        matched.push(search_index);
        search_index += 1;
    }
    let span = matched.last().copied().unwrap_or_default()
        - matched.first().copied().unwrap_or_default()
        + 1;
    let ranges = matched
        .into_iter()
        .map(|index| [index, index + 1])
        .collect();
    Some(MatchQuality {
        score: (0.68 - (span.saturating_sub(query.chars().count()) as f64 * 0.01)).max(0.5),
        ranges,
    })
}

pub(super) fn filename_score(name: &str, query: &str) -> Option<f64> {
    filename_match(name, query).map(|quality| quality.score)
}

pub fn search_filenames_impl(
    root: &Path,
    query: &str,
) -> Result<FilenameSearchResponse, SearchFailure> {
    search_filenames_with_policy(root, query, &TraversalPolicy::default())
}

pub fn search_filenames_with_policy(
    root: &Path,
    query: &str,
    policy: &TraversalPolicy,
) -> Result<FilenameSearchResponse, SearchFailure> {
    let started = Instant::now();
    let outcome = traverse_with_policy(root, policy)?;
    let mut items = outcome
        .records
        .into_iter()
        .filter_map(|file| {
            filename_match(&file.name, query).map(|quality| FilenameMatch {
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
