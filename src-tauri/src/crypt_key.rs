//! 이 PC의 Git 암호화 열쇠 보관.
//!
//! 열쇠는 복구 코드 문자열로 OS 자격 증명 저장소에 둔다. 환경 변수
//! `NOTEVINE_KEY_STORE=test`이면 OS 저장소를 건드리지 않고 메모리 저장소를 쓴다
//! (`NOTEVINE_TEST_KEY`에 복구 코드가 있으면 그 열쇠로 채운다). git 하위 프로세스 통합 시험용.

use std::sync::Mutex;

use crate::crypt::{MasterKey, parse_recovery_code, recovery_code};
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

pub struct OsKeyStore;

fn entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, USER).map_err(|e| sys(format!("자격 증명 저장소를 열지 못했습니다: {e}")))
}

impl KeyStore for OsKeyStore {
    fn load(&self) -> AppResult<Option<MasterKey>> {
        match entry()?.get_password() {
            Ok(s) if s.trim().is_empty() => Ok(None),
            Ok(s) => parse_recovery_code(&s).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(sys(format!("열쇠를 읽지 못했습니다: {e}"))),
        }
    }

    fn save(&self, k: &MasterKey) -> AppResult<()> {
        entry()?.set_password(&recovery_code(k)).map_err(|e| sys(format!("열쇠를 저장하지 못했습니다: {e}")))
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
struct FailingKeyStore(String);

impl KeyStore for FailingKeyStore {
    fn load(&self) -> AppResult<Option<MasterKey>> {
        Err(sys(self.0.clone()))
    }

    fn save(&self, _k: &MasterKey) -> AppResult<()> {
        Err(sys(self.0.clone()))
    }
}

pub fn key_store() -> Box<dyn KeyStore> {
    if std::env::var("NOTEVINE_KEY_STORE").as_deref() == Ok("test") {
        return match std::env::var("NOTEVINE_TEST_KEY") {
            Ok(code) => match parse_recovery_code(&code) {
                Ok(k) => {
                    let s = MemoryKeyStore::default();
                    let _ = s.save(&k);
                    Box::new(s)
                }
                Err(e) => Box::new(FailingKeyStore(e.to_string())),
            },
            Err(_) => Box::new(MemoryKeyStore::default()),
        };
    }
    Box::new(OsKeyStore)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypt::{MasterKey, recovery_code};
    use std::sync::Mutex;

    static ENV_GUARD: Mutex<()> = Mutex::new(());

    fn clear_env() {
        // SAFETY: 환경 변수를 만지는 시험은 ENV_GUARD로 한 번에 하나만 돈다.
        unsafe {
            std::env::remove_var("NOTEVINE_KEY_STORE");
            std::env::remove_var("NOTEVINE_TEST_KEY");
        }
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
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let k = MasterKey::generate();
        unsafe {
            std::env::set_var("NOTEVINE_KEY_STORE", "test");
        }
        unsafe {
            std::env::set_var("NOTEVINE_TEST_KEY", recovery_code(&k));
        }
        let got = key_store().load().unwrap().unwrap();
        clear_env();
        assert_eq!(got.as_bytes(), k.as_bytes());
    }

    #[test]
    fn test_store_without_key_is_empty() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        clear_env();
        unsafe {
            std::env::set_var("NOTEVINE_KEY_STORE", "test");
        }
        let got = key_store().load();
        clear_env();
        assert!(got.unwrap().is_none());
    }

    #[test]
    fn test_store_with_invalid_key_errors() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            std::env::set_var("NOTEVINE_KEY_STORE", "test");
        }
        unsafe {
            std::env::set_var("NOTEVINE_TEST_KEY", "not a recovery code");
        }
        let got = key_store().load();
        clear_env();
        assert!(got.is_err());
    }

    #[test]
    #[ignore = "실제 자격 증명 관리자를 건드린다. 수동 실행"]
    fn os_store_roundtrip() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        clear_env();
        let s = OsKeyStore;
        let k = MasterKey::generate();
        s.save(&k).unwrap();
        assert_eq!(s.load().unwrap().unwrap().as_bytes(), k.as_bytes());
    }
}
