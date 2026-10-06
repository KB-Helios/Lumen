use serde::{Deserialize, Serialize};

pub const MAX_LINE: usize = 16 * 1024 * 1024;
pub const GEMINI_MODELS: &[&str] = &[
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-2.5-computer-use-preview-10-2025",
    "gemini-3-flash-preview",
];
pub const OPENAI_MODELS: &[&str] = &["gpt-6.1-sol"];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Gemini,
    Openai,
}
impl Provider {
    pub fn id(self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::Openai => "openai",
        }
    }
    pub fn models(self) -> &'static [&'static str] {
        match self {
            Self::Gemini => GEMINI_MODELS,
            Self::Openai => OPENAI_MODELS,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    Fast,
    Background,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Stop,
    TakeOver,
    ConsentRevoked,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TargetSelection {
    Browser {
        initial_url: String,
        #[serde(default)]
        visible: bool,
    },
    Window {
        target_id: String,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerUseRequest {
    pub task_id: u64,
    pub task: String,
    pub provider: Provider,
    pub model: String,
    pub execution_mode: ExecutionMode,
    pub target: TargetSelection,
    pub cloud_consent: bool,
    pub desktop_control_consent: bool,
    pub desktop_cloud_consent: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseEvent {
    pub task_id: u64,
    pub run_id: String,
    pub generation: u64,
    pub target_id: String,
    #[serde(flatten)]
    pub event: EventKind,
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EventKind {
    Started {
        provider: Provider,
        model: String,
        execution_mode: ExecutionMode,
        browser: String,
    },
    Reasoning {
        text: String,
    },
    Action {
        action_id: String,
        action: String,
    },
    Observation {
        snapshot_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    ApprovalRequired {
        approval_id: String,
        action_id: String,
        snapshot_id: String,
        scope: ApprovalScope,
        explanation: String,
    },
    ApprovalResolved {
        approval_id: String,
        approved: bool,
    },
    Completed {
        summary: String,
    },
    Stopped {
        reason: StopReason,
        uncertain: bool,
    },
    Failed {
        message: String,
        code: String,
    },
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalScope {
    Safety,
    Foreground,
    VisibleBrowser,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
impl Availability {
    pub fn from(available: bool, reason: &str) -> Self {
        Self {
            available,
            reason: (!available).then(|| reason.to_owned()),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAvailability {
    pub credential_configured: bool,
    pub available: bool,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Providers {
    pub gemini: ProviderAvailability,
    pub openai: ProviderAvailability,
}
#[derive(Clone, Debug, Serialize)]
pub struct Routes {
    pub browser: Availability,
    pub desktop: Availability,
    pub foreground: Availability,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseHealth {
    pub state: &'static str,
    pub mode: &'static str,
    pub browser: &'static str,
    pub credential_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub native_stop: Availability,
    pub routes: Routes,
    pub providers: Providers,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTarget {
    pub target_id: String,
    pub title: String,
    pub process_name: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkerTarget {
    Browser {
        initial_url: String,
        headless: bool,
    },
    Window {
        pid: u32,
        window_id: u64,
        executable: String,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: u64,
    pub run_id: String,
    pub generation: u64,
    #[serde(flatten)]
    pub operation: Operation,
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Operation {
    Begin {
        target: WorkerTarget,
        #[serde(skip_serializing_if = "Option::is_none")]
        manifest_path: Option<String>,
    },
    Observe {
        screenshot: bool,
    },
    Act {
        snapshot_id: String,
        action: Action,
    },
    End,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub id: u64,
    pub run_id: String,
    pub generation: u64,
    pub ok: bool,
    pub observation: Option<Observation>,
    pub result: Option<ActionResult>,
    pub error: Option<WorkerError>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerError {
    pub code: String,
    pub message: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerHealth {
    pub ready: bool,
    pub edge_available: bool,
    pub desktop_available: bool,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub snapshot_id: String,
    pub url: Option<String>,
    pub title: String,
    pub elements: Vec<Element>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<Image>,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub degraded: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Element {
    #[serde(rename = "ref")]
    pub reference: String,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub automation_id: Option<String>,
    pub enabled: bool,
    pub bounds: Option<Bounds>,
    pub actions: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Image {
    pub mime_type: String,
    pub data: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Invoke,
    SetValue,
    Select,
    Scroll,
    Navigate,
    Keypress,
    Click,
    DoubleClick,
    RightClick,
    Move,
    Drag,
    Type,
    Wait,
}
impl ActionKind {
    pub fn id(self) -> &'static str {
        match self {
            Self::Invoke => "invoke",
            Self::SetValue => "setValue",
            Self::Select => "select",
            Self::Scroll => "scroll",
            Self::Navigate => "navigate",
            Self::Keypress => "keypress",
            Self::Click => "click",
            Self::DoubleClick => "doubleClick",
            Self::RightClick => "rightClick",
            Self::Move => "move",
            Self::Drag => "drag",
            Self::Type => "type",
            Self::Wait => "wait",
        }
    }
    pub fn coordinates(self) -> bool {
        matches!(
            self,
            Self::Click | Self::DoubleClick | Self::RightClick | Self::Move | Self::Drag
        )
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub kind: ActionKind,
    pub element: Option<String>,
    pub text: Option<String>,
    pub url: Option<String>,
    pub keys: Option<Vec<String>>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub end_x: Option<f64>,
    pub end_y: Option<f64>,
    pub direction: Option<String>,
    pub amount: Option<f64>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Effect {
    Confirmed,
    Unverifiable,
    SuspectedNoop,
    Partial,
    Refused,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    Uia,
    Win32,
    Playwright,
    BackgroundPixels,
    Foreground,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionResult {
    pub effect: Effect,
    pub route: Route,
    pub verified: bool,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionPlan {
    pub actions: Vec<Action>,
    pub done: bool,
    pub summary: String,
    pub needs_vision: bool,
    #[serde(default)]
    pub completion_checks: Vec<CompletionCheck>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionCheck {
    pub kind: CompletionCheckKind,
    pub element: Option<String>,
    pub expected: String,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionCheckKind {
    #[serde(rename = "valueEquals")]
    Value,
    #[serde(rename = "nameEquals")]
    Name,
    #[serde(rename = "urlEquals")]
    Url,
    #[serde(rename = "titleEquals")]
    Title,
}
