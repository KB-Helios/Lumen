use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImprovementSettings {
    pub enabled: bool,
    pub cloud_consent: bool,
    pub route_mode: RouteMode,
    pub paused: bool,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RouteMode {
    #[default]
    Local,
    Cloud,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionTrace {
    pub id: String,
    pub at: u64,
    pub tool_id: ToolId,
    pub model: String,
    pub route: String,
    pub error_code: TraceError,
    pub outcome: TraceOutcome,
    pub verified: bool,
    pub duration_ms: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub harness_version: u64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ToolId {
    #[serde(rename = "answer.generate")]
    AnswerGenerate,
    #[serde(rename = "computerUse.plan")]
    ComputerUsePlan,
    #[serde(rename = "files.search")]
    FilesSearch,
    #[serde(rename = "workflow.run")]
    WorkflowRun,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TraceError {
    None,
    InvalidResponse,
    ProviderUnavailable,
    Cancelled,
    VerificationFailed,
    PermissionDenied,
    UnsupportedAction,
    BudgetExceeded,
    UnknownFailure,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TraceOutcome {
    Completed,
    Failed,
    Cancelled,
}
impl ExecutionTrace {
    pub fn validate(&self) -> Result<(), String> {
        if !safe_id(&self.id, 128)
            || !is_digest(&self.model)
            || ![
                "lumen.answer.local",
                "lumen.answer.cloud",
                "lumen.search",
                "computerUse.openai",
                "computerUse.gemini",
                "lumen.workflow",
            ]
            .contains(&self.route.as_str())
            || self.at > now_ms().saturating_add(60_000)
        {
            return Err("Invalid learning metadata.".into());
        }
        Ok(())
    }
    pub fn signature(&self) -> String {
        digest(
            format!(
                "{:?}|{:?}|{}|{}",
                self.tool_id, self.error_code, self.model, self.harness_version
            )
            .as_bytes(),
        )
    }
}
pub fn safe_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preference {
    pub name: PreferenceName,
    pub value: String,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PreferenceName {
    AnswerLanguage,
    AnswerVerbosity,
}
impl Preference {
    pub fn validate(&self) -> Result<(), String> {
        let valid = match self.name {
            PreferenceName::AnswerLanguage => ["sv", "en", "system"].contains(&self.value.as_str()),
            PreferenceName::AnswerVerbosity => {
                ["brief", "normal", "detailed"].contains(&self.value.as_str())
            }
        };
        if valid {
            Ok(())
        } else {
            Err("Unsupported explicit preference.".into())
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDefinition {
    pub id: String,
    pub name: String,
    pub steps: Vec<WorkflowStep>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAuthorization {
    pub run_id: String,
    pub version_id: u64,
    pub workflow: WorkflowDefinition,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStep {
    pub kind: WorkflowStepKind,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowStepKind {
    Search,
    Answer,
    ComputerUseDraft,
}
impl WorkflowDefinition {
    pub fn validate(&self) -> Result<(), String> {
        if !safe_id(&self.id, 64)
            || self.name.is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
            || self.steps.is_empty()
            || self.steps.len() > 8
        {
            return Err("Invalid bounded workflow.".into());
        }
        let drafts = self
            .steps
            .iter()
            .filter(|step| step.kind == WorkflowStepKind::ComputerUseDraft)
            .count();
        if drafts > 1
            || (drafts == 1
                && self
                    .steps
                    .last()
                    .is_none_or(|step| step.kind != WorkflowStepKind::ComputerUseDraft))
        {
            return Err("Computer Use must finish with an explicit draft.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessVersion {
    pub id: u64,
    pub parent_id: Option<u64>,
    pub created_at: u64,
    pub answer_instructions: String,
    pub computer_use_instructions: String,
    pub tool_hints: String,
    pub preferences: Vec<Preference>,
    pub workflows: Vec<WorkflowDefinition>,
}
impl HarnessVersion {
    pub fn answer_supplement(&self) -> String {
        let mut parts = vec![self.answer_instructions.clone(), self.tool_hints.clone()];
        for preference in &self.preferences {
            parts.push(match preference.name {
                PreferenceName::AnswerLanguage => format!(
                    "User explicitly prefers answer language: {}.",
                    preference.value
                ),
                PreferenceName::AnswerVerbosity => format!(
                    "User explicitly prefers answer length: {}.",
                    preference.value
                ),
            });
        }
        parts
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
    pub fn computer_use_supplement(&self) -> String {
        [&self.computer_use_instructions, &self.tool_hints]
            .into_iter()
            .filter(|p| !p.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CandidateKind {
    Memory,
    Prompt,
    Workflow,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateManifest {
    pub base_version: u64,
    pub kind: CandidateKind,
    pub summary: String,
    pub evidence_digest: String,
    pub answer_instructions: Option<String>,
    pub computer_use_instructions: Option<String>,
    pub tool_hints: Option<String>,
    pub preferences: Vec<Preference>,
    pub workflows: Vec<WorkflowDefinition>,
}
impl CandidateManifest {
    pub fn validate(&self) -> Result<(), String> {
        if self.base_version > 9_007_199_254_740_991 {
            return Err("Invalid candidate base version.".into());
        }
        if self.kind == CandidateKind::Memory || !self.preferences.is_empty() {
            return Err("Memories require an explicit user preference.".into());
        }
        if self.summary.is_empty()
            || self.summary.chars().count() > 500
            || self.summary.chars().any(char::is_control)
            || !is_digest(&self.evidence_digest)
        {
            return Err("Invalid candidate manifest.".into());
        }
        if self.kind == CandidateKind::Prompt
            && (self.answer_instructions.is_none()
                && self.computer_use_instructions.is_none()
                && self.tool_hints.is_none()
                || !self.workflows.is_empty())
        {
            return Err("A prompt candidate must change instructions only.".into());
        }
        if self.kind == CandidateKind::Workflow
            && (self.workflows.is_empty()
                || self.answer_instructions.is_some()
                || self.computer_use_instructions.is_some()
                || self.tool_hints.is_some())
        {
            return Err("A workflow candidate must change workflows only.".into());
        }
        for value in [
            &self.answer_instructions,
            &self.computer_use_instructions,
            &self.tool_hints,
        ]
        .into_iter()
        .flatten()
        {
            if value.len() > 8192
                || value
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return Err("Candidate instructions are invalid or too large.".into());
            }
        }
        if self.workflows.len() > 16
            || serde_json::to_vec(self)
                .map_err(|_| "Invalid candidate.")?
                .len()
                > 65536
        {
            return Err("Candidate is too large.".into());
        }
        let mut ids = std::collections::HashSet::new();
        for workflow in &self.workflows {
            workflow.validate()?;
            if !ids.insert(&workflow.id) {
                return Err("Duplicate workflow identity.".into());
            }
        }
        Ok(())
    }
    pub fn apply(&self, base: &HarnessVersion, id: u64) -> HarnessVersion {
        HarnessVersion {
            id,
            parent_id: Some(base.id),
            created_at: now_ms(),
            answer_instructions: self
                .answer_instructions
                .clone()
                .unwrap_or_else(|| base.answer_instructions.clone()),
            computer_use_instructions: self
                .computer_use_instructions
                .clone()
                .unwrap_or_else(|| base.computer_use_instructions.clone()),
            tool_hints: self
                .tool_hints
                .clone()
                .unwrap_or_else(|| base.tool_hints.clone()),
            preferences: base.preferences.clone(),
            workflows: if self.kind == CandidateKind::Workflow {
                self.workflows.clone()
            } else {
                base.workflows.clone()
            },
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImprovementCandidate {
    pub id: String,
    pub base_version: u64,
    pub kind: CandidateKind,
    pub summary: String,
    pub hash: String,
    pub evidence_digest: String,
    pub config_digest: String,
    pub created_at: u64,
    pub status: CandidateStatus,
    pub manifest: CandidateManifest,
    pub report: Option<EvaluationReport>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CandidateStatus {
    Proposed,
    Evaluating,
    Rejected,
    AwaitingApproval,
    Promoted,
    Stale,
    Cancelled,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRef {
    pub candidate_id: String,
    pub candidate_hash: String,
    pub base_version: u64,
    pub report_hash: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaseMeasurements {
    pub runs: u32,
    pub successes: u32,
    pub latencies_ms: Vec<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EvaluationSet {
    Development,
    HeldOut,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationCase {
    pub id: String,
    pub set: EvaluationSet,
    pub safety: bool,
    pub baseline: CaseMeasurements,
    pub candidate: CaseMeasurements,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationReport {
    pub id: String,
    pub candidate_hash: String,
    pub base_version: u64,
    pub config_digest: String,
    pub suite_version: String,
    pub complete: bool,
    pub budget_exceeded: bool,
    pub cases: Vec<EvaluationCase>,
    pub passed: bool,
    pub reasons: Vec<String>,
    pub hash: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub phase: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImprovementSnapshot {
    pub settings: ImprovementSettings,
    pub active_version: HarnessVersion,
    pub candidates: Vec<ImprovementCandidate>,
    pub trace_count: u64,
    pub job: Option<JobSnapshot>,
    pub paused: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImprovementHealth {
    pub state: &'static str,
    pub version: &'static str,
    pub detail: Option<String>,
    pub prepared: bool,
    pub model_ready: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImprovementEvent {
    pub r#type: &'static str,
    pub job_id: String,
    pub phase: String,
    pub message: Option<String>,
}
