//! Encryption format for Git backups: AES-256-SIV with a key derived from a 32-byte master key.
//! Deterministic on purpose, so unchanged notes produce identical Git blobs. The byte-exact
//! format is specified in `docs/암호화-형식.md` and checked by `testdata/crypt-vectors.json`.

use aes_siv::siv::Aes256Siv;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

/// Name of the plain-text marker file at the repository root.
pub const CRYPT_FILE: &str = ".notevine-crypt";

const MAGIC: &[u8; 5] = b"NVENC";
const VERSION: u8 = 0x01;
const ID_LEN: usize = 8;
/// Magic + version + key id; also the SIV associated data.
const HEADER_LEN: usize = MAGIC.len() + 1 + ID_LEN;
const SIV_TAG_LEN: usize = 16;
const HKDF_SALT: &[u8] = b"notevine-crypt-v1";
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The 32-byte secret every other key is derived from.
pub struct MasterKey(pub(crate) [u8; 32]);

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(<redacted>)")
    }
}

impl MasterKey {
    /// A fresh random key from the OS random source.
    pub fn generate() -> MasterKey {
        let mut b = [0u8; 32];
        getrandom::getrandom(&mut b).expect("OS random source unavailable");
        MasterKey(b)
    }

    pub fn from_bytes(b: [u8; 32]) -> MasterKey {
        MasterKey(b)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    fn derive<const N: usize>(&self, info: &[u8]) -> [u8; N] {
        let mut out = [0u8; N];
        Hkdf::<Sha256>::new(Some(HKDF_SALT), &self.0).expand(info, &mut out).expect("HKDF length is valid");
        out
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn id_bytes(k: &MasterKey) -> [u8; ID_LEN] {
    k.derive(b"key-id")
}

/// 16 lowercase hex digits identifying the key without revealing it.
pub fn key_id(k: &MasterKey) -> String {
    hex(&id_bytes(k))
}

fn cipher(k: &MasterKey) -> Aes256Siv {
    use aes_siv::KeyInit;
    let key: [u8; 64] = k.derive(b"aes-siv-256");
    Aes256Siv::new(&key.into())
}

/// `NVENC` + version + key id + SIV output. Same key and plaintext always give the same bytes.
pub fn encrypt(k: &MasterKey, plain: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + SIV_TAG_LEN + plain.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&id_bytes(k));
    let sealed = cipher(k).encrypt([&out[..]], plain).expect("SIV encryption cannot fail");
    out.extend_from_slice(&sealed);
    out
}

pub fn is_encrypted(data: &[u8]) -> bool {
    data.len() >= HEADER_LEN && data.starts_with(MAGIC) && data[MAGIC.len()] == VERSION
}

/// The key id stored in the header, if `data` is an encrypted file.
pub fn header_key_id(data: &[u8]) -> Option<String> {
    is_encrypted(data).then(|| hex(&data[MAGIC.len() + 1..HEADER_LEN]))
}

pub fn decrypt(k: &MasterKey, data: &[u8]) -> AppResult<Vec<u8>> {
    if !is_encrypted(data) || data.len() < HEADER_LEN + SIV_TAG_LEN {
        return Err(AppError::System("암호화된 파일 형식이 아닙니다".into()));
    }
    let (header, sealed) = data.split_at(HEADER_LEN);
    if header[MAGIC.len() + 1..] != id_bytes(k) {
        return Err(AppError::System("다른 암호 열쇠로 암호화된 파일입니다".into()));
    }
    cipher(k)
        .decrypt([header], sealed)
        .map_err(|_| AppError::System("복호화하지 못했습니다. 파일이 손상되었거나 열쇠가 다릅니다".into()))
}

fn bad_code() -> AppError {
    AppError::System("복구 코드가 맞지 않습니다".into())
}

/// Master key + 2-byte SHA-256 check, Crockford Base32, groups of 6 joined by `-`.
pub fn recovery_code(k: &MasterKey) -> String {
    let mut data = k.0.to_vec();
    data.extend_from_slice(&Sha256::digest(k.0)[..2]);
    let (mut acc, mut bits) = (0u32, 0u32);
    let mut chars = Vec::new();
    for b in data {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            chars.push(CROCKFORD[(acc >> bits) as usize & 31]);
        }
    }
    if bits > 0 {
        chars.push(CROCKFORD[((acc << (5 - bits)) as usize) & 31]);
    }
    chars.chunks(6).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-")
}

/// Accepts any case, spaces and `-`; reads `O` as 0 and `I`/`L` as 1.
pub fn parse_recovery_code(s: &str) -> AppResult<MasterKey> {
    let (mut acc, mut bits) = (0u32, 0u32);
    let mut bytes = Vec::new();
    for c in s.chars().filter(|c| !c.is_whitespace() && *c != '-') {
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            u => u,
        };
        let v = CROCKFORD.iter().position(|&x| x as char == c).ok_or_else(bad_code)? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if bytes.len() != 34 || acc != 0 {
        return Err(bad_code());
    }
    let key: [u8; 32] = bytes[..32].try_into().expect("length checked");
    if Sha256::digest(key)[..2] != bytes[32..] {
        return Err(bad_code());
    }
    Ok(MasterKey(key))
}

/// Contents of the `.notevine-crypt` marker file.
pub fn crypt_file_text(k: &MasterKey) -> String {
    format!(
        "{{\"format\":1,\"key_id\":\"{}\"}}
",
        key_id(k)
    )
}

/// The key id named by a `.notevine-crypt` file, if it is one we understand.
pub fn crypt_file_key_id(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v["format"].as_u64()? != 1 {
        return None;
    }
    v["key_id"].as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> MasterKey {
        MasterKey::from_bytes(core::array::from_fn(|i| i as u8))
    }

    #[test]
    fn same_key_same_plain_same_cipher() {
        let k = key();
        assert_eq!(encrypt(&k, b"a"), encrypt(&k, b"a"));
        assert_ne!(encrypt(&k, b"a"), encrypt(&k, b"b"));
    }

    #[test]
    fn roundtrip_keeps_bytes_exactly() {
        let k = key();
        let mut big = vec![0u8; 200 * 1024];
        getrandom::getrandom(&mut big).unwrap();
        for x in [&b""[..], b"\xEF\xBB\xBF# a\r\nb\r\n", &big] {
            assert_eq!(decrypt(&k, &encrypt(&k, x)).unwrap(), x);
        }
    }

    #[test]
    fn wrong_key_or_tampered_fails() {
        let k = key();
        let other = MasterKey::generate();
        let c = encrypt(&k, b"secret note");
        assert!(decrypt(&other, &c).is_err());
        let mut t = c.clone();
        let last = t.len() - 1;
        t[last] ^= 1;
        assert!(decrypt(&k, &t).is_err());
        let mut t = c.clone();
        t[20] ^= 1;
        assert!(decrypt(&k, &t).is_err());
        assert!(decrypt(&k, b"plain").is_err());
    }

    #[test]
    fn header_carries_key_id() {
        let k = key();
        let c = encrypt(&k, b"x");
        assert!(is_encrypted(&c));
        assert!(!is_encrypted(b"plain text"));
        assert_eq!(header_key_id(&c), Some(key_id(&k)));
        assert_eq!(header_key_id(b"plain"), None);
    }

    #[test]
    fn recovery_code_roundtrips_and_forgives_typing() {
        let k = key();
        let code = recovery_code(&k);
        assert_eq!(parse_recovery_code(&code).unwrap().0, k.0);
        let sloppy = code.to_lowercase().replace('-', " ").replace('0', "o").replace('1', "i");
        assert_eq!(parse_recovery_code(&sloppy).unwrap().0, k.0);
        let mut chars: Vec<char> = code.chars().collect();
        chars[0] = if chars[0] == '2' { '3' } else { '2' };
        let bad: String = chars.into_iter().collect();
        let err = parse_recovery_code(&bad).unwrap_err();
        assert_eq!(err.to_string(), "복구 코드가 맞지 않습니다");
    }

    #[test]
    fn crypt_file_roundtrips_key_id() {
        let k = key();
        let t = crypt_file_text(&k);
        assert_eq!(t, format!("{{\"format\":1,\"key_id\":\"{}\"}}\n", key_id(&k)));
        assert_eq!(crypt_file_key_id(&t), Some(key_id(&k)));
        assert_eq!(crypt_file_key_id("nope"), None);
    }

    #[test]
    fn matches_shared_vectors() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../testdata/crypt-vectors.json")).unwrap();
        let list = v.as_array().unwrap();
        assert!(list.len() >= 3);
        for e in list {
            let s = |n: &str| e[n].as_str().unwrap().to_string();
            let k = MasterKey::from_bytes(unhex(&s("master_hex")).try_into().unwrap());
            let plain = unhex(&s("plain_hex"));
            assert_eq!(hex(&encrypt(&k, &plain)), s("cipher_hex"));
            assert_eq!(key_id(&k), s("key_id"));
            assert_eq!(recovery_code(&k), s("recovery_code"));
            assert_eq!(decrypt(&k, &unhex(&s("cipher_hex"))).unwrap(), plain);
        }
    }

    #[test]
    fn master_key_debug_is_redacted() {
        assert_eq!(format!("{:?}", key()), "MasterKey(<redacted>)");
    }

    #[test]
    fn malformed_input_is_rejected_without_panic() {
        let k = key();
        let c = encrypt(&k, b"hello");
        for len in [0, 13, 14, 29] {
            assert!(decrypt(&k, &c[..len]).is_err(), "len {len}");
        }
        assert!(decrypt(&k, &c[..14]).is_err());
        // Foreign magic, long enough.
        let mut t = c.clone();
        t[..5].copy_from_slice(b"XXXXX");
        assert!(!is_encrypted(&t));
        assert!(decrypt(&k, &t).is_err());
        // Wrong version byte.
        let mut t = c.clone();
        t[5] = 0x02;
        assert!(!is_encrypted(&t));
        assert!(decrypt(&k, &t).is_err());
        // Any header byte, including the key id, is authenticated.
        for i in 0..14 {
            let mut t = c.clone();
            t[i] ^= 1;
            assert!(decrypt(&k, &t).is_err(), "header byte {i}");
        }
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }
}
