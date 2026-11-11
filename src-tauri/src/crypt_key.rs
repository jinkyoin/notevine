//! 이 PC의 Git 암호화 열쇠 보관.
//!
//! 열쇠는 복구 코드 문자열로 OS 자격 증명 저장소에 둔다. 환경 변수
//! `NOTEVINE_KEY_STORE=test`이면 OS 저장소를 건드리지 않고 메모리 저장소를 쓴다
//! (`NOTEVINE_TEST_KEY`에 복구 코드가 있으면 그 열쇠로 채운다). git 하위 프로세스 통합 시험용.

use std::sync::Mutex;

use serde::Serialize;

use crate::crypt::{MasterKey, key_id, parse_recovery_code, recovery_code};
use crate::error::{AppError, AppResult};

const SERVICE: &str = "Notevine";
const USER: &str = "git-encryption-key";

pub trait KeyStore {
    fn load(&self) -> AppResult<Option<MasterKey>>;
    fn save(&self, k: &MasterKey) -> AppResult<()>;
}

fn sys(msg: impl Into<String>) -> AppError {
    AppError::System(msg.into())
}

pub struct OsKeyStore {
    user: &'static str,
}

impl OsKeyStore {
    pub fn new() -> OsKeyStore {
        OsKeyStore { user: USER }
    }

    /// 시험이 진짜 열쇠를 건드리지 않도록 다른 사용자 이름으로 만든다.
    #[cfg(test)]
    pub(crate) fn with_user(user: &'static str) -> OsKeyStore {
        OsKeyStore { user }
    }

    fn entry(&self) -> AppResult<keyring::Entry> {
        entry(self.user)
    }
}

impl Default for OsKeyStore {
    fn default() -> Self {
        Self::new()
    }
}

fn entry(user: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, user).map_err(|e| sys(format!("자격 증명 저장소를 열지 못했습니다: {e}")))
}

impl KeyStore for OsKeyStore {
    fn load(&self) -> AppResult<Option<MasterKey>> {
        match self.entry()?.get_password() {
            Ok(s) if s.trim().is_empty() => Ok(None),
            Ok(s) => parse_recovery_code(&s).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(sys(format!("열쇠를 읽지 못했습니다: {e}"))),
        }
    }

    fn save(&self, k: &MasterKey) -> AppResult<()> {
        self.entry()?.set_password(&recovery_code(k)).map_err(|e| sys(format!("열쇠를 저장하지 못했습니다: {e}")))
    }
}

#[derive(Default)]
pub struct MemoryKeyStore(Mutex<Option<MasterKey>>);

impl KeyStore for MemoryKeyStore {
    fn load(&self) -> AppResult<Option<MasterKey>> {
        let g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Ok(g.as_ref().map(|k| MasterKey::from_bytes(*k.as_bytes())))
    }

    fn save(&self, k: &MasterKey) -> AppResult<()> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(MasterKey::from_bytes(*k.as_bytes()));
        Ok(())
    }
}

/// 잘못된 복구 코드를 `load`에서 오류로 돌려주기 위한 저장소.
#[cfg(debug_assertions)]
struct FailingKeyStore(String);

#[cfg(debug_assertions)]
impl KeyStore for FailingKeyStore {
    fn load(&self) -> AppResult<Option<MasterKey>> {
        Err(sys(self.0.clone()))
    }

    fn save(&self, _k: &MasterKey) -> AppResult<()> {
        Err(sys(self.0.clone()))
    }
}

/// 시험용 메모리 저장소 훅은 디버그 빌드에만 들어간다. 릴리스에서는 환경 변수로 열쇠를 바꿔치기할 수 없다.
#[cfg(debug_assertions)]
fn test_store() -> Option<Box<dyn KeyStore>> {
    if std::env::var("NOTEVINE_KEY_STORE").as_deref() != Ok("test") {
        return None;
    }
    Some(match std::env::var("NOTEVINE_TEST_KEY") {
        Err(std::env::VarError::NotPresent) => Box::new(MemoryKeyStore::default()),
        Err(e) => Box::new(FailingKeyStore(format!("NOTEVINE_TEST_KEY를 읽지 못했습니다: {e}"))),
        Ok(code) => match parse_recovery_code(&code) {
            Ok(k) => {
                let s = MemoryKeyStore::default();
                let _ = s.save(&k);
                Box::new(s)
            }
            Err(e) => Box::new(FailingKeyStore(e.to_string())),
        },
    })
}

pub fn key_store() -> Box<dyn KeyStore> {
    #[cfg(debug_assertions)]
    if let Some(s) = test_store() {
        return s;
    }
    Box::new(OsKeyStore::new())
}

#[derive(Serialize)]
pub struct CryptKeyStatus {
    pub has_key: bool,
    pub key_id: Option<String>,
}

fn status_of(store: &dyn KeyStore) -> AppResult<CryptKeyStatus> {
    let k = store.load()?;
    Ok(CryptKeyStatus { has_key: k.is_some(), key_id: k.as_ref().map(key_id) })
}

/// 열쇠가 없을 때만 새로 만들고 복구 코드를 돌려준다.
fn create_key_in(store: &dyn KeyStore) -> AppResult<String> {
    if store.load()?.is_some() {
        return Err(sys("이 PC에는 이미 열쇠가 있습니다"));
    }
    let k = MasterKey::generate();
    store.save(&k)?;
    Ok(recovery_code(&k))
}

fn show_code_in(store: &dyn KeyStore) -> AppResult<String> {
    match store.load()? {
        Some(k) => Ok(recovery_code(&k)),
        None => Err(sys("이 PC에 암호화 열쇠가 없습니다")),
    }
}

