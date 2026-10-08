use super::{coordinator::ImprovementRuntime, types::*};
use crate::gateway::registry::ProviderRegistry;
use std::sync::Arc;
use tauri::{AppHandle, State, ipc::Channel};

#[tauri::command]
pub async fn improvement_health(
    runtime: State<'_, Arc<ImprovementRuntime>>,
    registry: State<'_, ProviderRegistry>,
    enrichment: State<'_, crate::gateway::EnrichmentSupervisor>,
) -> Result<ImprovementHealth, String> {
    Ok(runtime.health(&registry, &enrichment).await)
}
#[tauri::command]
pub fn improvement_snapshot(
    runtime: State<'_, Arc<ImprovementRuntime>>,
) -> Result<ImprovementSnapshot, String> {
    runtime.snapshot()
}
#[tauri::command]
pub fn improvement_candidate_base(
    candidate_id: String,
    runtime: State<'_, Arc<ImprovementRuntime>>,
) -> Result<HarnessVersion, String> {
    runtime.store.candidate_base(&candidate_id)
}
#[tauri::command]
pub fn set_improvement_settings(
    settings: ImprovementSettings,
    runtime: State<'_, Arc<ImprovementRuntime>>,
) -> Result<(), String> {
    runtime.set_settings(settings)
}
#[tauri::command]
pub async fn prepare_improvement_runtime(
    runtime: State<'_, Arc<ImprovementRuntime>>,
) -> Result<(), String> {
    runtime.prepare().await
}
#[tauri::command]
pub fn analyze_improvements(
    app: AppHandle,
    on_event: Channel<ImprovementEvent>,
    runtime: State<'_, Arc<ImprovementRuntime>>,
) -> Result<(), String> {
    runtime.inner().clone().analyze(app, Some(on_event), false)
}
#[tauri::command]
pub fn cancel_improvements(runtime: State<'_, Arc<ImprovementRuntime>>) {
    runtime.cancel(false);
}
#[tauri::command]
pub fn approve_improvement(
    approval: ApprovalRef,
    runtime: State<'_, Arc<ImprovementRuntime>>,
    registry: State<'_, ProviderRegistry>,
) -> Result<(), String> {
    runtime.approve(&approval, &registry)
}
#[tauri::command]
pub fn reject_improvement(
    candidate_id: String,
    runtime: State<'_, Arc<ImprovementRuntime>>,
) -> Result<(), String> {
    runtime.reject(&candidate_id)
}
#[tauri::command]
pub fn rollback_improvement(
    version_id: u64,
    runtime: State<'_, Arc<ImprovementRuntime>>,
) -> Result<(), String> {
    runtime.rollback(version_id)
}
#[tauri::command]
pub async fn clear_improvement_data(
    app: AppHandle,
    runtime: State<'_, Arc<ImprovementRuntime>>,
) -> Result<(), String> {
    runtime.clear(&app).await
}
#[tauri::command]
pub fn save_improvement_preference(
    preference: Preference,
    runtime: State<'_, Arc<ImprovementRuntime>>,
) -> Result<(), String> {
    runtime.preference(preference)
}
#[tauri::command]
pub fn improvement_workflows(
    runtime: State<'_, Arc<ImprovementRuntime>>,
    registry: State<'_, ProviderRegistry>,
) -> Vec<WorkflowDefinition> {
    runtime.capture(&registry).workflows
}
#[tauri::command]
pub fn authorize_improvement_workflow(
    workflow_id: String,
    version_id: u64,
    runtime: State<'_, Arc<ImprovementRuntime>>,
    registry: State<'_, ProviderRegistry>,
) -> Result<WorkflowAuthorization, String> {
    runtime.authorize_workflow(&workflow_id, version_id, &registry)
}
#[tauri::command]
pub fn end_improvement_workflow(
    run_id: String,
    outcome: TraceOutcome,
    runtime: State<'_, Arc<ImprovementRuntime>>,
) {
    runtime.end_workflow(&run_id, outcome);
}
