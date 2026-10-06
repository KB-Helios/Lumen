mod coordinator;
mod executor;
mod foreground;
mod gate;
mod policy;
mod protocol;
mod provider;
mod stop;
mod windows;

pub use coordinator::ComputerUseSupervisor;
use coordinator::Metrics;
use protocol::{ComputerUseEvent, ComputerUseHealth, ComputerUseRequest, StopReason, WindowTarget};
use tauri::{State, ipc::Channel};

#[tauri::command]
pub async fn computer_use_health(
    supervisor: State<'_, ComputerUseSupervisor>,
) -> Result<ComputerUseHealth, String> {
    Ok(supervisor.inner().health().await)
}
#[tauri::command]
pub fn computer_use_targets(
    supervisor: State<'_, ComputerUseSupervisor>,
) -> Result<Vec<WindowTarget>, String> {
    supervisor.inner().targets()
}
#[tauri::command]
pub fn computer_use_diagnostics(supervisor: State<'_, ComputerUseSupervisor>) -> Vec<Metrics> {
    supervisor.inner().diagnostics()
}
#[tauri::command]
pub fn start_computer_use(
    request: ComputerUseRequest,
    on_event: Channel<ComputerUseEvent>,
    supervisor: State<'_, ComputerUseSupervisor>,
) -> Result<(), String> {
    supervisor.inner().start(request, on_event)
}
#[tauri::command]
pub fn respond_computer_use_approval(
    task_id: u64,
    approval_id: String,
    approved: bool,
    supervisor: State<'_, ComputerUseSupervisor>,
) -> Result<(), String> {
    supervisor.inner().respond(task_id, &approval_id, approved)
}
#[tauri::command]
pub fn stop_computer_use(
    task_id: u64,
    reason: StopReason,
    supervisor: State<'_, ComputerUseSupervisor>,
) -> Result<(), String> {
    supervisor.inner().stop(task_id, reason)
}
#[tauri::command]
pub fn cancel_computer_use(
    task_id: u64,
    supervisor: State<'_, ComputerUseSupervisor>,
) -> Result<(), String> {
    supervisor.inner().stop(task_id, StopReason::Stop)
}
