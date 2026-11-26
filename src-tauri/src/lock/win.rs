//! The Windows side of the app lock (NFR-SEC-04): Windows Hello, time without
//! input, session lock and sleep notices, and hiding the window's old picture.
//!
//! `watch_window`, `shield` and `cover` must run on the window's own thread.

use std::time::Duration;

use tauri::{AppHandle, WebviewWindow};

use super::state::{Hello, HelloOutcome};

/// Windows Hello asked over the app window.
pub struct WinHello {
    pub hwnd: isize,
}

/// What Windows told us about the session.
#[derive(Debug, Clone, Copy)]
pub enum Notice {
    /// The session was locked or disconnected.
    Away,
    /// It is in use again.
    Back,
    Sleep,
    Wake,
}

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Dwm::{
        DWMWA_FORCE_ICONIC_REPRESENTATION, DWMWA_HAS_ICONIC_BITMAP, DWMWA_TRANSITIONS_FORCEDISABLED,
        DwmSetWindowAttribute,
    };
    use windows::Win32::System::RemoteDesktop::{NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification};
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, HWND_TOP, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
        SWP_NOACTIVATE, SetWindowPos, WINDOW_EX_STYLE, WINDOW_STYLE, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WS_CHILD,
        WS_CLIPSIBLINGS, WS_VISIBLE, WTS_CONSOLE_CONNECT, WTS_CONSOLE_DISCONNECT, WTS_REMOTE_CONNECT,
        WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
    };
    use windows::core::{BOOL, HSTRING, factory, w};
    use windows_future::IAsyncOperation;

    use super::*;

    const SUBCLASS_ID: usize = 0x4E56;
    /// STATIC control styles: a rectangle filled with the window frame color (black) or the window color.
    const SS_BLACKRECT: u32 = 0x4;
    const SS_WHITERECT: u32 = 0x6;
    /// Larger than any screen: the parent clips it, so it never needs resizing.
    const COVER_SIZE: i32 = 32_000;

    static ASKING: AtomicBool = AtomicBool::new(false);
    /// The native cover over the web view, or 0.
    static COVER: AtomicIsize = AtomicIsize::new(0);
    static NOTIFY: OnceLock<Box<dyn Fn(Notice) + Send + Sync>> = OnceLock::new();

    fn handle(raw: isize) -> HWND {
        HWND(raw as *mut core::ffi::c_void)
    }

    pub fn verify(hwnd: isize, message: &str) -> HelloOutcome {
        // One prompt at a time.
        if ASKING.swap(true, Ordering::SeqCst) {
            return HelloOutcome::Cancelled;
        }
        let outcome = ask(hwnd, message).unwrap_or(HelloOutcome::Failed);
        ASKING.store(false, Ordering::SeqCst);
        outcome
    }

    fn ask(hwnd: isize, message: &str) -> windows::core::Result<HelloOutcome> {
        if UserConsentVerifier::CheckAvailabilityAsync()?.join()? != UserConsentVerifierAvailability::Available {
            return Ok(HelloOutcome::Unavailable);
        }
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
        // SAFETY: the window handle is the app's own live window.
        let asked: IAsyncOperation<UserConsentVerificationResult> =
            unsafe { interop.RequestVerificationForWindowAsync(handle(hwnd), &HSTRING::from(message))? };
        Ok(match asked.join()? {
            UserConsentVerificationResult::Verified => HelloOutcome::Ok,
            UserConsentVerificationResult::Canceled => HelloOutcome::Cancelled,
            UserConsentVerificationResult::DeviceNotPresent
            | UserConsentVerificationResult::NotConfiguredForUser
            | UserConsentVerificationResult::DisabledByPolicy => HelloOutcome::Unavailable,
            _ => HelloOutcome::Failed,
        })
    }

    pub fn idle_time() -> Duration {
        let mut last = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: `last` is a valid struct with its size set.
        unsafe {
            if !GetLastInputInfo(&mut last).as_bool() {
                return Duration::ZERO;
            }
            // Both count milliseconds since start-up and wrap around together.
            Duration::from_millis(u64::from(GetTickCount().wrapping_sub(last.dwTime)))
        }
    }

    unsafe extern "system" fn on_message(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        let code = wparam.0 as u32;
        let notice = match msg {
            WM_WTSSESSION_CHANGE
                if [WTS_SESSION_LOCK, WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT].contains(&code) =>
            {
                Some(Notice::Away)
            }
            WM_WTSSESSION_CHANGE if [WTS_SESSION_UNLOCK, WTS_CONSOLE_CONNECT, WTS_REMOTE_CONNECT].contains(&code) => {
                Some(Notice::Back)
            }
            WM_POWERBROADCAST if code == PBT_APMSUSPEND => Some(Notice::Sleep),
            WM_POWERBROADCAST if code == PBT_APMRESUMEAUTOMATIC || code == PBT_APMRESUMESUSPEND => Some(Notice::Wake),
            _ => None,
        };
        if let (Some(notice), Some(notify)) = (notice, NOTIFY.get()) {
            notify(notice);
        }
        // SAFETY: passes the message on, as every subclass must.
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    pub fn watch(hwnd: isize, notify: Box<dyn Fn(Notice) + Send + Sync>) {
        if NOTIFY.set(notify).is_err() {
            return;
        }
        // SAFETY: called on the window's thread with its live handle.
        unsafe {
            if !SetWindowSubclass(handle(hwnd), Some(on_message), SUBCLASS_ID, 0).as_bool() {
                eprintln!("app lock: window messages not watched");
            }
            if let Err(e) = WTSRegisterSessionNotification(handle(hwnd), NOTIFY_FOR_THIS_SESSION) {
                eprintln!("app lock: session lock not watched: {e}");
            }
        }
    }

    pub fn shield(hwnd: isize, on: bool) {
        let value = BOOL::from(on);
        for attribute in [DWMWA_FORCE_ICONIC_REPRESENTATION, DWMWA_HAS_ICONIC_BITMAP, DWMWA_TRANSITIONS_FORCEDISABLED] {
            // SAFETY: `value` is a BOOL that lives through the call.
            let r = unsafe {
                DwmSetWindowAttribute(handle(hwnd), attribute, (&raw const value).cast(), size_of::<BOOL>() as u32)
            };
            if let Err(e) = r {
                eprintln!("app lock: window preview setting failed: {e}");
            }
        }
    }

    pub fn cover(hwnd: isize, on: bool, dark: bool) {
        let current = COVER.load(Ordering::SeqCst);
        // SAFETY: created, raised and destroyed on the window's thread only.
        unsafe {
            if !on {
                if current != 0 {
                    COVER.store(0, Ordering::SeqCst);
                    let _ = DestroyWindow(handle(current));
                }
                return;
            }
            let cover = if current != 0 {
                handle(current)
            } else {
                let fill = if dark { SS_BLACKRECT } else { SS_WHITERECT };
                let style = WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WINDOW_STYLE(fill);
                let made = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    None,
                    style,
                    0,
                    0,
                    COVER_SIZE,
                    COVER_SIZE,
                    Some(handle(hwnd)),
                    None,
                    None,
                    None,
                );
                match made {
                    Ok(made) => {
                        COVER.store(made.0 as isize, Ordering::SeqCst);
                        made
                    }
                    Err(e) => return eprintln!("app lock: window not covered: {e}"),
                }
            };
            let _ = SetWindowPos(cover, Some(HWND_TOP), 0, 0, COVER_SIZE, COVER_SIZE, SWP_NOACTIVATE);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn verify(_hwnd: isize, _message: &str) -> HelloOutcome {
        HelloOutcome::Unavailable
    }
    pub fn idle_time() -> Duration {
        Duration::ZERO
    }
    pub fn watch(_hwnd: isize, _notify: Box<dyn Fn(Notice) + Send + Sync>) {}
    pub fn shield(_hwnd: isize, _on: bool) {}
    pub fn cover(_hwnd: isize, _on: bool, _dark: bool) {}
}

/// The window's native handle, or 0.
pub fn hwnd_of(window: &WebviewWindow) -> isize {
    #[cfg(windows)]
    {
        window.hwnd().map(|h| h.0 as isize).unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        0
    }
}

impl Hello for WinHello {
    fn verify(&self, message: &str) -> HelloOutcome {
        imp::verify(self.hwnd, message)
    }
}

pub fn idle_time() -> Duration {
    imp::idle_time()
}

/// Calls `notify` (on the window's thread) when the session locks, returns or the PC sleeps.
pub fn watch_window(app: &AppHandle, window: &WebviewWindow, notify: fn(&AppHandle, Notice)) {
    let app = app.clone();
    imp::watch(hwnd_of(window), Box::new(move |notice| notify(&app, notice)));
}

/// While on, the taskbar and Alt+Tab show no picture of the window, and it restores without animation.
pub fn shield(window: &WebviewWindow, on: bool) {
    imp::shield(hwnd_of(window), on);
}

/// A plain native cover over the whole window. A web view that was out of sight
/// shows its old picture for a moment when it comes back; this is in front of it
/// until the page says it has painted the lock screen.
pub fn cover(window: &WebviewWindow, on: bool) {
    let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
    imp::cover(hwnd_of(window), on, dark);
}
