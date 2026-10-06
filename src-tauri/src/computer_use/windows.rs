use super::protocol::WindowTarget;
use std::{collections::HashMap, sync::Mutex};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowIdentity {
    pub pid: u32,
    pub hwnd: u64,
    pub executable: String,
    pub created: u64,
    pub owner: u64,
    pub dpi: u32,
}
#[derive(Default)]
pub struct TargetRegistry(Mutex<HashMap<String, WindowIdentity>>);
impl TargetRegistry {
    pub fn discover(&self) -> Result<Vec<WindowTarget>, String> {
        let windows = native::enumerate()?;
        let mut registry = self.0.lock().map_err(|_| "target_state_unavailable")?;
        // Discovery never invalidates the identity held by an active run.
        let mut result = Vec::new();
        for (identity, title, reason) in windows {
            let existing = registry
                .iter()
                .find(|(_, v)| *v == &identity)
                .map(|(k, _)| k.clone());
            let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            registry.insert(id.clone(), identity.clone());
            result.push(WindowTarget {
                target_id: id,
                title,
                process_name: std::path::Path::new(&identity.executable)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                available: reason.is_none(),
                reason,
            });
        }
        if registry.len() > 2048 {
            registry.retain(|_, v| {
                native::identity(v.hwnd).is_ok_and(|(now, reason)| now == *v && reason.is_none())
            });
        }
        result.sort_by_key(|a| a.title.to_lowercase());
        Ok(result)
    }
    pub fn resolve(&self, id: &str) -> Result<WindowIdentity, String> {
        let value = self
            .0
            .lock()
            .map_err(|_| "target_state_unavailable")?
            .get(id)
            .cloned()
            .ok_or("target_unavailable")?;
        revalidate(&value)?;
        Ok(value)
    }
}
pub fn revalidate(expected: &WindowIdentity) -> Result<(), String> {
    let (now, reason) = native::identity(expected.hwnd)?;
    if let Some(reason) = reason {
        return Err(reason);
    }
    if now != *expected {
        return Err("target_changed: select the window again".to_owned());
    }
    if !native::interactive() {
        return Err("interactive_desktop_unavailable".to_owned());
    }
    Ok(())
}
pub fn interactive() -> bool {
    native::interactive()
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows::{
        Win32::{
            Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM},
            Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
            System::{
                RemoteDesktop::ProcessIdToSessionId,
                StationsAndDesktops::{
                    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
                    GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
                },
                Threading::{
                    GetProcessTimes, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
                    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
                },
            },
            UI::{
                HiDpi::GetDpiForWindow,
                WindowsAndMessaging::{
                    EnumWindows, GW_OWNER, GetWindow, GetWindowTextW, GetWindowThreadProcessId,
                    IsWindow, IsWindowVisible,
                },
            },
        },
        core::{BOOL, PWSTR},
    };
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    pub fn interactive() -> bool {
        unsafe {
            let Ok(desktop) =
                OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
            else {
                return false;
            };
            let mut name = [0u16; 128];
            let ok = GetUserObjectInformationW(
                HANDLE(desktop.0),
                UOI_NAME,
                Some(name.as_mut_ptr().cast()),
                std::mem::size_of_val(&name) as u32,
                None,
            )
            .is_ok();
            let _ = CloseDesktop(desktop);
            ok && String::from_utf16_lossy(
                &name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())],
            )
            .eq_ignore_ascii_case("Default")
        }
    }
    pub fn identity(raw: u64) -> Result<(WindowIdentity, Option<String>), String> {
        unsafe {
            let hwnd = HWND(raw as usize as *mut _);
            if !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() {
                return Err("target_closed".to_owned());
            }
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == std::process::id() {
                return Err("target_unavailable".to_owned());
            }
            let process = OwnedHandle(
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                    .map_err(|_| "process_unavailable")?,
            );
            let mut path = [0u16; 32768];
            let mut length = path.len() as u32;
            QueryFullProcessImageNameW(
                process.0,
                PROCESS_NAME_WIN32,
                PWSTR(path.as_mut_ptr()),
                &mut length,
            )
            .map_err(|_| "process_identity_unavailable")?;
            let executable = String::from_utf16_lossy(&path[..length as usize]);
            let (mut created, mut exit, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            GetProcessTimes(process.0, &mut created, &mut exit, &mut kernel, &mut user)
                .map_err(|_| "process_identity_unavailable")?;
            let mut handle = HANDLE::default();
            OpenProcessToken(process.0, TOKEN_QUERY, &mut handle)
                .map_err(|_| "process_permission_unavailable")?;
            let token = OwnedHandle(handle);
            let mut elevation = TOKEN_ELEVATION::default();
            let mut size = 0;
            GetTokenInformation(
                token.0,
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            )
            .map_err(|_| "process_permission_unavailable")?;
            let (mut session, mut ours) = (0, 0);
            ProcessIdToSessionId(pid, &mut session).map_err(|_| "session_unavailable")?;
            ProcessIdToSessionId(std::process::id(), &mut ours)
                .map_err(|_| "session_unavailable")?;
            let owner = GetWindow(hwnd, GW_OWNER)
                .map(|h| h.0 as usize as u64)
                .unwrap_or(0);
            let reason = if session == 0 || session != ours {
                Some("The window is outside this interactive session".to_owned())
            } else if elevation.TokenIsElevated != 0 {
                Some("Elevated windows are unavailable".to_owned())
            } else {
                None
            };
            Ok((
                WindowIdentity {
                    pid,
                    hwnd: raw,
                    executable,
                    created: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
                    owner,
                    dpi: GetDpiForWindow(hwnd),
                },
                reason,
            ))
        }
    }
    type Listed = (WindowIdentity, String, Option<String>);
    unsafe extern "system" fn collect(hwnd: HWND, param: LPARAM) -> BOOL {
        let output = unsafe { &mut *(param.0 as *mut Vec<Listed>) };
        if let Ok((identity, reason)) = identity(hwnd.0 as usize as u64) {
            let mut name = [0u16; 512];
            let length = unsafe { GetWindowTextW(hwnd, &mut name) };
            if length > 0 {
                output.push((
                    identity,
                    String::from_utf16_lossy(&name[..length as usize]),
                    reason,
                ));
            }
        }
        BOOL(1)
    }
    pub fn enumerate() -> Result<Vec<Listed>, String> {
        if !interactive() {
            return Err("interactive_desktop_unavailable".to_owned());
        }
        let mut output = Vec::new();
        unsafe {
            EnumWindows(
                Some(collect),
                LPARAM((&mut output as *mut Vec<Listed>) as isize),
            )
            .map_err(|_| "window_discovery_unavailable")?;
        }
        Ok(output)
    }
}
#[cfg(not(windows))]
mod native {
    use super::*;
    pub fn interactive() -> bool {
        false
    }
    pub fn identity(_: u64) -> Result<(WindowIdentity, Option<String>), String> {
        Err("Windows 11 is required".to_owned())
    }
    pub fn enumerate() -> Result<Vec<(WindowIdentity, String, Option<String>)>, String> {
        Err("Windows 11 is required".to_owned())
    }
}
