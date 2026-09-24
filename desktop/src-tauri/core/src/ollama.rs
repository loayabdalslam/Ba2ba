//! Minimal Ollama client for listing, pulling and deleting local models.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    pub modified_at: String,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PullProgress {
    pub status: String,
    pub completed: u64,
    pub total: u64,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("http client")
}

fn base(host: &str) -> String {
    host.trim_end_matches('/').to_string()
}

pub async fn version(host: &str) -> Result<String> {
    let v: Value = client()
        .get(format!("{}/api/version", base(host)))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(v.get("version")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string())
}

pub async fn list(host: &str) -> Result<Vec<OllamaModel>> {
    let v: Value = client()
        .get(format!("{}/api/tags", base(host)))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(v.get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|m| OllamaModel {
            name: m
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            size: m.get("size").and_then(Value::as_u64).unwrap_or(0),
            modified_at: m
                .get("modified_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            parameter_size: m
                .pointer("/details/parameter_size")
                .and_then(Value::as_str)
                .map(str::to_string),
            quantization: m
                .pointer("/details/quantization_level")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
        .collect())
}

/// Pull a model, reporting progress lines as they stream in.
pub async fn pull(
    host: &str,
    model: &str,
    mut on_progress: impl FnMut(PullProgress),
) -> Result<()> {
    let resp = client()
        .post(format!("{}/api/pull", base(host)))
        .json(&json!({"model": model, "stream": true}))
        .send()
        .await?
        .error_for_status()?;
    let mut stream = resp.bytes_stream();
    let mut buf = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk?);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if let Some(err) = v.get("error").and_then(Value::as_str) {
                return Err(Error::Other(format!("ollama: {err}")));
            }
            on_progress(PullProgress {
                status: v
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                completed: v.get("completed").and_then(Value::as_u64).unwrap_or(0),
                total: v.get("total").and_then(Value::as_u64).unwrap_or(0),
            });
        }
    }
    Ok(())
}

pub async fn delete(host: &str, model: &str) -> Result<()> {
    client()
        .delete(format!("{}/api/delete", base(host)))
        .json(&json!({"model": model}))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}