/// 복구 코드로 열쇠를 넣는다. 다른 열쇠가 이미 있으면 덮어쓰지 않고 오류를 낸다.
fn import_key_in(store: &dyn KeyStore, code: &str) -> AppResult<String> {
    let k = parse_recovery_code(code)?;
    match store.load()? {
        None => store.save(&k)?,
        Some(old) if old.as_bytes() == k.as_bytes() => {}
        Some(_) => return Err(sys("이 PC에는 이미 다른 열쇠가 있습니다")),
    }
    Ok(key_id(&k))
}

#[tauri::command]
pub fn crypt_key_status() -> AppResult<CryptKeyStatus> {
    status_of(key_store().as_ref())
}

#[tauri::command]
pub fn crypt_create_key() -> AppResult<String> {
    create_key_in(key_store().as_ref())
}

#[tauri::command]
pub fn crypt_show_recovery_code() -> AppResult<String> {
    show_code_in(key_store().as_ref())
}

#[tauri::command]
pub fn crypt_import_key(code: String) -> AppResult<String> {
    import_key_in(key_store().as_ref(), &code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypt::{MasterKey, recovery_code};
    use std::sync::Mutex;

    static ENV_GUARD: Mutex<()> = Mutex::new(());

    /// 환경 변수를 정하고, 버려질 때(패닉 포함) 지운다. 뮤텍스도 함께 쥔다.
    struct EnvGuard(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

    impl EnvGuard {
        fn new(store: Option<&str>, key: Option<&str>) -> EnvGuard {
            let g = EnvGuard(ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner()));
            clear_env();
            // SAFETY: 환경 변수를 만지는 시험은 ENV_GUARD로 한 번에 하나만 돈다.
            unsafe {
                if let Some(v) = store {
                    std::env::set_var("NOTEVINE_KEY_STORE", v);
                }
                if let Some(v) = key {
                    std::env::set_var("NOTEVINE_TEST_KEY", v);
                }
            }
            g
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            clear_env();
        }
    }

    fn clear_env() {
        // SAFETY: 호출하는 쪽이 ENV_GUARD를 쥐고 있다.
        unsafe {
            std::env::remove_var("NOTEVINE_KEY_STORE");
            std::env::remove_var("NOTEVINE_TEST_KEY");
        }
    }

    #[test]
    fn create_key_makes_one_then_refuses() {
        let s = MemoryKeyStore::default();
        let code = create_key_in(&s).unwrap();
        assert_eq!(show_code_in(&s).unwrap(), code);
        assert!(status_of(&s).unwrap().has_key);
        let err = create_key_in(&s).unwrap_err().to_string();
        assert!(err.contains("이미 열쇠가 있습니다"), "{err}");
        assert_eq!(show_code_in(&s).unwrap(), code);
    }

    #[test]
    fn show_code_without_key_errors() {
        let s = MemoryKeyStore::default();
        assert!(show_code_in(&s).unwrap_err().to_string().contains("열쇠가 없습니다"));
        let st = status_of(&s).unwrap();
        assert!(!st.has_key && st.key_id.is_none());
    }

    #[test]
    fn import_key_saves_when_empty_and_accepts_same() {
        let s = MemoryKeyStore::default();
        let k = MasterKey::generate();
        let id = import_key_in(&s, &recovery_code(&k)).unwrap();
        assert_eq!(id, key_id(&k));
        assert_eq!(s.load().unwrap().unwrap().as_bytes(), k.as_bytes());
        assert_eq!(import_key_in(&s, &recovery_code(&k)).unwrap(), id);
        assert_eq!(status_of(&s).unwrap().key_id.as_deref(), Some(id.as_str()));
    }

    #[test]
    fn import_key_never_overwrites_a_different_key() {
        let s = MemoryKeyStore::default();
        let old = MasterKey::generate();
        s.save(&old).unwrap();
        let err = import_key_in(&s, &recovery_code(&MasterKey::generate())).unwrap_err().to_string();
        assert!(err.contains("이미 다른 열쇠가 있습니다"), "{err}");
        assert_eq!(s.load().unwrap().unwrap().as_bytes(), old.as_bytes());
        assert!(import_key_in(&s, "garbage").is_err());
    }

    #[test]
    fn memory_store_saves_and_loads() {
        let s = MemoryKeyStore::default();
        assert!(s.load().unwrap().is_none());
        let k = MasterKey::generate();
        s.save(&k).unwrap();
        assert_eq!(s.load().unwrap().unwrap().as_bytes(), k.as_bytes());
    }

    #[test]
    fn env_override_supplies_the_key() {
        let k = MasterKey::generate();
        let _g = EnvGuard::new(Some("test"), Some(&recovery_code(&k)));
        let got = key_store().load().unwrap().unwrap();
        assert_eq!(got.as_bytes(), k.as_bytes());
    }

    #[test]
    fn test_store_without_key_is_empty() {
        let _g = EnvGuard::new(Some("test"), None);
        assert!(key_store().load().unwrap().is_none());
    }

    #[test]
    fn test_store_with_invalid_key_errors() {
        let _g = EnvGuard::new(Some("test"), Some("not a recovery code"));
        assert!(key_store().load().is_err());
    }

    #[test]
    #[ignore = "실제 자격 증명 관리자를 건드린다(시험용 사용자 이름). 수동 실행"]
    fn os_store_roundtrip() {
        let _g = EnvGuard::new(None, None);
        let s = OsKeyStore::with_user("git-encryption-key-test");
        let k = MasterKey::generate();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            s.save(&k).unwrap();
            assert_eq!(s.load().unwrap().unwrap().as_bytes(), k.as_bytes());
        }));
        match s.entry().unwrap().delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => panic!("시험 자격 증명을 지우지 못했습니다: {e}"),
        }
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }
}
