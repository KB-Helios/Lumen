//! Select scalar candidates and rank before copying metadata or document text.
use super::*;
use crate::search::{indexing::SearchFilterRequest, ranking};
use rusqlite::functions::FunctionFlags;

pub(super) fn register(connection: &Connection) -> rusqlite::Result<()> {
    connection.create_collation("lumen_path", |left, right| {
        Path::new(left).cmp(Path::new(right))
    })?;
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    connection.create_scalar_function("lumen_filename", 2, flags, |ctx| {
        Ok(crate::search::matching::filename_score(
            &ctx.get::<String>(0)?,
            &ctx.get::<String>(1)?,
        ))
    })?;
    connection.create_scalar_function("lumen_exact", 2, flags, |ctx| {
        Ok(ranking::exact_filename(
            &ctx.get::<String>(1)?,
            &ctx.get::<String>(0)?,
        ))
    })?;
    connection.create_scalar_function("lumen_rank", 8, flags, |ctx| {
        Ok(ranking::score(
            ctx.get(0)?,
            ctx.get(1)?,
            ctx.get(2)?,
            ctx.get(3)?,
            ranking::RankingWeights {
                lexical: ctx.get(4)?,
                semantic: ctx.get(5)?,
                recency: ctx.get(6)?,
                pin: ctx.get(7)?,
            },
        ))
    })
}

pub(in crate::search) struct QueryHit {
    pub hit: IndexedHit,
    pub metadata: FileRecord,
    pub filename: bool,
    pub semantic: Option<f64>,
    pub pinned: bool,
}

// JSON scalar extraction preserves the existing metadata contract without
// deserializing every FileRecord. Only fixed SQL fragments are interpolated;
// extension/kind filter values are bound as a JSON array.
fn eligibility(scope: &str, filters: &[SearchFilterRequest]) -> String {
    let mut predicates = vec![match scope {
        "all" | "recent" | "related" => "1",
        "files" => "lower(CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.kind') END) <> 'folder'",
        "folders" => "lower(CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.kind') END) = 'folder'",
        "documents" => "lower(CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.kind') END) IN ('pdf','document','spreadsheet','presentation')",
        "code" => "lower(CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.kind') END) = 'source'",
        "images" => "lower(CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.kind') END) = 'image'",
        _ => "0",
    }.to_owned()];
    for (index, filter) in filters.iter().enumerate() {
        predicates.push(match filter.id.as_str() {
            "extension" => format!("lower(COALESCE(CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.extension') END,'')) = lower(ltrim(json_extract(?5,'$[{index}].value'),'.'))"),
            "kind" => format!("lower(CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.kind') END) = lower(json_extract(?5,'$[{index}].value'))"),
            _ => "0".into(),
        });
    }
    predicates.join(" AND ")
}

