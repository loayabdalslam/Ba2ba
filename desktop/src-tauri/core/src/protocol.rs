//! Bee2Bee wire protocol v2 (see docs/PROTOCOL.md).
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::identity::{new_nonce, peer_id_from_pubkey, verify, Identity};
use crate::{Error, Result};

pub const PROTOCOL_VERSION: i64 = 2;
pub const MAX_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
pub const HELLO_SIGNED_FIELDS: [&str; 10] = [
    "type",
    "protocol_version",
    "peer_id",
    "pubkey",
    "role",
    "addr",
    "ts",
    "nonce",
    "challenge",
    "response_to",
];

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn pick(msg: &Map<String, Value>, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .map(|k| {
                (
                    (*k).to_string(),
                    msg.get(*k).cloned().unwrap_or(Value::Null),
                )
            })
            .collect(),
    )
}

pub fn build_hello(
    identity: &Identity,
    role: &str,
    addr: &str,
    challenge: &str,
    response_to: &str,
) -> Result<Value> {
    let mut msg = json!({
        "type": "hello",
        "protocol_version": PROTOCOL_VERSION,
        "peer_id": identity.peer_id,
        "pubkey": identity.pubkey,
        "role": role,
        "addr": addr,
        "ts": now_ms(),
        "nonce": new_nonce(),
        "challenge": challenge,
        "response_to": response_to,
    });
    let obj = msg.as_object_mut().expect("object");
    let sig = identity.sign(&pick(obj, &HELLO_SIGNED_FIELDS))?;
    obj.insert("sig".into(), Value::String(sig));
    obj.insert(
        "version".into(),
        Value::String(format!("desktop-{}", env!("CARGO_PKG_VERSION"))),
    );
    Ok(msg)
}

pub fn build_auth(identity: &Identity, response_to: &str) -> Result<Value> {
    let body = json!({"type": "auth", "peer_id": identity.peer_id, "response_to": response_to});
    let sig = identity.sign(&body)?;
    let mut out = body;
    out["sig"] = Value::String(sig);
    Ok(out)
}

/// Validate a hello; when `expected_response` is set the peer must answer our challenge.
pub fn verify_hello(msg: &Value, expected_response: Option<&str>) -> Result<()> {
    let obj = msg
        .as_object()
        .ok_or_else(|| Error::Protocol("hello must be an object".into()))?;
    if obj.get("protocol_version").and_then(Value::as_i64) != Some(PROTOCOL_VERSION) {
        return Err(Error::Protocol("unsupported protocol version".into()));
    }
    for key in [
        "peer_id",
        "pubkey",
        "role",
        "addr",
        "nonce",
        "challenge",
        "response_to",
        "sig",
    ] {
        if !obj.get(key).map(Value::is_string).unwrap_or(false) {
            return Err(Error::Protocol(format!("hello has invalid {key}")));
        }
    }
    let ts = obj
        .get("ts")
        .and_then(Value::as_i64)
        .ok_or_else(|| Error::Protocol("invalid ts".into()))?;
    if (now_ms() - ts).abs() > MAX_CLOCK_SKEW_MS {
        return Err(Error::Unauthorized(
            "hello timestamp outside allowed clock skew (check your system clock)".into(),
        ));
    }
    let s = |k: &str| obj[k].as_str().unwrap_or_default();
    if peer_id_from_pubkey(s("pubkey"))? != s("peer_id") {
        return Err(Error::Unauthorized("peer_id does not match pubkey".into()));
    }
    if !verify(s("pubkey"), &pick(obj, &HELLO_SIGNED_FIELDS), s("sig")) {
        return Err(Error::Unauthorized("invalid hello signature".into()));
    }
    if let Some(expected) = expected_response {
        if s("response_to") != expected {
            return Err(Error::Unauthorized(
                "hello does not answer our challenge".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_roundtrip_and_tampering() {
        let a = Identity::generate();
        let hello = build_hello(&a, "node", "ws://1.2.3.4:4003", &"c".repeat(32), "r").unwrap();
        verify_hello(&hello, Some("r")).unwrap();
        assert!(verify_hello(&hello, Some("x")).is_err());
        let mut forged = hello.clone();
        forged["addr"] = json!("ws://evil:1");
        assert!(verify_hello(&forged, None).is_err());
        let mut imposter = hello;
        imposter["peer_id"] = json!(Identity::generate().peer_id);
        assert!(verify_hello(&imposter, None).is_err());
    }
}
