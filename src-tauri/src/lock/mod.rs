//! App lock (NFR-SEC-04): commands, the once-a-second watch, and telling the
//! window and the page when the lock changes.

pub mod state;
pub mod watch;
mod win;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::error::{AppError, AppResult};
use state::{AppLock, Change, ChangeOutcome, Check, HelloOutcome, Mode, Reason, Status};
use watch::{Tick, Watch};
use win::{Notice, WinHello};

const MAIN: &str = "main";

fn now() -> Duration {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()
}

/// Minimized or hidden in the tray.
fn out_of_sight(window: &WebviewWindow) -> bool {
    !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false)
}

/// Brings the window's protections up to date and tells the page. Every change of
/// the lock goes through here.
fn announce(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let status = handle.state::<AppLock>().status();
        if let Some(window) = handle.get_webview_window(MAIN) {
            win::shield(&window, status.locked);
            if !status.locked {
                win::cover(&window, false);
            } else if out_of_sight(&window)
                || status.away
                || matches!(status.reason, Some(Reason::Session | Reason::Sleep))
            {
                // The page can't paint now: its old picture must not show on the way back.
                win::cover(&window, true);
            }
        }
        let _ = handle.emit("lock-changed", status);
    });
}

fn lock_for(app: &AppHandle, reason: Reason) {
    if app.state::<AppLock>().lock(reason) {
        announce(app);
    }
}

/// Runs inside the window's message handler: the state changes at once, the
/// window work is done from another thread.
fn on_notice(app: &AppHandle, notice: Notice) {
    let lock = app.state::<AppLock>();
    let changed = match notice {
        Notice::Away => {
            let away = lock.set_away(true);
            lock.lock(Reason::Session) || away
        }
        Notice::Back => lock.set_away(false),
        Notice::Sleep => lock.suspend(now()),
        Notice::Wake => lock.resume(),
    };
    if changed {
        let app = app.clone();
        std::thread::spawn(move || announce(&app));
    }
}

fn watch_loop(app: AppHandle) {
    let mut watch = Watch::default();
    let mut was_locked = true;
    let mut unlocked_at = now();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let Some(window) = app.get_webview_window(MAIN) else { continue };
        let at = now();
        let (locked, limit, woke) = {
            let lock = app.state::<AppLock>();
            let woke = lock.wake_if_running(at);
            (lock.status().locked, lock.idle_limit(), woke)
        };
        if was_locked && !locked {
            unlocked_at = at;
        }
        was_locked = locked;
        // Opened by a face, without touching anything: idle time counts from the opening.
        let idle = win::idle_time().min(at.saturating_sub(unlocked_at));
        let hidden = out_of_sight(&window);
        // In sight again, maybe without the focus: the page is told once more, so it
        // says it has painted and the cover comes off.
        let back = watch.came_back(hidden) && locked;
        if let Some(reason) = watch.tick(Tick { now: at, idle, hidden }, limit) {
            lock_for(&app, reason);
        }
        if back || woke {
            announce(&app);
        }
    }
}

/// Loads the settings and starts watching. Call on the main thread before the window shows.
pub fn start(app: &tauri::App, config_dir: &Path) {
    app.manage(AppLock::load(config_dir));
    if let Some(window) = app.get_webview_window(MAIN) {
        win::watch_window(app.handle(), &window, on_notice);
        if app.state::<AppLock>().status().locked {
            win::shield(&window, true);
            win::cover(&window, true);
        }
    }
    let handle = app.handle().clone();
    std::thread::spawn(move || watch_loop(handle));
}

fn hello_for(app: &AppHandle) -> WinHello {
    WinHello { hwnd: app.get_webview_window(MAIN).map(|w| win::hwnd_of(&w)).unwrap_or(0) }
}

fn joined<T>(r: Result<T, tauri::Error>) -> AppResult<T> {
    r.map_err(|e| AppError::System(e.to_string()))
}

// ---------- commands ----------

#[tauri::command]
pub fn lock_status(lock: State<AppLock>) -> Status {
    lock.status()
}

#[tauri::command]
pub fn lock_now(app: AppHandle) {
    lock_for(&app, Reason::Manual);
}

/// 0 right, -1 wrong, n > 0: wait n seconds.
#[tauri::command]
pub fn lock_unlock_password(app: AppHandle, password: String) -> i64 {
    match app.state::<AppLock>().unlock_password(&password, now().as_secs()) {
        Check::Ok => {
            announce(&app);
            0
        }
        Check::Wrong => -1,
        Check::Wait(seconds) => i64::from(seconds),
    }
}

#[tauri::command]
pub async fn lock_unlock_hello(app: AppHandle, message: String) -> AppResult<HelloOutcome> {
    let task = tauri::async_runtime::spawn_blocking(move || {
        let lock = app.state::<AppLock>();
        let status = lock.status();
        if !status.locked || status.mode != Mode::Hello {
            return HelloOutcome::Failed;
        }
        let outcome = lock.unlock_hello(state::Hello::verify(&hello_for(&app), &message));
        if outcome == HelloOutcome::Ok {
            announce(&app);
        }
        outcome
    });
    joined(task.await)
}

#[tauri::command]
pub async fn lock_change(
    app: AppHandle,
    change: Change,
    proof: Option<String>,
    message: String,
) -> AppResult<ChangeOutcome> {
    let task = tauri::async_runtime::spawn_blocking(move || {
        let lock = app.state::<AppLock>();
        let outcome = lock.change(change, proof.as_deref(), &message, &hello_for(&app), now().as_secs())?;
        if outcome == ChangeOutcome::Ok {
            announce(&app);
        }
        Ok(outcome)
    });
    joined(task.await)?
}

/// The page has painted the lock screen. Only taken when it could really be seen.
#[tauri::command]
pub fn lock_painted(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let away = handle.state::<AppLock>().status().away;
        if let Some(window) = handle.get_webview_window(MAIN)
            && !away
            && !out_of_sight(&window)
        {
            win::cover(&window, false);
        }
    });
}