impl IndexDatabase {
    #[cfg(test)]
    pub(in crate::search) fn query_hydrated_rows(&self) -> usize {
        self.query_hydrated_rows.load(Ordering::Relaxed)
    }
    #[allow(clippy::too_many_arguments)]
    pub(in crate::search) fn query_hits(
        &self,
        query: &str,
        vector: Option<&[f32]>,
        model: &str,
        limit: usize,
        weights: ranking::RankingWeights,
        scope: &str,
        filters: &[SearchFilterRequest],
        related_source: Option<&str>,
    ) -> IndexResult<Vec<QueryHit>> {
        #[cfg(test)]
        self.query_hydrated_rows.store(0, Ordering::Relaxed);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let connection = self.connection.lock().map_err(|_| IndexError::Poisoned)?;
        let encoded = vector
            .map(|values| Self::encode_vector(values.len(), values))
            .transpose()?;
        if let Some(values) = vector {
            self.ensure_vector_dimension(&connection, values.len())?;
        }
        let match_query = query
            .split_whitespace()
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        let predicate = eligibility(scope, filters);
        let filtered = !matches!(scope, "all" | "related" | "recent") || !filters.is_empty();
        let eligible_cte = if filtered {
            format!(
                "eligible AS MATERIALIZED (SELECT file_id FROM file_inventory WHERE {predicate}),"
            )
        } else {
            String::new()
        };
        let selected_eligibility = if filtered {
            "files.id IN (SELECT file_id FROM eligible)"
        } else {
            "1"
        };
        let semantic_eligibility = if filtered {
            "SELECT semantic_raw.* FROM semantic_raw JOIN eligible ON eligible.file_id=semantic_raw.file_id"
        } else {
            "SELECT * FROM semantic_raw"
        };
        let filters = serde_json::to_string(
            &filters
                .iter()
                .map(|filter| serde_json::json!({"id":filter.id,"value":filter.value}))
                .collect::<Vec<_>>(),
        )?;
        let filename_sql = if related_source.is_some() {
            "SELECT NULL file_id, NULL filename WHERE 0"
        } else if filtered {
            "SELECT files.id file_id,lumen_filename(files.name,?1) filename FROM eligible JOIN files ON files.id=eligible.file_id WHERE lumen_filename(files.name,?1) IS NOT NULL"
        } else {
            "SELECT id file_id,lumen_filename(name,?1) filename FROM files WHERE lumen_filename(name,?1) IS NOT NULL"
        };
        let lexical_sql = if related_source.is_some() || match_query.is_empty() {
            "SELECT NULL file_id,NULL chunk_id,NULL lexical_rank WHERE 0".to_owned()
        } else {
            let allowed = if filtered {
                "AND CAST(search_fts.file_id AS INTEGER) IN (SELECT file_id FROM eligible)"
            } else {
                ""
            };
            format!("SELECT CAST(search_fts.file_id AS INTEGER) file_id,CAST(search_fts.chunk_id AS INTEGER) chunk_id,
              bm25(search_fts,0.0,0.0,12.0,2.0,1.0) lexical_rank
              FROM search_fts WHERE search_fts MATCH ?2 {allowed}")
        };
        let semantic_sql = if vector.is_some() {
            "SELECT chunks.file_id,chunks.id chunk_id,scan.distance
             FROM vector_full_scan('vector_embeddings','embedding',vector_as_f32(?6,?7)) scan
             JOIN vector_embeddings ON vector_embeddings.rowid=scan.rowid
             JOIN chunks ON chunks.id=vector_embeddings.chunk_id
             JOIN files ON files.id=chunks.file_id
             WHERE vector_embeddings.embedding_model=?8 AND vector_embeddings.dimension=?7
               AND vector_embeddings.content_hash=chunks.content_hash
               AND vector_embeddings.index_revision=chunks.index_revision
               AND chunks.content_hash=files.content_hash AND chunks.index_revision=files.index_revision"
        } else {
            "SELECT NULL file_id,NULL chunk_id,NULL distance WHERE 0"
        };
        // Keep all matching scalar signals until the final combined rank. A
        // lexical-only, fuzzy-only or vector-only prelimit would lose pins,
        // recency or combinations that belong in the actual top-k.
        let sql = format!("
          WITH {eligible_cte} filename AS MATERIALIZED ({filename_sql}),
          lexical_raw AS MATERIALIZED ({lexical_sql}),
          lexical_ordered AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY lexical_rank,chunk_id) n FROM lexical_raw),
          lexical AS (SELECT * FROM lexical_ordered WHERE n=1),
          semantic_raw AS MATERIALIZED ({semantic_sql}),
          semantic_eligible AS ({semantic_eligibility}),
          semantic_ordered AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY distance,chunk_id) n FROM semantic_eligible),
          semantic AS (SELECT file_id,chunk_id,MAX(0.0,MIN(1.0,1.0-distance/2.0)) semantic FROM semantic_ordered WHERE n=1),
          ids AS (SELECT file_id FROM filename UNION SELECT file_id FROM lexical UNION SELECT file_id FROM semantic),
          selected AS MATERIALIZED (
            SELECT files.id,COALESCE(lexical.chunk_id,semantic.chunk_id) chunk_id,
              filename.filename IS NOT NULL filename,semantic.semantic,
              EXISTS(SELECT 1 FROM pins WHERE pins.file_id=files.id) pinned,
              CASE WHEN ?9 IS NOT NULL THEN semantic.semantic ELSE
                lumen_rank(MAX(COALESCE(filename.filename,0.0),COALESCE(1.0/(1.0+ABS(lexical.lexical_rank)),0.0)),
                  semantic.semantic,{RECENCY_SQL},EXISTS(SELECT 1 FROM pins WHERE pins.file_id=files.id),?10,?11,?12,?13) END score
            FROM ids JOIN files ON files.id=ids.file_id
            JOIN file_inventory ON file_inventory.file_id=files.id
            LEFT JOIN filename ON filename.file_id=files.id
            LEFT JOIN lexical ON lexical.file_id=files.id
            LEFT JOIN semantic ON semantic.file_id=files.id
            WHERE ({selected_eligibility}) AND (?9 IS NULL OR files.stable_id<>?9)
            ORDER BY CASE WHEN ?9 IS NULL THEN lumen_exact(files.name,?1) ELSE 0 END DESC,score DESC,files.path COLLATE lumen_path ASC
            LIMIT ?3
          )
          SELECT files.stable_id,files.root_path,files.path,files.name,files.content_hash,files.index_revision,
            COALESCE(chunks.extraction_kind,'metadata'),COALESCE(substr(chunks.text,1,1000),''),
            chunks.page,chunks.time_start_ms,chunks.time_end_ms,file_inventory.metadata,
            selected.filename,selected.semantic,selected.pinned,selected.score
          FROM selected JOIN files ON files.id=selected.id
          JOIN file_inventory ON file_inventory.file_id=files.id
          LEFT JOIN chunks ON chunks.id=COALESCE(selected.chunk_id,
            (SELECT id FROM chunks WHERE file_id=files.id AND content_hash=files.content_hash AND index_revision=files.index_revision ORDER BY ordinal LIMIT 1))
          ORDER BY CASE WHEN ?9 IS NULL THEN lumen_exact(files.name,?1) ELSE 0 END DESC,selected.score DESC,files.path COLLATE lumen_path ASC");
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![
                query,
                match_query,
                i64::try_from(limit).map_err(|_| IndexError::IntegerOverflow)?,
                scope,
                filters,
                encoded,
                vector.map(|values| values.len() as i64).unwrap_or(0),
                model,
                related_source,
                weights.lexical,
                weights.semantic,
                weights.recency,
                weights.pin
            ],
            |row| {
                let raw: String = row.get(11)?;
                let metadata = serde_json::from_str(&raw).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        11,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                #[cfg(test)]
                self.query_hydrated_rows.fetch_add(1, Ordering::Relaxed);
                Ok(QueryHit {
                    hit: IndexedHit {
                        stable_id: row.get(0)?,
                        root_path: PathBuf::from(row.get::<_, String>(1)?),
                        path: PathBuf::from(row.get::<_, String>(2)?),
                        name: row.get(3)?,
                        content_hash: row.get(4)?,
                        index_revision: u64::try_from(row.get::<_, i64>(5)?)
                            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(5, i64::MAX))?,
                        extraction_kind: row.get(6)?,
                        snippet: row.get(7)?,
                        page: row.get(8)?,
                        time_start_ms: row
                            .get::<_, Option<i64>>(9)?
                            .and_then(|v| u64::try_from(v).ok()),
                        time_end_ms: row
                            .get::<_, Option<i64>>(10)?
                            .and_then(|v| u64::try_from(v).ok()),
                        rank: 1.0 - row.get::<_, f64>(15)?,
                    },
                    metadata,
                    filename: row.get(12)?,
                    semantic: row.get(13)?,
                    pinned: row.get(14)?,
                })
            },
        )?;
        let result = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(IndexError::from);
        drop(statement);
        result
    }
}
