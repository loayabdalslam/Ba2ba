//! Talks to a real Python node. Set BEE2BEE_PYTHON to a Python with `bee2bee` installed; skipped otherwise.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bee2bee_core::deploy::{DeploymentConfig, DeploymentManager, LaunchOptions, RunState};
use bee2bee_core::identity::Identity;
use bee2bee_core::mesh::{chat, probe, ChatMessage, ChatRequest};
use tokio_util::sync::CancellationToken;

fn python() -> Option<String> {
    std::env::var("BEE2BEE_PYTHON")
        .ok()
        .filter(|p| !p.is_empty())
}

async fn wait_for_probe(identity: &Identity, addr: &str) -> bee2bee_core::mesh::NodeInfo {
    for _ in 0..80 {
        if let Ok(info) = probe(identity, addr).await {
            return info;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("node at {addr} never came up");
}

#[tokio::test]
async fn deploy_probe_chat_and_cancel_against_python_node() {
    let Some(py) = python() else {
        eprintln!("skipping: BEE2BEE_PYTHON not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let manager = DeploymentManager::load(dir.path()).unwrap();
    manager
        .save(DeploymentConfig {
            id: "echo-test".into(),
            name: "rust-interop".into(),
            backend: "echo".into(),
            model: "echo-rs".into(),
            region: "lab".into(),
            port: 4291,
            api_port: 4292,
            announce_addr: Some("ws://127.0.0.1:4291".into()),
            public_host: None,
            bootstrap: None,
            price: 0.0,
            auto_start: false,
        })
        .await
        .unwrap();
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink_logs = Arc::clone(&logs);
    let opts = LaunchOptions {
        command: format!("{py} -m bee2bee"),
        ..Default::default()
    };
    manager
        .start(
            "echo-test",
            &opts,
            Arc::new(move |_id: &str, line: &str| sink_logs.lock().unwrap().push(line.to_string())),
        )
        .await
        .unwrap();

    let me = Identity::generate();
    let info = wait_for_probe(&me, "ws://127.0.0.1:4291").await;
    assert_eq!(info.models, vec!["echo-rs"]);
    assert_eq!(info.providers, vec!["echo"]);
    assert_eq!(info.region, "lab");

    // Streaming chat with messages.
    let req = ChatRequest {
        addr: "ws://127.0.0.1:4291".into(),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "hello from rust".into(),
        }],
        model: Some("echo-rs".into()),
        max_tokens: 64,
        temperature: 0.7,
        idle_timeout_s: 10,
    };
    let mut text = String::new();
    let done = chat(&me, &req, CancellationToken::new(), |t| text.push_str(t))
        .await
        .unwrap();
    assert_eq!(text, "user: hello from rust assistant:");
    assert_eq!(done.completion_tokens, 5);
    assert_eq!(done.provider, info.peer_id);

    // Unknown model -> remote error surfaces with its code.
    let err = chat(
        &me,
        &ChatRequest {
            model: Some("nope".into()),
            ..req.clone()
        },
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(err.to_string().starts_with("no_provider"), "{err}");

    // Cancellation returns promptly.
    let token = CancellationToken::new();
    token.cancel();
    let err = chat(&me, &req, token, |_| {}).await;
    assert!(err.is_err());

    // The node's local API is readable with the key from its home directory.
    let status = manager.node_status("echo-test").await.unwrap();
    assert_eq!(status["node"]["peer_id"], serde_json::json!(info.peer_id));

    manager.stop("echo-test").await.unwrap();
    let state = manager.list().await[0].state.clone();
    assert!(matches!(state, RunState::Exited { .. }), "{state:?}");
    assert!(
        logs.lock().unwrap().iter().any(|l| l.contains("running")),
        "logs captured"
    );
}
