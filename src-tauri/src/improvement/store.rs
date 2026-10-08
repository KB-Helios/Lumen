use super::{evaluation, types::*};
use rusqlite::{Connection, OptionalExtension, params};
use std::{path::Path, sync::Mutex};

pub struct ImprovementStore {
    connection: Mutex<Connection>,
}
fn db_error(_: rusqlite::Error) -> String {
    "Improvement storage is unavailable.".into()
}
fn encode<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "Invalid improvement data.".into())
}
fn decode<T: serde::de::DeserializeOwned>(value: String) -> Result<T, String> {
    serde_json::from_str(&value).map_err(|_| "Stored improvement data is invalid.".into())
}
impl ImprovementStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::initialize(Connection::open(path).map_err(db_error)?)
    }
    #[cfg(test)]
    pub fn memory() -> Result<Self, String> {
        Self::initialize(Connection::open_in_memory().map_err(db_error)?)
    }
    fn initialize(connection: Connection) -> Result<Self, String> {
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT,parent INTEGER,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS version_config (id INTEGER PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS job_budget (job TEXT NOT NULL,phase TEXT NOT NULL,used INTEGER NOT NULL,token_limit INTEGER NOT NULL,deadline INTEGER NOT NULL,PRIMARY KEY(job,phase));
            CREATE TABLE IF NOT EXISTS token_reservations (id TEXT PRIMARY KEY,job TEXT NOT NULL,phase TEXT NOT NULL,reserved INTEGER NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY,at INTEGER NOT NULL,signature TEXT NOT NULL,data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS trace_failure ON traces(signature,at);
            CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY,parent INTEGER NOT NULL,status TEXT NOT NULL,hash TEXT NOT NULL,config TEXT NOT NULL,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS job_candidates (job TEXT PRIMARY KEY,candidate TEXT NOT NULL,FOREIGN KEY(candidate) REFERENCES candidates(id));
            CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY,candidate TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL,FOREIGN KEY(candidate) REFERENCES candidates(id));
            CREATE TABLE IF NOT EXISTS promotions (candidate TEXT UNIQUE NOT NULL,version INTEGER NOT NULL,at INTEGER NOT NULL);") .map_err(db_error)?;
        connection
            .execute(
                "INSERT OR IGNORE INTO versions (id,parent,data) VALUES (0,NULL,?1)",
                [encode(&HarnessVersion::default())?],
            )
            .map_err(db_error)?;
        connection
            .execute("INSERT OR IGNORE INTO state VALUES ('active','0')", [])
            .map_err(db_error)?;
        connection
            .execute(
                "INSERT OR IGNORE INTO state VALUES ('settings',?1)",
                [encode(&ImprovementSettings::default())?],
            )
            .map_err(db_error)?;
        connection
            .execute(
                "INSERT OR IGNORE INTO state VALUES ('owner',?1)",
                [uuid::Uuid::new_v4().to_string()],
            )
            .map_err(db_error)?;
        connection
            .execute(
                "UPDATE candidates SET status='proposed' WHERE status='evaluating'",
                [],
            )
            .map_err(db_error)?;
        Self::prune_in(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
    pub fn owner(&self) -> Result<String, String> {
        self.connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?
            .query_row("SELECT value FROM state WHERE key='owner'", [], |row| {
                row.get(0)
            })
            .map_err(db_error)
    }
    pub fn reserve_tokens(
        &self,
        job: &str,
        phase: &str,
        reserved: u64,
        limit: u64,
        duration_ms: u64,
    ) -> Result<String, String> {
        if !safe_id(job, 128)
            || !["generation", "evaluation"].contains(&phase)
            || limit > 500000
            || reserved > limit
        {
            return Err("improvement_budget_exceeded".into());
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let transaction = connection.transaction().map_err(db_error)?;
        let now = now_ms() as i64;
        transaction
            .execute(
                "INSERT OR IGNORE INTO job_budget VALUES (?1,?2,0,?3,?4)",
                params![
                    job,
                    phase,
                    limit as i64,
                    now.saturating_add(duration_ms as i64)
                ],
            )
            .map_err(db_error)?;
        let (used, persisted_limit, deadline): (i64, i64, i64) = transaction
            .query_row(
                "SELECT used,token_limit,deadline FROM job_budget WHERE job=?1 AND phase=?2",
                params![job, phase],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(db_error)?;
        if now >= deadline
            || used.saturating_add(reserved as i64) > persisted_limit
            || persisted_limit != limit as i64
        {
            return Err("improvement_budget_exceeded".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        transaction
            .execute(
                "UPDATE job_budget SET used=used+?1 WHERE job=?2 AND phase=?3",
                params![reserved as i64, job, phase],
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "INSERT INTO token_reservations (id,job,phase,reserved) VALUES (?1,?2,?3,?4)",
                params![id, job, phase, reserved as i64],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(id)
    }
    pub fn settle_tokens(&self, id: &str, actual: u64) -> Result<bool, String> {
        if actual > 500000 {
            return Err("improvement_budget_exceeded".into());
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let transaction = connection.transaction().map_err(db_error)?;
        let (job, phase, reserved): (String, String, i64) = transaction
            .query_row(
                "SELECT job,phase,reserved FROM token_reservations WHERE id=?1 AND settled=0",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(db_error)?;
        transaction
            .execute("UPDATE token_reservations SET settled=1 WHERE id=?1", [id])
            .map_err(db_error)?;
        transaction
            .execute(
                "UPDATE job_budget SET used=used-?1+?2 WHERE job=?3 AND phase=?4",
                params![reserved, actual as i64, job, phase],
            )
            .map_err(db_error)?;
        let within: bool = transaction
            .query_row(
                "SELECT used<=token_limit FROM job_budget WHERE job=?1 AND phase=?2",
                params![job, phase],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(within)
    }
    pub fn phase_budget_valid(&self, job: &str, phase: &str) -> Result<bool, String> {
        self.connection.lock().map_err(|_|"Improvement storage is busy.")?
            .query_row("SELECT used<=token_limit AND deadline>?3 FROM job_budget WHERE job=?1 AND phase=?2",params![job,phase,now_ms() as i64],|row|row.get(0))
            .optional().map(|result|result.unwrap_or(false)).map_err(db_error)
    }
    pub fn settings(&self) -> Result<ImprovementSettings, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        decode(
            connection
                .query_row("SELECT value FROM state WHERE key='settings'", [], |row| {
                    row.get(0)
                })
                .map_err(db_error)?,
        )
    }
    pub fn set_settings(&self, settings: &ImprovementSettings) -> Result<(), String> {
        self.connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?
            .execute(
                "UPDATE state SET value=?1 WHERE key='settings'",
                [encode(settings)?],
            )
            .map_err(db_error)?;
        Ok(())
    }
    fn active_in(connection: &Connection) -> Result<HarnessVersion, String> {
        decode(connection.query_row("SELECT data FROM versions WHERE id=(SELECT CAST(value AS INTEGER) FROM state WHERE key='active')",[],|row|row.get(0)).map_err(db_error)?)
    }
    pub fn active(&self) -> Result<HarnessVersion, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        Self::active_in(&connection)
    }
    pub fn effective(&self, config: &str) -> HarnessVersion {
        if !self.settings().is_ok_and(|s| s.enabled) {
            return HarnessVersion::default();
        }
        let Ok(connection) = self.connection.lock() else {
            return HarnessVersion::default();
        };
        let Ok(version) = Self::active_in(&connection) else {
            return HarnessVersion::default();
        };
        let binding: Option<String> = connection
            .query_row(
                "SELECT value FROM version_config WHERE id=?1",
                [version.id as i64],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if binding
            .as_deref()
            .is_none_or(|value| value.is_empty() || value == config)
        {
            version
        } else {
            HarnessVersion {
                id: version.id,
                preferences: version.preferences,
                ..HarnessVersion::default()
            }
        }
    }
    pub fn append_trace(&self, trace: &ExecutionTrace) -> Result<(), String> {
        trace.validate()?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let settings: ImprovementSettings = decode(
            connection
                .query_row("SELECT value FROM state WHERE key='settings'", [], |row| {
                    row.get(0)
                })
                .map_err(db_error)?,
        )?;
        if !settings.enabled {
            return Ok(());
        }
        connection
            .execute(
                "INSERT OR IGNORE INTO traces VALUES (?1,?2,?3,?4)",
                params![trace.id, trace.at as i64, trace.signature(), encode(trace)?],
            )
            .map_err(db_error)?;
        Self::prune_in(&connection)
    }
    fn prune_in(connection: &Connection) -> Result<(), String> {
        connection.execute("DELETE FROM traces WHERE at<?1 OR id IN (SELECT id FROM traces ORDER BY at DESC LIMIT -1 OFFSET 10000)",[now_ms().saturating_sub(30*86400*1000) as i64]).map_err(db_error)?;
        Ok(())
    }
    pub fn prune(&self) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        Self::prune_in(&connection)
    }
    pub fn evidence(&self, automatic: bool) -> Result<Vec<ExecutionTrace>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let mut statement=connection.prepare("SELECT data FROM traces WHERE at>=?1 AND json_extract(data,'$.outcome')='failed' AND (?2=0 OR signature IN (SELECT signature FROM traces WHERE at>=?1 AND json_extract(data,'$.outcome')='failed' GROUP BY signature HAVING COUNT(*)>=3)) ORDER BY at DESC LIMIT 12").map_err(db_error)?;
        statement
            .query_map(
                params![now_ms().saturating_sub(7 * 86400 * 1000) as i64, automatic],
                |row| row.get::<_, String>(0),
            )
            .map_err(db_error)?
            .map(|row| decode(row.map_err(db_error)?))
            .collect()
    }
    pub fn daily_candidate_available(&self) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM candidates WHERE json_extract(data,'$.createdAt')>=?1",
                [now_ms().saturating_sub(86400 * 1000) as i64],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        Ok(count == 0)
    }
    #[cfg(test)]
    pub fn create_candidate(
        &self,
        manifest: CandidateManifest,
        config: &str,
    ) -> Result<ImprovementCandidate, String> {
        manifest.validate()?;
        if !is_digest(config) {
            return Err("Invalid evaluation configuration.".into());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        Self::create_in(&connection, manifest, config)
    }
    fn create_in(
        connection: &Connection,
        manifest: CandidateManifest,
        config: &str,
    ) -> Result<ImprovementCandidate, String> {
        if Self::active_in(connection)?.id != manifest.base_version {
            return Err("Candidate base version is stale.".into());
        }
        let candidate = ImprovementCandidate {
            id: uuid::Uuid::new_v4().to_string(),
            base_version: manifest.base_version,
            kind: manifest.kind,
            summary: manifest.summary.clone(),
            hash: digest(encode(&manifest)?.as_bytes()),
            evidence_digest: manifest.evidence_digest.clone(),
            config_digest: config.into(),
            created_at: now_ms(),
            status: CandidateStatus::Proposed,
            manifest,
            report: None,
        };
        connection
            .execute(
                "INSERT INTO candidates VALUES (?1,?2,'proposed',?3,?4,?5)",
                params![
                    candidate.id,
                    candidate.base_version as i64,
                    candidate.hash,
                    config,
                    encode(&candidate)?
                ],
            )
            .map_err(db_error)?;
        Ok(candidate)
    }
    pub fn create_for_job(
        &self,
        job: &str,
        manifest: CandidateManifest,
        config: &str,
    ) -> Result<ImprovementCandidate, String> {
        manifest.validate()?;
        if !safe_id(job, 128) || !is_digest(config) {
            return Err("Invalid durable candidate binding.".into());
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let transaction = connection.transaction().map_err(db_error)?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT candidate FROM job_candidates WHERE job=?1",
                [job],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(id) = existing {
            return Self::candidate_in(&transaction, &id);
        }
        let count: i64 = transaction
            .query_row(
                "SELECT count(*) FROM candidates WHERE json_extract(data,'$.createdAt')>=?1",
                [now_ms().saturating_sub(86400 * 1000) as i64],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if count > 0 {
            return Err("The daily candidate allowance has been used.".into());
        }
        let candidate = Self::create_in(&transaction, manifest, config)?;
        transaction
            .execute(
                "INSERT INTO job_candidates VALUES (?1,?2)",
                params![job, candidate.id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(candidate)
    }
    pub fn candidate_for_job(&self, job: &str) -> Result<Option<ImprovementCandidate>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let id: Option<String> = connection
            .query_row(
                "SELECT candidate FROM job_candidates WHERE job=?1",
                [job],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        id.map(|id| Self::candidate_in(&connection, &id))
            .transpose()
    }
    pub fn candidate_base(&self, id: &str) -> Result<HarnessVersion, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let candidate = Self::candidate_in(&connection, id)?;
        decode(
            connection
                .query_row(
                    "SELECT data FROM versions WHERE id=?1",
                    [candidate.base_version as i64],
                    |row| row.get(0),
                )
                .map_err(db_error)?,
        )
    }
    fn candidate_in(connection: &Connection, id: &str) -> Result<ImprovementCandidate, String> {
        let (data, status): (String, String) = connection
            .query_row(
                "SELECT data,status FROM candidates WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        let mut candidate: ImprovementCandidate = decode(data)?;
        candidate.status = decode(format!("\"{status}\""))?;
        candidate.report = connection
            .query_row("SELECT data FROM reports WHERE candidate=?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(db_error)?
            .map(decode)
            .transpose()?;
        Ok(candidate)
    }
    pub fn candidates(&self) -> Result<Vec<ImprovementCandidate>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let mut statement = connection
            .prepare("SELECT id FROM candidates ORDER BY rowid DESC LIMIT 50")
            .map_err(db_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .map(|id| Self::candidate_in(&connection, &id.map_err(db_error)?))
            .collect()
    }
    pub fn trace_count(&self) -> Result<u64, String> {
        self.connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?
            .query_row("SELECT COUNT(*) FROM traces", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|count| count as u64)
            .map_err(db_error)
    }
    pub fn candidate(&self, id: &str) -> Result<ImprovementCandidate, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        Self::candidate_in(&connection, id)
    }
    pub fn mark(&self, id: &str, status: CandidateStatus) -> Result<(), String> {
        let name = encode(&status)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        connection.execute("UPDATE candidates SET status=?1 WHERE id=?2 AND status IN ('proposed','evaluating','awaitingApproval')",params![name.trim_matches('"'),id]).map_err(db_error)?;
        Ok(())
    }
    pub fn finish_interrupted_evaluation(
        &self,
        id: &str,
        resumable: bool,
        cancelled: bool,
    ) -> Result<(), String> {
        let status = if resumable {
            "proposed"
        } else if cancelled {
            "cancelled"
        } else {
            "rejected"
        };
        self.connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?
            .execute(
                "UPDATE candidates SET status=?1 WHERE id=?2 AND status='evaluating'",
                params![status, id],
            )
            .map_err(db_error)?;
        Ok(())
    }
    pub fn record_report(
        &self,
        id: &str,
        mut report: EvaluationReport,
        requires_approval: bool,
    ) -> Result<EvaluationReport, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let transaction = connection.transaction().map_err(db_error)?;
        let candidate = Self::candidate_in(&transaction, id)?;
        if !matches!(
            candidate.status,
            CandidateStatus::Proposed | CandidateStatus::Evaluating
        ) || candidate.hash != report.candidate_hash
            || candidate.base_version != report.base_version
            || candidate.config_digest != report.config_digest
        {
            return Err("Evaluation binding is stale or invalid.".into());
        }
        report.reasons = evaluation::gate(&report);
        report.passed = report.reasons.is_empty();
        report.hash.clear();
        report.hash = digest(encode(&report)?.as_bytes());
        transaction
            .execute(
                "INSERT INTO reports VALUES (?1,?2,?3,?4)",
                params![report.id, id, report.hash, encode(&report)?],
            )
            .map_err(db_error)?;
        let stale = Self::active_in(&transaction)?.id != candidate.base_version;
        let status = if stale {
            "stale"
        } else if !report.passed {
            "rejected"
        } else if requires_approval || candidate.kind == CandidateKind::Workflow {
            "awaitingApproval"
        } else {
            Self::promote_in(&transaction, &candidate)?;
            "promoted"
        };
        transaction
            .execute(
                "UPDATE candidates SET status=?1 WHERE id=?2",
                params![status, id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(report)
    }
    fn promote_in(connection: &Connection, candidate: &ImprovementCandidate) -> Result<(), String> {
        let base = Self::active_in(connection)?;
        if base.id != candidate.base_version {
            return Err("Candidate base version is stale.".into());
        }
        let id = connection
            .query_row("SELECT COALESCE(MAX(id),0)+1 FROM versions", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(db_error)? as u64;
        let version = candidate.manifest.apply(&base, id);
        connection
            .execute(
                "INSERT INTO versions VALUES (?1,?2,?3)",
                params![id as i64, base.id as i64, encode(&version)?],
            )
            .map_err(db_error)?;
        connection
            .execute(
                "INSERT INTO version_config VALUES (?1,?2)",
                params![id as i64, candidate.config_digest],
            )
            .map_err(db_error)?;
        connection
            .execute(
                "INSERT INTO promotions VALUES (?1,?2,?3)",
                params![candidate.id, id as i64, now_ms() as i64],
            )
            .map_err(db_error)?;
        if connection
            .execute(
                "UPDATE state SET value=?1 WHERE key='active' AND value=?2",
                params![id.to_string(), base.id.to_string()],
            )
            .map_err(db_error)?
            != 1
        {
            return Err("Active version changed.".into());
        }
        connection.execute("UPDATE candidates SET status='stale' WHERE parent=?1 AND id<>?2 AND status IN ('proposed','evaluating','awaitingApproval')",params![base.id as i64,candidate.id]).map_err(db_error)?;
        Ok(())
    }
    pub fn approve(&self, approval: &ApprovalRef, current_config: &str) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let transaction = connection.transaction().map_err(db_error)?;
        let candidate = Self::candidate_in(&transaction, &approval.candidate_id)?;
        let report = candidate
            .report
            .as_ref()
            .ok_or("Candidate has not passed evaluation.")?;
        if candidate.status != CandidateStatus::AwaitingApproval
            || candidate.hash != approval.candidate_hash
            || candidate.base_version != approval.base_version
            || report.hash != approval.report_hash
            || candidate.config_digest != current_config
            || !report.passed
            || !evaluation::gate(report).is_empty()
        {
            return Err("Approval or evaluation is stale or invalid.".into());
        }
        Self::promote_in(&transaction, &candidate)?;
        transaction
            .execute(
                "UPDATE candidates SET status='promoted' WHERE id=?1",
                [&candidate.id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(())
    }
    pub fn rollback(&self, id: u64) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let transaction = connection.transaction().map_err(db_error)?;
        if id > 9_007_199_254_740_991 {
            return Err("Unknown harness version.".into());
        }
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM versions WHERE id=?1)",
                [id as i64],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("Unknown harness version.".into());
        }
        transaction
            .execute(
                "UPDATE state SET value=?1 WHERE key='active'",
                [id.to_string()],
            )
            .map_err(db_error)?;
        transaction.execute("UPDATE candidates SET status='stale' WHERE status IN ('proposed','evaluating','awaitingApproval')",[]).map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(())
    }
    pub fn save_preference(&self, preference: Preference) -> Result<(), String> {
        preference.validate()?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let transaction = connection.transaction().map_err(db_error)?;
        let mut version = Self::active_in(&transaction)?;
        let parent = version.id;
        version.id = transaction
            .query_row("SELECT COALESCE(MAX(id),0)+1 FROM versions", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(db_error)? as u64;
        version.parent_id = Some(parent);
        version.created_at = now_ms();
        version.preferences.retain(|p| p.name != preference.name);
        version.preferences.push(preference);
        transaction
            .execute(
                "INSERT INTO versions VALUES (?1,?2,?3)",
                params![version.id as i64, parent as i64, encode(&version)?],
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "INSERT INTO version_config SELECT ?1,value FROM version_config WHERE id=?2",
                params![version.id as i64, parent as i64],
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "UPDATE state SET value=?1 WHERE key='active'",
                [version.id.to_string()],
            )
            .map_err(db_error)?;
        transaction.execute("UPDATE candidates SET status='stale' WHERE status IN ('proposed','evaluating','awaitingApproval')",[]).map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(())
    }
    pub fn clear(&self) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Improvement storage is busy.")?;
        let transaction = connection.transaction().map_err(db_error)?;
        transaction.execute_batch("DELETE FROM reports;DELETE FROM job_candidates;DELETE FROM candidates;DELETE FROM promotions;DELETE FROM traces;DELETE FROM versions WHERE id<>0;DELETE FROM version_config;DELETE FROM job_budget;DELETE FROM token_reservations;UPDATE state SET value='0' WHERE key='active';").map_err(db_error)?;
        transaction
            .execute(
                "UPDATE state SET value=?1 WHERE key='settings'",
                [encode(&ImprovementSettings::default())?],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(db_error)?;
        Ok(())
    }
}
