//! App lock (NFR-SEC-04): whether the app is locked, how it is opened, and the
//! settings file `app-lock.json` in the app config dir.
//!
//! It keeps someone at an unattended PC from reading the notes on screen. It does
//! not encrypt anything: whoever can delete this file can turn the lock off.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const FILE: &str = "app-lock.json";
const MIN_CHARS: usize = 4;
const MAX_FAILS: u32 = 5;
const WAIT_SECS: u64 = 30;
/// Minutes without input before locking; 0 = never.
const IDLE_CHOICES: [u32; 5] = [0, 1, 5, 10, 30];
const DEFAULT_IDLE: u32 = 5;
/// Still running this long after the notice of a sleep: the PC is awake.
const AWAKE_AFTER: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Off,
    Hello,
    Password,
    /// The settings file is there but can't be understood: stays locked.
    Broken,
}

/// Why the app locked. The screen asks Windows Hello by itself only when the user is coming back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Start,
    Manual,
    Idle,
    Hidden,
    Session,
    Sleep,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub mode: Mode,
    pub locked: bool,
    pub reason: Option<Reason>,
    /// Grows with every new lock (or new way back to one).
    pub epoch: u64,
    /// Nobody can be looking: the Windows session is locked or disconnected, or the PC is going to sleep.
    pub away: bool,
    pub idle_minutes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    Ok,
    Wrong,
    /// Too many wrong tries: seconds left to wait.
    Wait(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HelloOutcome {
    Ok,
    Cancelled,
    /// This PC has no Windows Hello to ask.
    Unavailable,
    Failed,
}

/// Asks Windows Hello to check the user.
pub trait Hello {
    fn verify(&self, message: &str) -> HelloOutcome;
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Change {
    pub mode: Option<Mode>,
    /// The new password.
    pub password: Option<String>,
    pub idle_minutes: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ChangeOutcome {
    Ok,
    Wrong,
    Wait { seconds: u32 },
    Cancelled,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Config {
    mode: Mode,
    #[serde(default)]
    hash: String,
    #[serde(default = "default_idle")]
    idle_minutes: u32,
    #[serde(default)]
    fails: u32,
    /// UNIX seconds before which no password is looked at.
    #[serde(default)]
    wait_until: u64,
}

fn default_idle() -> u32 {
    DEFAULT_IDLE
}

impl Config {
    fn new(mode: Mode) -> Self {
        Self { mode, hash: String::new(), idle_minutes: DEFAULT_IDLE, fails: 0, wait_until: 0 }
    }

    /// No file means no lock; a file that can't be understood means locked.
    fn read(file: &Path) -> Self {
        let text = match fs::read_to_string(file) {
            Ok(text) => text,
            Err(e) if e.kind() == ErrorKind::NotFound => return Self::new(Mode::Off),
            Err(_) => return Self::new(Mode::Broken),
        };
        let Ok(mut c) = serde_json::from_str::<Config>(&text) else {
            return Self::new(Mode::Broken);
        };
        if c.mode == Mode::Password && !is_argon2(&c.hash) {
            return Self::new(Mode::Broken);
        }
        if !IDLE_CHOICES.contains(&c.idle_minutes) {
            c.idle_minutes = DEFAULT_IDLE;
        }
        c
    }

    /// Written whole beside the old file and renamed over it: never half a file.
    fn write(&self, file: &Path) -> AppResult<()> {
        let dir = file.parent().ok_or_else(|| AppError::System("설정 폴더를 찾을 수 없습니다".into()))?;
        fs::create_dir_all(dir)?;
        let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
        tmp.write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
        tmp.persist(file).map_err(|e| AppError::Io(e.error))?;
        Ok(())
    }
}

fn is_argon2(hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| h.hash.is_some() && h.algorithm.as_str().starts_with("argon2"))
}

fn hash_password(password: &str) -> AppResult<String> {
    let fail = |e: String| AppError::System(format!("비밀번호를 저장하지 못했습니다: {e}"));
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| fail(e.to_string()))?;
    let salt = SaltString::encode_b64(&bytes).map_err(|e| fail(e.to_string()))?;
    let hash = Argon2::default().hash_password(password.as_bytes(), &salt).map_err(|e| fail(e.to_string()))?;
    Ok(hash.to_string())
}

fn password_matches(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

struct Inner {
    config: Config,
    locked: bool,
    reason: Option<Reason>,
    epoch: u64,
    away: bool,
    /// When Windows said it is going to sleep, until it is running again.
    asleep_since: Option<Duration>,
}

pub struct AppLock {
    file: PathBuf,
    inner: Mutex<Inner>,
}

impl AppLock {
    /// A lock that is on starts locked.
    pub fn load(config_dir: &Path) -> Self {
        let file = config_dir.join(FILE);
        let config = Config::read(&file);
        let locked = config.mode != Mode::Off;
        let inner = Inner {
            config,
            locked,
            reason: locked.then_some(Reason::Start),
            epoch: u64::from(locked),
            away: false,
            asleep_since: None,
        };
        Self { file, inner: Mutex::new(inner) }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().expect("app lock poisoned")
    }

    pub fn status(&self) -> Status {
        let i = self.inner();
        Status {
            mode: i.config.mode,
            locked: i.locked,
            reason: i.reason,
            epoch: i.epoch,
            away: i.away || i.asleep_since.is_some(),
            idle_minutes: i.config.idle_minutes,
        }
    }

    /// True when something changed. A locked app only takes a new reason when the
    /// user is about to come back from it.
    pub fn lock(&self, reason: Reason) -> bool {
        let mut i = self.inner();
        if i.config.mode == Mode::Off {
            return false;
        }
        if i.locked && !matches!(reason, Reason::Hidden | Reason::Session | Reason::Sleep) {
            return false;
        }
        i.locked = true;
        i.reason = Some(reason);
        i.epoch += 1;
        true
    }

    pub fn set_away(&self, away: bool) -> bool {
        let mut i = self.inner();
        let changed = i.away != away;
        i.away = away;
        changed
    }

    /// The PC is going to sleep: locks, and counts as away until it runs again.
    /// `now`: wall clock since the UNIX epoch.
    pub fn suspend(&self, now: Duration) -> bool {
        let newly = self.inner().asleep_since.replace(now).is_none();
        self.lock(Reason::Sleep) || newly
    }

    /// Windows said the PC is awake again.
    pub fn resume(&self) -> bool {
        self.inner().asleep_since.take().is_some()
    }

    /// The same without being told: not every sleep ends with a notice.
    pub fn wake_if_running(&self, now: Duration) -> bool {
        let mut i = self.inner();
        let awake = i.asleep_since.is_some_and(|since| now.saturating_sub(since) >= AWAKE_AFTER);
        if awake {
            i.asleep_since = None;
        }
        awake
    }

    /// `now`: UNIX seconds.
    pub fn unlock_password(&self, password: &str, now: u64) -> Check {
        let mut i = self.inner();
        if i.config.mode != Mode::Password {
            return Check::Wrong;
        }
        let check = self.check(&mut i, password, now);
        if check == Check::Ok {
            i.locked = false;
            i.reason = None;
        }
        check
    }

    /// Opens the app after Windows Hello said yes, when that is how it is locked.
    pub fn unlock_hello(&self, outcome: HelloOutcome) -> HelloOutcome {
        if outcome != HelloOutcome::Ok {
            return outcome;
        }
        let mut i = self.inner();
        if i.config.mode != Mode::Hello {
            return HelloOutcome::Failed;
        }
        i.locked = false;
        i.reason = None;
        outcome
    }

    /// Checks a password, counting wrong tries; the count outlives a restart.
    fn check(&self, i: &mut Inner, password: &str, now: u64) -> Check {
        let c = &mut i.config;
        if c.wait_until > now {
            // A clock set back must not stretch the wait.
            if c.wait_until - now > WAIT_SECS {
                c.wait_until = now + WAIT_SECS;
                let _ = c.write(&self.file);
            }
            return Check::Wait((c.wait_until - now) as u32);
        }
        let ok = password_matches(&c.hash, password);
        let before = (c.fails, c.wait_until);
        if ok {
            c.fails = 0;
            c.wait_until = 0;
        } else {
            c.fails += 1;
            if c.fails >= MAX_FAILS {
                c.fails = 0;
                c.wait_until = now + WAIT_SECS;
            }
        }
        if (c.fails, c.wait_until) != before {
            // Not saved (a read-only disk): the count still holds until the app ends.
            let _ = c.write(&self.file);
        }
        if ok { Check::Ok } else { Check::Wrong }
    }

    /// Changes the settings after the current method (and Windows Hello, when it is
    /// being turned on) has checked the user. `proof`: the current password.
    pub fn change(
        &self,
        change: Change,
        proof: Option<&str>,
        message: &str,
        hello: &dyn Hello,
        now: u64,
    ) -> AppResult<ChangeOutcome> {
        let refuse = |why: &str| AppError::System(why.into());
        let (current, next) = {
            let mut i = self.inner();
            if i.locked || i.config.mode == Mode::Broken {
                return Err(refuse("잠긴 상태에서는 잠금 설정을 바꿀 수 없습니다"));
            }
            let current = i.config.mode;
            let next = change.mode.unwrap_or(current);
            if next == Mode::Broken {
                return Err(refuse("알 수 없는 잠금 방식입니다"));
            }
            if next == Mode::Password {
                match &change.password {
                    Some(p) if p.chars().count() < MIN_CHARS => return Err(refuse("4자 이상으로 정하세요")),
                    None if current != Mode::Password => return Err(refuse("새 비밀번호를 입력하세요")),
                    _ => {}
                }
            }
            if change.idle_minutes.is_some_and(|m| !IDLE_CHOICES.contains(&m)) {
                return Err(refuse("자동 잠금 시간이 올바르지 않습니다"));
            }
            if current == Mode::Password {
                let Some(proof) = proof else { return Ok(ChangeOutcome::Wrong) };
                match self.check(&mut i, proof, now) {
                    Check::Ok => {}
                    Check::Wrong => return Ok(ChangeOutcome::Wrong),
                    Check::Wait(seconds) => return Ok(ChangeOutcome::Wait { seconds }),
                }
            }
            (current, next)
        };
        // The prompt waits for the user: nothing is held while it is up.
        if current == Mode::Hello || next == Mode::Hello {
            match hello.verify(message) {
                HelloOutcome::Ok => {}
                HelloOutcome::Cancelled => return Ok(ChangeOutcome::Cancelled),
                HelloOutcome::Unavailable => return Ok(ChangeOutcome::Unavailable),
                HelloOutcome::Failed => return Ok(ChangeOutcome::Failed),
            }
        }
        let hash = match &change.password {
            Some(p) if next == Mode::Password => Some(hash_password(p)?),
            _ => None,
        };
        let mut i = self.inner();
        // Locked, or changed from elsewhere, while the prompt was up: leave it.
        if i.locked || i.config.mode != current {
            return Ok(ChangeOutcome::Cancelled);
        }
        let mut config = i.config.clone();
        config.mode = next;
        if let Some(hash) = hash {
            config.hash = hash;
        }
        if next != Mode::Password {
            config.hash.clear();
        }
        if let Some(minutes) = change.idle_minutes {
            config.idle_minutes = minutes;
        }
        config.fails = 0;
        config.wait_until = 0;
        config.write(&self.file)?;
        i.config = config;
        Ok(ChangeOutcome::Ok)
    }

    pub fn idle_limit(&self) -> Option<Duration> {
        let minutes = self.inner().config.idle_minutes;
        (minutes > 0).then(|| Duration::from_secs(u64::from(minutes) * 60))
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::Path;
    use std::time::Duration;

    use super::*;

    struct FakeHello {
        answer: HelloOutcome,
        asked: Cell<u32>,
    }

    impl FakeHello {
        fn saying(answer: HelloOutcome) -> Self {
            Self { answer, asked: Cell::new(0) }
        }
    }

    impl Hello for FakeHello {
        fn verify(&self, _message: &str) -> HelloOutcome {
            self.asked.set(self.asked.get() + 1);
            self.answer
        }
    }

    fn pw(password: &str) -> Change {
        Change { mode: Some(Mode::Password), password: Some(password.into()), idle_minutes: None }
    }

    fn to(mode: Mode) -> Change {
        Change { mode: Some(mode), password: None, idle_minutes: None }
    }

    fn idle(minutes: u32) -> Change {
        Change { mode: None, password: None, idle_minutes: Some(minutes) }
    }

    fn change(l: &AppLock, c: Change, proof: Option<&str>, hello: &FakeHello) -> AppResult<ChangeOutcome> {
        l.change(c, proof, "확인", hello, 1000)
    }

    fn no_hello() -> FakeHello {
        FakeHello::saying(HelloOutcome::Unavailable)
    }

    /// An unlocked app that has just turned on the password "abcd".
    fn with_password(dir: &Path) -> AppLock {
        let l = AppLock::load(dir);
        assert_eq!(change(&l, pw("abcd"), None, &no_hello()).unwrap(), ChangeOutcome::Ok);
        l
    }

    /// The same, started again: locked.
    fn locked_with_password(dir: &Path) -> AppLock {
        with_password(dir);
        AppLock::load(dir)
    }

    #[test]
    fn a_new_install_has_no_lock() {
        let dir = tempfile::tempdir().unwrap();
        let l = AppLock::load(dir.path());
        let s = l.status();
        assert_eq!((s.mode, s.locked, s.idle_minutes), (Mode::Off, false, 5));
        assert!(!l.lock(Reason::Manual));
        assert!(!l.status().locked);
    }

    #[test]
    fn the_password_is_stored_hashed_and_locks_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let first = with_password(dir.path());
        assert!(!first.status().locked, "turning the lock on does not lock at once");
        let text = fs::read_to_string(dir.path().join("app-lock.json")).unwrap();
        assert!(!text.contains("abcd"));
        assert!(text.contains("$argon2id$"));

        let l = AppLock::load(dir.path());
        let s = l.status();
        assert!(s.locked);
        assert_eq!(s.reason, Some(Reason::Start));
        assert_eq!(l.unlock_password("abce", 1000), Check::Wrong);
        assert!(l.status().locked);
        assert_eq!(l.unlock_password("abcd", 1000), Check::Ok);
        assert!(!l.status().locked);
    }

    #[test]
    fn five_wrong_tries_wait_30_seconds_even_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let l = locked_with_password(dir.path());
        for _ in 0..5 {
            assert_eq!(l.unlock_password("zzzz", 1000), Check::Wrong);
        }
        assert_eq!(l.unlock_password("abcd", 1000), Check::Wait(30));
        let again = AppLock::load(dir.path());
        assert_eq!(again.unlock_password("abcd", 1010), Check::Wait(20));
        assert_eq!(again.unlock_password("abcd", 1030), Check::Ok);
    }

    #[test]
    fn a_clock_set_back_never_waits_longer_than_30_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let l = locked_with_password(dir.path());
        for _ in 0..5 {
            l.unlock_password("zzzz", 10_000);
        }
        assert!(matches!(l.unlock_password("abcd", 100), Check::Wait(n) if n <= 30));
        assert_eq!(l.unlock_password("abcd", 131), Check::Ok);
    }

    #[test]
    fn a_password_needs_four_characters_not_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let l = AppLock::load(dir.path());
        assert!(change(&l, pw("가나다"), None, &no_hello()).is_err());
        assert_eq!(l.status().mode, Mode::Off);
        assert_eq!(change(&l, pw("가나다라"), None, &no_hello()).unwrap(), ChangeOutcome::Ok);
    }

    #[test]
    fn changing_needs_the_current_proof() {
        let dir = tempfile::tempdir().unwrap();
        let l = with_password(dir.path());
        assert_eq!(change(&l, to(Mode::Off), None, &no_hello()).unwrap(), ChangeOutcome::Wrong);
        assert_eq!(change(&l, to(Mode::Off), Some("zzzz"), &no_hello()).unwrap(), ChangeOutcome::Wrong);
        assert_eq!(l.status().mode, Mode::Password);
        assert_eq!(change(&l, to(Mode::Off), Some("abcd"), &no_hello()).unwrap(), ChangeOutcome::Ok);
        assert_eq!(AppLock::load(dir.path()).status().mode, Mode::Off);
    }

    #[test]
    fn a_locked_app_refuses_changes() {
        let dir = tempfile::tempdir().unwrap();
        let l = locked_with_password(dir.path());
        assert!(change(&l, to(Mode::Off), Some("abcd"), &no_hello()).is_err());
        assert_eq!(l.status().mode, Mode::Password);
    }

    #[test]
    fn hello_is_turned_on_only_after_one_success() {
        let dir = tempfile::tempdir().unwrap();
        let l = AppLock::load(dir.path());
        for (answer, outcome) in [
            (HelloOutcome::Cancelled, ChangeOutcome::Cancelled),
            (HelloOutcome::Unavailable, ChangeOutcome::Unavailable),
            (HelloOutcome::Failed, ChangeOutcome::Failed),
        ] {
            assert_eq!(change(&l, to(Mode::Hello), None, &FakeHello::saying(answer)).unwrap(), outcome);
            assert_eq!(l.status().mode, Mode::Off);
        }
        let hello = FakeHello::saying(HelloOutcome::Ok);
        assert_eq!(change(&l, to(Mode::Hello), None, &hello).unwrap(), ChangeOutcome::Ok);
        assert_eq!((l.status().mode, hello.asked.get()), (Mode::Hello, 1));
        assert_eq!(change(&l, idle(10), None, &hello).unwrap(), ChangeOutcome::Ok);
        assert_eq!((l.status().idle_minutes, hello.asked.get()), (10, 2));

        let started = AppLock::load(dir.path());
        assert!(started.status().locked);
        assert_eq!(started.unlock_password("abcd", 1000), Check::Wrong);
        assert_eq!(started.unlock_hello(HelloOutcome::Cancelled), HelloOutcome::Cancelled);
        assert!(started.status().locked);
        assert_eq!(started.unlock_hello(HelloOutcome::Ok), HelloOutcome::Ok);
        assert!(!started.status().locked);
    }

    #[test]
    fn damaged_settings_stay_locked() {
        for text in
            ["", "{", "{}", r#"{"mode":"password"}"#, r#"{"mode":"password","hash":"x"}"#, r#"{"mode":"banana"}"#]
        {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join("app-lock.json"), text).unwrap();
            let l = AppLock::load(dir.path());
            let s = l.status();
            assert_eq!((s.mode, s.locked), (Mode::Broken, true), "{text:?}");
            assert_ne!(l.unlock_password("abcd", 1000), Check::Ok);
            l.unlock_hello(HelloOutcome::Ok);
            assert!(l.status().locked, "{text:?}");
            assert!(change(&l, to(Mode::Off), None, &no_hello()).is_err());
            assert_eq!(
                fs::read_to_string(dir.path().join("app-lock.json")).unwrap(),
                text,
                "left for the user to look at"
            );
        }
    }

    #[test]
    fn an_unknown_idle_value_becomes_five() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("app-lock.json"), r#"{"mode":"off","idle_minutes":7}"#).unwrap();
        assert_eq!(AppLock::load(dir.path()).status().idle_minutes, 5);
    }

    #[test]
    fn the_idle_limit_follows_the_setting() {
        let dir = tempfile::tempdir().unwrap();
        let l = with_password(dir.path());
        assert_eq!(l.idle_limit(), Some(Duration::from_secs(300)));
        change(&l, idle(0), Some("abcd"), &no_hello()).unwrap();
        assert_eq!(l.idle_limit(), None);
        assert!(change(&l, idle(7), Some("abcd"), &no_hello()).is_err());
    }

    /// While the PC goes to sleep the page must not ask Windows Hello: a face
    /// could open the app just before the screen goes dark.
    #[test]
    fn going_to_sleep_counts_as_away_until_the_pc_runs_again() {
        let at = Duration::from_secs;
        let dir = tempfile::tempdir().unwrap();
        let l = with_password(dir.path());
        assert!(l.suspend(at(1000)));
        let s = l.status();
        assert_eq!((s.locked, s.reason, s.away), (true, Some(Reason::Sleep), true));
        assert!(!l.wake_if_running(at(1005)), "still on its way to sleep");
        assert!(l.status().away);
        // Still running ten seconds on: awake again, even if Windows never said so.
        assert!(l.wake_if_running(at(1010)));
        assert!(!l.status().away);
        assert!(!l.wake_if_running(at(1011)));
        l.suspend(at(2000));
        assert!(l.resume());
        assert!(!l.resume());
        assert!(!l.status().away);
    }

    #[test]
    fn a_locked_session_stays_away_after_waking() {
        let dir = tempfile::tempdir().unwrap();
        let l = with_password(dir.path());
        l.set_away(true);
        l.suspend(Duration::from_secs(1000));
        l.resume();
        assert!(l.status().away);
        assert!(l.set_away(false));
        assert!(!l.status().away);
    }

    #[test]
    fn returning_triggers_replace_the_reason() {
        let dir = tempfile::tempdir().unwrap();
        let l = with_password(dir.path());
        assert!(l.lock(Reason::Idle));
        assert_eq!(l.status().epoch, 1);
        assert!(!l.lock(Reason::Manual));
        assert!(l.lock(Reason::Session));
        let s = l.status();
        assert_eq!((s.reason, s.epoch), (Some(Reason::Session), 2));
        assert!(l.set_away(true));
        assert!(!l.set_away(true));
        assert!(l.status().away);
    }
}
