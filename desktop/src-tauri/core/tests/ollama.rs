//! The Ollama client against a minimal fake Ollama HTTP server.
use bee2bee_core::ollama;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn fake_ollama() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or_default().to_string();
                let (status, body) = if line.starts_with("GET /api/version") {
                    ("200 OK", r#"{"version":"0.9.0"}"#.to_string())
                } else if line.starts_with("GET /api/tags") {
                    ("200 OK", r#"{"models":[{"name":"llama3.2:latest","size":2019393189,"modified_at":"2026-09-01T10:00:00Z","details":{"parameter_size":"3.2B","quantization_level":"Q4_K_M"}}]}"#.to_string())
                } else if line.starts_with("POST /api/pull") && req.contains("\"missing\"") {
                    (
                        "200 OK",
                        "{\"error\":\"pull model manifest: file does not exist\"}\n".to_string(),
                    )
                } else if line.starts_with("POST /api/pull") {
                    ("200 OK", "{\"status\":\"pulling manifest\"}\n{\"status\":\"downloading\",\"completed\":50,\"total\":100}\n{\"status\":\"downloading\",\"completed\":100,\"total\":100}\n{\"status\":\"success\"}\n".to_string())
                } else if line.starts_with("DELETE /api/delete") {
                    ("200 OK", String::new())
                } else {
                    ("404 Not Found", "not found".to_string())
                };
                let resp = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn lists_pulls_and_deletes_models() {
    let host = fake_ollama().await;
    assert_eq!(ollama::version(&host).await.unwrap(), "0.9.0");

    let models = ollama::list(&host).await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].name, "llama3.2:latest");
    assert_eq!(models[0].parameter_size.as_deref(), Some("3.2B"));
    assert_eq!(models[0].quantization.as_deref(), Some("Q4_K_M"));

    let mut progress = Vec::new();
    ollama::pull(&host, "llama3.2", |p| {
        progress.push((p.status, p.completed, p.total))
    })
    .await
    .unwrap();
    assert_eq!(progress.first().unwrap().0, "pulling manifest");
    assert!(progress.contains(&("downloading".into(), 50, 100)));
    assert_eq!(progress.last().unwrap().0, "success");

    let err = ollama::pull(&host, "missing", |_| {}).await.unwrap_err();
    assert!(err.to_string().contains("file does not exist"), "{err}");

    ollama::delete(&host, "llama3.2:latest").await.unwrap();
}

#[tokio::test]
async fn unreachable_ollama_is_an_error() {
    assert!(ollama::list("http://127.0.0.1:9").await.is_err());
}
