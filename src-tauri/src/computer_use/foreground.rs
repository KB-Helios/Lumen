use super::{
    gate::InputGate,
    protocol::*,
    windows::{WindowIdentity, revalidate},
};
use std::sync::Mutex;

/// This ledger records only successful Lumen key/button downs. It is held for
/// one SendInput call, never across worker/provider IO or an action duration.
#[derive(Default)]
pub struct OwnedInputs(Mutex<Ledger>);
#[derive(Default)]
struct Ledger {
    keys: Vec<OwnedKey>,
    buttons: Vec<u32>,
}
#[derive(Debug, PartialEq)]
struct OwnedKey {
    key: u16,
    scan: u16,
    unicode: bool,
}
impl Ledger {
    fn unicode_pair(&mut self, unit: u16, delivered: u32) -> Result<(), String> {
        if delivered == 1 {
            self.keys.push(OwnedKey {
                key: 0,
                scan: unit,
                unicode: true,
            });
        }
        if delivered == 2 {
            Ok(())
        } else {
            Err("foreground_input_uncertain".to_owned())
        }
    }
}
impl OwnedInputs {
    fn admitted<T>(
        &self,
        gate: &InputGate,
        generation: u64,
        commit: impl FnOnce(&mut Ledger) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut ledger = self.0.lock().map_err(|_| "input_ledger_unavailable")?;
        if !gate.is_open(generation) {
            return Err("stopped".to_owned());
        }
        commit(&mut ledger)
    }
    pub fn release(&self) {
        #[cfg(windows)]
        if let Ok(mut ledger) = self.0.lock() {
            native::release(&mut ledger);
        }
    }
    pub fn execute(
        &self,
        target: &WindowIdentity,
        gate: &InputGate,
        generation: u64,
        action: &Action,
        observation: &Observation,
    ) -> Result<ActionResult, String> {
        #[cfg(windows)]
        {
            let result = revalidate(target).and_then(|()| {
                native::execute(self, target, gate, generation, action, observation)
            });
            self.release();
            result
        }
        #[cfg(not(windows))]
        {
            let _ = (target, gate, generation, action, observation);
            Err("foreground_unavailable".to_owned())
        }
    }
}
impl Drop for OwnedInputs {
    fn drop(&mut self) {
        self.release();
    }
}
pub fn supported(action: &Action) -> bool {
    matches!(
        action.kind,
        ActionKind::Keypress
            | ActionKind::Type
            | ActionKind::Click
            | ActionKind::DoubleClick
            | ActionKind::RightClick
            | ActionKind::Invoke
            | ActionKind::SetValue
    )
}
fn action_point(action: &Action, observation: &Observation) -> Result<Option<(f64, f64)>, String> {
    let point = match action.kind {
        ActionKind::Click | ActionKind::DoubleClick | ActionKind::RightClick => (
            action.x.ok_or("invalid_coordinates")?,
            action.y.ok_or("invalid_coordinates")?,
        ),
        ActionKind::Invoke | ActionKind::SetValue => {
            let bounds = observation
                .elements
                .iter()
                .find(|e| Some(&e.reference) == action.element.as_ref())
                .and_then(|e| e.bounds.as_ref())
                .ok_or("foreground_element_unavailable")?;
            if ![bounds.x, bounds.y, bounds.width, bounds.height]
                .iter()
                .all(|v| v.is_finite())
                || bounds.width <= 0.0
                || bounds.height <= 0.0
                || bounds.x < 0.0
                || bounds.y < 0.0
                || bounds.x + bounds.width > observation.width
                || bounds.y + bounds.height > observation.height
            {
                return Err("foreground_element_unavailable".to_owned());
            }
            (
                bounds.x + bounds.width / 2.0,
                bounds.y + bounds.height / 2.0,
            )
        }
        _ => return Ok(None),
    };
    if !point.0.is_finite()
        || !point.1.is_finite()
        || point.0 < 0.0
        || point.1 < 0.0
        || point.0 >= observation.width
        || point.1 >= observation.height
    {
        return Err("invalid_coordinates".to_owned());
    }
    Ok(Some(point))
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        UI::{
            Input::KeyboardAndMouse::*,
            WindowsAndMessaging::{
                GA_ROOT, GetAncestor, GetForegroundWindow, GetSystemMetrics, GetWindowRect,
                SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
                SetForegroundWindow, WindowFromPoint,
            },
        },
    };
    fn keyboard(key: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(key),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
    fn mouse(x: i32, y: i32, flags: MOUSE_EVENT_FLAGS, data: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: x,
                    dy: y,
                    mouseData: data,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
    fn send(input: INPUT) -> Result<(), String> {
        if unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) } == 1 {
            Ok(())
        } else {
            Err("foreground_input_uncertain".to_owned())
        }
    }
    pub fn release(ledger: &mut Ledger) {
        for key in std::mem::take(&mut ledger.keys).into_iter().rev() {
            let flags = if key.unicode {
                KEYEVENTF_KEYUP | KEYEVENTF_UNICODE
            } else {
                KEYEVENTF_KEYUP
            };
            if send(keyboard(key.key, key.scan, flags)).is_err() {
                ledger.keys.push(key);
            }
        }
        for up in std::mem::take(&mut ledger.buttons).into_iter().rev() {
            if send(mouse(0, 0, MOUSE_EVENT_FLAGS(up), 0)).is_err() {
                ledger.buttons.push(up);
            }
        }
    }
    fn guard(target: &WindowIdentity, gate: &InputGate, generation: u64) -> Result<(), String> {
        if !gate.is_open(generation) {
            return Err("stopped".to_owned());
        }
        if unsafe { GetForegroundWindow() }.0 as usize as u64 != target.hwnd
            || !super::super::windows::interactive()
        {
            return Err("foreground_changed".to_owned());
        }
        Ok(())
    }
    fn key(key: &str) -> Option<u16> {
        Some(match key {
            "Control" | "Ctrl" => VK_CONTROL.0,
            "Alt" => VK_MENU.0,
            "Shift" => VK_SHIFT.0,
            "Enter" => VK_RETURN.0,
            "Tab" => VK_TAB.0,
            "Escape" => VK_ESCAPE.0,
            "Backspace" => VK_BACK.0,
            "Delete" => VK_DELETE.0,
            "ArrowUp" => VK_UP.0,
            "ArrowDown" => VK_DOWN.0,
            "ArrowLeft" => VK_LEFT.0,
            "ArrowRight" => VK_RIGHT.0,
            "Home" => VK_HOME.0,
            "End" => VK_END.0,
            "PageUp" => VK_PRIOR.0,
            "PageDown" => VK_NEXT.0,
            "Space" => VK_SPACE.0,
            k if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) => {
                k.as_bytes()[0].to_ascii_uppercase() as u16
            }
            k if k.starts_with('F') => VK_F1.0 + k[1..].parse::<u16>().ok()?.checked_sub(1)?,
            _ => return None,
        })
    }
    fn chord(
        inputs: &OwnedInputs,
        target: &WindowIdentity,
        gate: &InputGate,
        generation: u64,
        keys: &[u16],
    ) -> Result<(), String> {
        for key in keys {
            let mut ledger = inputs.0.lock().map_err(|_| "input_ledger_unavailable")?;
            guard(target, gate, generation)?;
            if unsafe { GetAsyncKeyState(*key as i32) } < 0 {
                release(&mut ledger);
                return Err("user_input_active".to_owned());
            }
            send(keyboard(*key, 0, KEYBD_EVENT_FLAGS(0)))?;
            ledger.keys.push(OwnedKey {
                key: *key,
                scan: 0,
                unicode: false,
            });
        }
        // Release always, including after Stop or foreground loss.
        if let Ok(mut ledger) = inputs.0.lock() {
            release(&mut ledger);
        }
        Ok(())
    }
    fn text(
        inputs: &OwnedInputs,
        target: &WindowIdentity,
        gate: &InputGate,
        generation: u64,
        value: &str,
    ) -> Result<(), String> {
        for unit in value.encode_utf16() {
            let mut ledger = inputs.0.lock().map_err(|_| "input_ledger_unavailable")?;
            guard(target, gate, generation)?;
            let pair = [
                keyboard(0, unit, KEYEVENTF_UNICODE),
                keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            ];
            let delivered = unsafe { SendInput(&pair, std::mem::size_of::<INPUT>() as i32) };
            ledger.unicode_pair(unit, delivered)?;
        }
        Ok(())
    }
    fn pixel_point(
        target: &WindowIdentity,
        observation: &Observation,
        x: f64,
        y: f64,
    ) -> Result<(POINT, i32, i32), String> {
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(HWND(target.hwnd as usize as *mut _), &mut rect)
                .map_err(|_| "target_geometry_unavailable")?;
        }
        if observation.screenshot.is_none()
            || (rect.right - rect.left) as f64 != observation.width
            || (rect.bottom - rect.top) as f64 != observation.height
            || !x.is_finite()
            || !y.is_finite()
            || x < 0.0
            || y < 0.0
            || x >= observation.width
            || y >= observation.height
        {
            return Err("pixel_geometry_unavailable".to_owned());
        }
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if width <= 1 || height <= 1 {
            return Err("pixel_geometry_unavailable".to_owned());
        }
        let point = POINT {
            x: rect.left + x.floor() as i32,
            y: rect.top + y.floor() as i32,
        };
        if point.x < left || point.y < top || point.x >= left + width || point.y >= top + height {
            return Err("pixel_geometry_unavailable".to_owned());
        }
        let dx = ((point.x - left) as f64 * 65535.0 / (width - 1) as f64).round() as i32;
        let dy = ((point.y - top) as f64 * 65535.0 / (height - 1) as f64).round() as i32;
        Ok((point, dx, dy))
    }
    pub(super) fn recipient_matches(target: u64, point: POINT) -> bool {
        let hit = unsafe { WindowFromPoint(point) };
        !hit.is_invalid() && unsafe { GetAncestor(hit, GA_ROOT) }.0 as usize as u64 == target
    }
    fn click(
        inputs: &OwnedInputs,
        target: &WindowIdentity,
        gate: &InputGate,
        generation: u64,
        observation: &Observation,
        coordinates: (f64, f64),
        kind: ActionKind,
    ) -> Result<(), String> {
        let (x, y) = coordinates;
        let right = kind == ActionKind::RightClick;
        let count = if kind == ActionKind::DoubleClick {
            2
        } else {
            1
        };
        let (down, up) = if right {
            (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        } else {
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
        };
        for _ in 0..count {
            inputs.admitted(gate, generation, |ledger| {
                guard(target, gate, generation)?;
                let (point, dx, dy) = pixel_point(target, observation, x, y)?;
                if !recipient_matches(target.hwnd, point) {
                    return Err("foreground_point_occluded".to_owned());
                }
                if unsafe {
                    GetAsyncKeyState(if right { VK_RBUTTON.0 } else { VK_LBUTTON.0 } as i32)
                } < 0
                {
                    return Err("user_input_active".to_owned());
                }
                let batch = [
                    mouse(
                        dx,
                        dy,
                        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                        0,
                    ),
                    mouse(0, 0, down, 0),
                    mouse(0, 0, up, 0),
                ];
                let delivered = unsafe { SendInput(&batch, std::mem::size_of::<INPUT>() as i32) };
                if delivered == 2 {
                    ledger.buttons.push(up.0);
                }
                release(ledger);
                if delivered == 3 {
                    Ok(())
                } else {
                    Err("foreground_input_uncertain".to_owned())
                }
            })?;
        }
        Ok(())
    }
    pub fn execute(
        inputs: &OwnedInputs,
        target: &WindowIdentity,
        gate: &InputGate,
        generation: u64,
        action: &Action,
        observation: &Observation,
    ) -> Result<ActionResult, String> {
        if !gate.is_open(generation) {
            return Err("stopped".to_owned());
        }
        if !supported(action) {
            return Err("foreground_gesture_unavailable".to_owned());
        }
        if let Some((x, y)) = action_point(action, observation)? {
            pixel_point(target, observation, x, y)?;
        }
        inputs.admitted(gate, generation, |_| {
            if !super::super::windows::interactive() {
                return Err("foreground_unavailable".to_owned());
            }
            unsafe {
                let _ = SetForegroundWindow(HWND(target.hwnd as usize as *mut _));
            }
            guard(target, gate, generation)
        })?;
        match action.kind {
            ActionKind::Keypress => {
                let keys = action
                    .keys
                    .as_ref()
                    .ok_or("invalid_keys")?
                    .iter()
                    .map(|k| key(k).ok_or("invalid_keys"))
                    .collect::<Result<Vec<_>, _>>()?;
                chord(inputs, target, gate, generation, &keys)?;
            }
            ActionKind::Type => text(
                inputs,
                target,
                gate,
                generation,
                action.text.as_deref().ok_or("invalid_text")?,
            )?,
            ActionKind::Click | ActionKind::DoubleClick | ActionKind::RightClick => click(
                inputs,
                target,
                gate,
                generation,
                observation,
                (
                    action.x.ok_or("invalid_coordinates")?,
                    action.y.ok_or("invalid_coordinates")?,
                ),
                action.kind,
            )?,
            ActionKind::Invoke | ActionKind::SetValue => {
                let element = observation
                    .elements
                    .iter()
                    .find(|e| Some(&e.reference) == action.element.as_ref())
                    .ok_or("stale_snapshot")?;
                let bounds = element
                    .bounds
                    .as_ref()
                    .ok_or("foreground_element_unavailable")?;
                click(
                    inputs,
                    target,
                    gate,
                    generation,
                    observation,
                    (
                        bounds.x + bounds.width / 2.0,
                        bounds.y + bounds.height / 2.0,
                    ),
                    ActionKind::Click,
                )?;
                if action.kind == ActionKind::SetValue {
                    chord(
                        inputs,
                        target,
                        gate,
                        generation,
                        &[VK_CONTROL.0, b'A' as u16],
                    )?;
                    text(
                        inputs,
                        target,
                        gate,
                        generation,
                        action.text.as_deref().ok_or("invalid_text")?,
                    )?;
                }
            }
            _ => return Err("foreground_gesture_unavailable".to_owned()),
        }
        Ok(ActionResult {
            effect: Effect::Unverifiable,
            route: Route::Foreground,
            verified: false,
            detail: Some("Native delivery requires independent state verification".to_owned()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stopped_admission_cannot_change_focus_or_send_input() {
        let inputs = OwnedInputs::default();
        let gate = InputGate::new();
        gate.close();
        let changed = std::cell::Cell::new(false);
        assert!(
            inputs
                .admitted(&gate, 1, |_| {
                    changed.set(true);
                    Ok(())
                })
                .is_err()
        );
        assert!(!changed.get());
    }
    #[test]
    fn semantic_foreground_bounds_cannot_escape_the_selected_capture() {
        let mut state: Observation = serde_json::from_value(serde_json::json!({"snapshotId":"s","title":"Fixture","elements":[{"ref":"r","role":"button","name":"Owned","enabled":true,"actions":["invoke"],"bounds":{"x":10,"y":20,"width":50,"height":40}}],"width":800,"height":600})).unwrap();
        let action: Action =
            serde_json::from_value(serde_json::json!({"kind":"invoke","element":"r"})).unwrap();
        assert_eq!(action_point(&action, &state).unwrap(), Some((35.0, 40.0)));
        state.elements[0].bounds.as_mut().unwrap().x = -1.0;
        assert!(action_point(&action, &state).is_err());
        state.elements[0].bounds.as_mut().unwrap().x = 790.0;
        assert!(action_point(&action, &state).is_err());
    }
    #[test]
    #[cfg(windows)]
    fn actual_window_hit_test_rejects_an_occluding_owned_fixture() {
        use windows::{
            Win32::{Foundation::POINT, UI::WindowsAndMessaging::*},
            core::w,
        };
        unsafe {
            let style = WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
            // A visible style does not establish that a new fixture is the
            // current hit-test recipient. Place only our owned window and wait
            // for that bounded readiness condition without activating it.
            let ready = |hwnd: windows::Win32::Foundation::HWND, point: POINT| {
                SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                )
                .unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
                loop {
                    if native::recipient_matches(hwnd.0 as usize as u64, point) {
                        return true;
                    }
                    if std::time::Instant::now() >= deadline {
                        return false;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            };
            let target = CreateWindowExW(
                style,
                w!("Button"),
                w!("Lumen owned hit-test target"),
                WS_POPUP | WS_VISIBLE,
                20,
                20,
                80,
                80,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let point = POINT { x: 40, y: 40 };
            let exposed = ready(target, point);
            let overlay = CreateWindowExW(
                style,
                w!("Button"),
                w!("Lumen owned occluder"),
                WS_POPUP | WS_VISIBLE,
                20,
                20,
                80,
                80,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let recipient = ready(overlay, point);
            let occluded = native::recipient_matches(target.0 as usize as u64, point);
            DestroyWindow(overlay).unwrap();
            DestroyWindow(target).unwrap();
            assert!(exposed);
            assert!(!occluded);
            assert!(recipient);
        }
    }
    #[test]
    fn a_partial_unicode_pair_keeps_only_the_lumen_down_for_stop_cleanup() {
        let mut ledger = Ledger::default();
        assert!(ledger.unicode_pair(0x00e5, 1).is_err());
        assert_eq!(
            ledger.keys,
            [OwnedKey {
                key: 0,
                scan: 0x00e5,
                unicode: true
            }]
        );
        let mut none = Ledger::default();
        assert!(none.unicode_pair(0x00e5, 0).is_err());
        assert!(none.keys.is_empty());
        assert!(none.unicode_pair(0x00e5, 2).is_ok());
        assert!(none.keys.is_empty());
    }
}
