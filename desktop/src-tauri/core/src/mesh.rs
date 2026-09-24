//! Client connections to Bee2Bee nodes: probe a node and stream chat completions from it.
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

use crate::identity::{new_nonce, Identity};
use crate::protocol::{build_auth, build_hello, verify_hello};
use crate::{Error, Result};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeInfo {
    pub peer_id: String,
    pub addr: String,
    pub region: String,
    pub version: String,
    pub models: Vec<String>,
    pub providers: Vec<String>,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub addr: String,
    pub messages: Vec<ChatMessage>,
    pub model: Option<String>,
    pub max_tokens: u32,
    pub temperature: f32,
    /// Seconds without progress before giving up.
    #[serde(default = "default_idle")]
    pub idle_timeout_s: u64,
}

fn default_idle() -> u64 {
    120
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatDone {
    pub provider: String,
    pub backend: Option<String>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub latency_ms: u64,
    pub tokens_per_sec: f64,
}

pub fn validate_addr(addr: &str) -> Result<url::Url> {
    let url =
        url::Url::parse(addr.trim()).map_err(|e| Error::Other(format!("invalid address: {e}")))?;
    if !matches!(url.scheme(), "ws" | "wss") || url.host_str().is_none() {
        return Err(Error::Other(
            "address must look like ws://host:port or wss://host".into(),
        ));
    }
    Ok(url)
}

async fn next_json(ws: &mut Ws) -> Result<Value> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => return Ok(serde_json::from_str(t.as_str())?),
            Some(Ok(Message::Binary(b))) => return Ok(serde_json::from_slice(&b)?),
            Some(Ok(Message::Close(frame))) => {
                let reason = frame
                    .map(|f| format!("{} {}", u16::from(f.code), f.reason))
                    .unwrap_or_default();
                return Err(Error::Connection(format!(
                    "node closed the connection {reason}"
                )));
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e.into()),
            None => return Err(Error::Connection("connection closed".into())),
        }
    }
}

async fn send_json(ws: &mut Ws, v: &Value) -> Result<()> {
    ws.send(Message::Text(v.to_string().into())).await?;
    Ok(())
}

fn info_from_hello(hello: &Value, addr: &str, latency: Duration) -> NodeInfo {
    let services = hello.get("services").and_then(Value::as_object);
    let mut models: Vec<String> = Vec::new();
    let mut providers: Vec<String> = Vec::new();
    if let Some(svcs) = services {
        for (name, meta) in svcs {
            let backend = meta
                .get("backend")
                .and_then(Value::as_str)
                .unwrap_or(name)
                .to_string();
            if !providers.contains(&backend) {
                providers.push(backend);
            }
            for m in meta
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(m) = m.as_str() {
                    if !models.iter().any(|x| x == m) {
                        models.push(m.to_string());
                    }
                }
            }
        }
    }
    models.sort();
    let s = |k: &str| {
        hello
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    NodeInfo {
        peer_id: s("peer_id"),
        addr: if s("addr").is_empty() {
            addr.to_string()
        } else {
            s("addr")
        },
        region: s("region"),
        version: s("version"),
        models,
        providers,
        latency_ms: latency.as_millis() as u64,
    }
}

/// Connect and run the mutual handshake as a client.
async fn handshake(identity: &Identity, addr: &str) -> Result<(Ws, NodeInfo)> {
    validate_addr(addr)?;
    let started = Instant::now();
    let config = WebSocketConfig::default().max_message_size(Some(1 << 20));
    let (mut ws, _) = timeout(
        HANDSHAKE_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(addr, Some(config), false),
    )
    .await
    .map_err(|_| Error::Timeout(format!("connecting to {addr}")))??;
    let challenge = format!("{}{}", new_nonce(), new_nonce());
    send_json(
        &mut ws,
        &build_hello(identity, "client", "", &challenge, "")?,
    )
    .await?;
    let hello = timeout(HANDSHAKE_TIMEOUT, next_json(&mut ws))
        .await
        .map_err(|_| Error::Timeout("handshake".into()))??;
    if hello.get("type").and_then(Value::as_str) != Some("hello") {
        return Err(Error::Protocol("node did not answer with hello".into()));
    }
    verify_hello(&hello, Some(&challenge))?;
    if hello.get("role").and_then(Value::as_str) != Some("node") {
        return Err(Error::Protocol("remote is not a node".into()));
    }
    let their_challenge = hello["challenge"].as_str().unwrap_or_default().to_string();
    send_json(&mut ws, &build_auth(identity, &their_challenge)?).await?;
    let info = info_from_hello(&hello, addr, started.elapsed());
    Ok((ws, info))
}

