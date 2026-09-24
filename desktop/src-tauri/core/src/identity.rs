//! Ed25519 identity, byte-compatible with `bee2bee/identity.py`.
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{Error, Result};

/// JSON with recursively sorted keys, no whitespace and integers only.
pub fn canonical_json(value: &Value) -> Result<String> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String) -> Result<()> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => {
            out.push_str(&serde_json::to_string(value)?)
        }
        Value::Number(n) => {
            if n.is_f64() {
                return Err(Error::Protocol(
                    "floats are not allowed in signed payloads".into(),
                ));
            }
            out.push_str(&n.to_string());
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k)?);
                out.push(':');
                write_canonical(&map[*k], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

pub fn peer_id_from_pubkey(pubkey_b64: &str) -> Result<String> {
    let raw = B64
        .decode(pubkey_b64)
        .map_err(|e| Error::Unauthorized(format!("invalid pubkey: {e}")))?;
    let digest = Sha256::digest(raw);
    Ok(format!("peer-{}", &hex::encode(digest)[..32]))
}

pub fn verify(pubkey_b64: &str, payload: &Value, sig_b64: &str) -> bool {
    let (Ok(raw), Ok(sig), Ok(msg)) = (
        B64.decode(pubkey_b64),
        B64.decode(sig_b64),
        canonical_json(payload),
    ) else {
        return false;
    };
    let (Ok(raw), Ok(sig)) = (
        <[u8; 32]>::try_from(raw.as_slice()),
        <[u8; 64]>::try_from(sig.as_slice()),
    ) else {
        return false;
    };
    match VerifyingKey::from_bytes(&raw) {
        Ok(key) => key
            .verify(msg.as_bytes(), &Signature::from_bytes(&sig))
            .is_ok(),
        Err(_) => false,
    }
}

pub fn new_nonce() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}

pub struct Identity {
    key: SigningKey,
    pub pubkey: String,
    pub peer_id: String,
}

impl Identity {
    pub fn from_key(key: SigningKey) -> Self {
        let pubkey = B64.encode(key.verifying_key().to_bytes());
        let peer_id = peer_id_from_pubkey(&pubkey).expect("valid key");
        Self {
            key,
            pubkey,
            peer_id,
        }
    }

    pub fn generate() -> Self {
        Self::from_key(SigningKey::generate(&mut rand::rngs::OsRng))
    }

    /// Load a PKCS#8 PEM key (same format as the Python node) or create one with mode 0600.
    pub fn load_or_create(path: &Path) -> Result<Self> {
        if path.exists() {
            let pem = std::fs::read_to_string(path)?;
            let key = SigningKey::from_pkcs8_pem(&pem)
                .map_err(|e| Error::Other(format!("invalid identity key: {e}")))?;
            return Ok(Self::from_key(key));
        }
        let ident = Self::generate();
        let pem = ident
            .key
            .to_pkcs8_pem(Default::default())
            .map_err(|e| Error::Other(format!("cannot encode key: {e}")))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        write_private(path, pem.as_bytes())?;
        Ok(ident)
    }

    pub fn sign(&self, payload: &Value) -> Result<String> {
        let msg = canonical_json(payload)?;
        Ok(B64.encode(self.key.sign(msg.as_bytes()).to_bytes()))
    }
}

#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(data)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    std::fs::write(path, data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_matches_python_and_js() {
        let v = json!({"b": 1, "a": {"d": [1, "é", null], "c": true}, "s": "q\"\n/"});
        assert_eq!(
            canonical_json(&v).unwrap(),
            r#"{"a":{"c":true,"d":[1,"é",null]},"b":1,"s":"q\"\n/"}"#
        );
        assert!(canonical_json(&json!({"x": 1.5})).is_err());
    }

    #[test]
    fn sign_verify_and_peer_id() {
        let id = Identity::generate();
        let payload = json!({"a": 1});
        let sig = id.sign(&payload).unwrap();
        assert!(verify(&id.pubkey, &payload, &sig));
        assert!(!verify(&id.pubkey, &json!({"a": 2}), &sig));
        assert!(id.peer_id.starts_with("peer-") && id.peer_id.len() == 37);
        assert_eq!(peer_id_from_pubkey(&id.pubkey).unwrap(), id.peer_id);
    }

    #[test]
    fn persists_identity() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("key.pem");
        let a = Identity::load_or_create(&p).unwrap();
        let b = Identity::load_or_create(&p).unwrap();
        assert_eq!(a.peer_id, b.peer_id);
    }
}
