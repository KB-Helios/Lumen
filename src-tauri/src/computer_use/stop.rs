use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub struct NativeStop {
    available: Arc<AtomicBool>,
    #[cfg(windows)]
    thread_id: u32,
}
impl NativeStop {
    pub fn register(callback: impl Fn() + Send + 'static) -> Self {
        let available = Arc::new(AtomicBool::new(false));
        #[cfg(windows)]
        {
            use windows::Win32::{
                System::Threading::GetCurrentThreadId,
                UI::{
                    Input::KeyboardAndMouse::{
                        MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, RegisterHotKey, UnregisterHotKey,
                        VK_ESCAPE,
                    },
                    WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY},
                },
            };
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let state = Arc::clone(&available);
            std::thread::spawn(move || unsafe {
                let id = GetCurrentThreadId();
                let ok = RegisterHotKey(
                    None,
                    0x4c55,
                    MOD_ALT | MOD_CONTROL | MOD_NOREPEAT,
                    VK_ESCAPE.0 as u32,
                )
                .is_ok();
                state.store(ok, Ordering::Release);
                let _ = sender.send(id);
                if !ok {
                    return;
                }
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                    if message.message == WM_HOTKEY && message.wParam.0 == 0x4c55 {
                        callback();
                    }
                }
                state.store(false, Ordering::Release);
                let _ = UnregisterHotKey(None, 0x4c55);
            });
            Self {
                available,
                thread_id: receiver
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap_or(0),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = callback;
            Self { available }
        }
    }
    pub fn available(&self) -> bool {
        self.available.load(Ordering::Acquire)
    }
}
impl Drop for NativeStop {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.thread_id != 0 {
            unsafe {
                let _ = windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                    self.thread_id,
                    windows::Win32::UI::WindowsAndMessaging::WM_QUIT,
                    windows::Win32::Foundation::WPARAM(0),
                    windows::Win32::Foundation::LPARAM(0),
                );
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn native_message_thread_handles_stop_without_a_worker_or_ui_loop() {
        use windows::Win32::{
            Foundation::{LPARAM, WPARAM},
            UI::WindowsAndMessaging::{PostThreadMessageW, WM_HOTKEY},
        };
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let stop = NativeStop::register(move || {
            let _ = sender.send(());
        });
        assert!(
            stop.available(),
            "Ctrl+Alt+Esc registration is unavailable on this machine"
        );
        unsafe {
            PostThreadMessageW(stop.thread_id, WM_HOTKEY, WPARAM(0x4c55), LPARAM(0)).unwrap();
        }
        receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
    }
}