/// Check a node: verifies its identity and returns what it serves.
pub async fn probe(identity: &Identity, addr: &str) -> Result<NodeInfo> {
    let (mut ws, info) = handshake(identity, addr).await?;
    let _ = ws.close(None).await;
    Ok(info)
}

/// Stream a chat completion from a node. `on_text` receives each delta.
pub async fn chat(
    identity: &Identity,
    req: &ChatRequest,
    cancel: CancellationToken,
    mut on_text: impl FnMut(&str),
) -> Result<ChatDone> {
    let (mut ws, info) = handshake(identity, &req.addr).await?;
    let rid = format!("desk-{}", new_nonce());
    let mut body = json!({
        "type": "gen_request",
        "rid": rid,
        "messages": req.messages,
        "max_new_tokens": req.max_tokens,
        "temperature": (req.temperature.clamp(0.0, 2.0) * 100.0).round() / 100.0,
        "stream": true,
        "hops": 0,
    });
    if let Some(model) = req.model.as_ref().filter(|m| !m.is_empty()) {
        body["model"] = json!(model);
    }
    send_json(&mut ws, &body).await?;
    let started = Instant::now();
    let idle = Duration::from_secs(req.idle_timeout_s.max(5));
    let result = loop {
        let msg = tokio::select! {
            _ = cancel.cancelled() => {
                let _ = send_json(&mut ws, &json!({"type": "gen_cancel", "rid": rid})).await;
                break Err(Error::Cancelled);
            }
            r = timeout(idle, next_json(&mut ws)) => match r {
                Err(_) => {
                    let _ = send_json(&mut ws, &json!({"type": "gen_cancel", "rid": rid})).await;
                    break Err(Error::Timeout("node stopped responding".into()));
                }
                Ok(Err(e)) => break Err(e),
                Ok(Ok(v)) => v,
            }
        };
        let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
        if kind == "ping" {
            send_json(&mut ws, &json!({"type": "pong", "ts": msg.get("ts")})).await?;
            continue;
        }
        if msg.get("rid").and_then(Value::as_str) != Some(rid.as_str()) {
            continue;
        }
        match kind {
            "gen_chunk" => {
                if let Some(t) = msg.get("text").and_then(Value::as_str) {
                    on_text(t);
                }
            }
            "gen_error" => {
                break Err(Error::Remote {
                    code: msg
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or("provider_error")
                        .to_string(),
                    message: msg
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("node error")
                        .to_string(),
                })
            }
            "gen_done" | "gen_result" | "gen_success" => {
                if let Some(t) = msg
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                {
                    on_text(t);
                }
                let usage = msg.get("usage").cloned().unwrap_or(Value::Null);
                let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
                let elapsed = started.elapsed();
                let completion = n("completion_tokens");
                break Ok(ChatDone {
                    provider: msg
                        .get("provider")
                        .and_then(Value::as_str)
                        .unwrap_or(&info.peer_id)
                        .to_string(),
                    backend: msg
                        .get("backend")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    prompt_tokens: n("prompt_tokens"),
                    completion_tokens: completion,
                    latency_ms: elapsed.as_millis() as u64,
                    tokens_per_sec: if elapsed.as_secs_f64() > 0.0 {
                        completion as f64 / elapsed.as_secs_f64()
                    } else {
                        0.0
                    },
                });
            }
            _ => {}
        }
    };
    let _ = ws.close(None).await;
    result
}
