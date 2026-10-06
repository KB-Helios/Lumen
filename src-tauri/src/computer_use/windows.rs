use super::protocol::WindowTarget;
use std::{collections::HashMap, sync::Mutex};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowIdentity {
    pub pid: u32,
    pub hwnd: u64,
    pub executable: String,
    pub created: u64,
    pub window_instance: u64,
    pub owner: u64,
    pub dpi: u32,
}
#[derive(Default)]
pub struct TargetRegistry(Mutex<HashMap<String, WindowIdentity>>);
impl TargetRegistry {
    pub fn discover(&self) -> Result<Vec<WindowTarget>, String> {
        let mut registry = self.0.lock().map_err(|_| "target_state_unavailable")?;
        let windows = native::enumerate()?;
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
            let mut removed = Vec::new();
            registry.retain(|_, v| {
                let live = native::identity(v.hwnd)
                    .is_ok_and(|(now, reason)| now == *v && reason.is_none());
                if !live {
                    removed.push(v.clone());
                }
                live
            });
            for stale in removed {
                // A new DPI/owner fingerprint can still share this live window.
                if !registry.values().any(|live| {
                    live.hwnd == stale.hwnd && live.window_instance == stale.window_instance
                }) {
                    native::forget(&stale);
                }
            }
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
    if expected.window_instance == 0 {
        return Err("window_identity_unavailable".to_owned());
    }
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
impl Drop for TargetRegistry {
    fn drop(&mut self) {
        if let Ok(registry) = self.0.get_mut() {
            for identity in registry.values() {
                native::forget(identity);
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        os::windows::process::CommandExt,
        process::{Child, Command, Stdio},
        sync::MutexGuard,
    };
    use windows::{
        Win32::{
            Foundation::{HANDLE, HWND, LPARAM},
            UI::WindowsAndMessaging::{EnumPropsExW, RemovePropW},
        },
        core::{BOOL, PCWSTR},
    };

    static DESKTOP: Mutex<()> = Mutex::new(());
    struct Fixture {
        child: Child,
        _serial: MutexGuard<'static, ()>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(stdin) = self.child.stdin.as_mut() {
                let _ = stdin.write_all(b"\n");
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn fixture() -> (Fixture, u64) {
        // Discovery enumerates the shared desktop; other registries must not
        // remove markers until this fixture's registry has been dropped.
        let serial = DESKTOP.lock().unwrap_or_else(|error| error.into_inner());
        let script = r#"
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LumenIdentityFixture {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
}
'@
$fixtureWindow = [LumenIdentityFixture]::CreateWindowExW(0x08000000, 'STATIC', 'Lumen identity fixture', 0x10cf0000, 20, 20, 240, 120, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
[Console]::WriteLine($fixtureWindow.ToInt64())
[Console]::Out.Flush()
[Console]::ReadLine() | Out-Null
"#;
        let mut fixture = Fixture {
            child: Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .creation_flags(0x0800_0000)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
            _serial: serial,
        };
        let mut output = BufReader::new(fixture.child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let raw = line.trim().parse::<u64>().unwrap();
        assert_ne!(raw, 0);
        (fixture, raw)
    }

    fn remove_marker(raw: u64) {
        unsafe extern "system" fn remove(hwnd: HWND, name: PCWSTR, _: HANDLE, _: usize) -> BOOL {
            if name.0 as usize > 0xffff
                && unsafe { name.to_string() }
                    .is_ok_and(|name| name.starts_with("Lumen.ComputerUse.WindowIdentity."))
            {
                let _ = unsafe { RemovePropW(hwnd, name) };
            }
            BOOL(1)
        }
        unsafe {
            EnumPropsExW(HWND(raw as usize as *mut _), Some(remove), LPARAM(0));
        }
    }

    #[test]
    #[ignore = "requires a non-elevated interactive Windows desktop; run separately"]
    fn a_lost_window_instance_marker_invalidates_selection_without_process_changes() {
        // Removing only our window property models HWND reuse with identical
        // process metadata, without creating thousands of unrelated windows.
        let (_fixture, raw) = fixture();
        let registry = TargetRegistry::default();
        registry.discover().unwrap();
        let target_id = registry
            .0
            .lock()
            .unwrap()
            .iter()
            .find(|(_, identity)| identity.hwnd == raw)
            .map(|(id, _)| id.clone())
            .unwrap();
        let selected = registry.resolve(&target_id).unwrap();

        remove_marker(raw);
        assert!(registry.resolve(&target_id).is_err());
        registry.discover().unwrap();
        assert!(registry.resolve(&target_id).is_err());
        let replacement = registry
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, identity)| **id != target_id && identity.hwnd == raw)
            .map(|(id, _)| id.clone())
            .next()
            .unwrap();
        let current = registry.resolve(&replacement).unwrap();
        assert_eq!(
            (selected.pid, selected.hwnd, selected.created),
            (current.pid, current.hwnd, current.created)
        );
        assert_eq!(selected.executable, current.executable);
    }

    #[test]
    #[ignore = "requires a non-elevated interactive Windows desktop; run separately"]
    fn unmarked_windows_are_never_admitted() {
        let (_fixture, raw) = fixture();
        let registry = TargetRegistry::default();
        registry.discover().unwrap();
        remove_marker(raw);
        let (unmarked, reason) = native::identity(raw).unwrap();
        assert!(reason.is_none());
        assert_eq!(unmarked.window_instance, 0);
        registry
            .0
            .lock()
            .unwrap()
            .insert("unmarked".to_owned(), unmarked.clone());
        assert!(revalidate(&unmarked).is_err());
        assert!(registry.resolve("unmarked").is_err());
    }

    #[test]
    #[ignore = "requires a non-elevated interactive Windows desktop; run separately"]
    fn pruning_stale_metadata_preserves_the_current_window_marker() {
        let (_fixture, raw) = fixture();
        let registry = TargetRegistry::default();
        registry.discover().unwrap();
        let target_id = registry
            .0
            .lock()
            .unwrap()
            .iter()
            .find(|(_, identity)| identity.hwnd == raw)
            .map(|(id, _)| id.clone())
            .unwrap();
        let selected = registry.resolve(&target_id).unwrap();
        {
            let mut entries = registry.0.lock().unwrap();
            for index in 0..2049 {
                let mut stale = selected.clone();
                stale.dpi += 1;
                entries.insert(format!("stale-{index}"), stale);
            }
        }
        registry.discover().unwrap();
        assert_eq!(registry.resolve(&target_id).unwrap(), selected);
        assert!(registry.0.lock().unwrap().len() <= 2048);
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    };
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
                    EnumWindows, GW_OWNER, GetPropW, GetWindow, GetWindowTextW,
                    GetWindowThreadProcessId, IsWindow, IsWindowVisible, RemovePropW, SetPropW,
                },
            },
        },
        core::{BOOL, PCWSTR, PWSTR},
    };
    fn instance_property() -> PCWSTR {
        static NAME: OnceLock<Vec<u16>> = OnceLock::new();
        PCWSTR(
            NAME.get_or_init(|| {
                format!(
                    "Lumen.ComputerUse.WindowIdentity.{}\0",
                    uuid::Uuid::new_v4()
                )
                .encode_utf16()
                .collect()
            })
            .as_ptr(),
        )
    }
    fn tag(identity: &mut WindowIdentity) -> Result<(), String> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        if identity.window_instance == 0 {
            let instance = NEXT.fetch_add(1, Ordering::Relaxed);
            unsafe {
                SetPropW(
                    HWND(identity.hwnd as usize as *mut _),
                    instance_property(),
                    Some(HANDLE(instance as usize as *mut _)),
                )
                .map_err(|_| "window_identity_unavailable")?;
            }
            identity.window_instance = instance;
            let (now, reason) = self::identity(identity.hwnd)?;
            if reason.is_some() || now != *identity {
                forget(identity);
                return Err("target_changed: select the window again".to_owned());
            }
        }
        Ok(())
    }
    pub fn forget(identity: &WindowIdentity) {
        unsafe {
            let hwnd = HWND(identity.hwnd as usize as *mut _);
            if identity.window_instance != 0
                && GetPropW(hwnd, instance_property()).0 as usize as u64 == identity.window_instance
            {
                let _ = RemovePropW(hwnd, instance_property());
            }
        }
    }
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
                    window_instance: GetPropW(hwnd, instance_property()).0 as usize as u64,
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
        if let Ok((mut identity, mut reason)) = identity(hwnd.0 as usize as u64) {
            let mut name = [0u16; 512];
            let length = unsafe { GetWindowTextW(hwnd, &mut name) };
            if length > 0 {
                if reason.is_none()
                    && let Err(error) = tag(&mut identity)
                {
                    reason = Some(error);
                }
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
    pub fn forget(_: &WindowIdentity) {}
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
