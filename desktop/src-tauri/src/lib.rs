//! Tauri shell: exposes the bee2bee-core features to the React UI as commands.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bee2bee_core::deploy::{DeploymentConfig, DeploymentManager, DeploymentView, LaunchOptions};
use bee2bee_core::identity::Identity;
use bee2bee_core::mesh::{self, ChatDone, ChatRequest, NodeInfo};
use bee2bee_core::ollama::{self, OllamaModel, PullProgress};
use bee2bee_core::{Error, Result};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

struct AppState {
    identity: Arc<Identity>,
    deployments: Arc<DeploymentManager>,
    chats: Mutex<HashMap<String, CancellationToken>>,
    data_dir: PathBuf,
}

#[derive(Serialize)]
struct AppInfo {
    peer_id: String,
    pubkey: String,
    version: String,
    data_dir: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ChatEvent {
    Text { text: String },
}

#[derive(Clone, Serialize)]
struct DeployLog {
    id: String,
    line: String,
}

#[derive(Serialize, Default)]
struct Check {
    ok: bool,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct EnvStatus {
    bee2bee: Check,
    ollama: Check,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        peer_id: state.identity.peer_id.clone(),
        pubkey: state.identity.pubkey.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: state.data_dir.display().to_string(),
    }
}

#[tauri::command]
async fn node_probe(state: State<'_, AppState>, addr: String) -> Result<NodeInfo> {
    mesh::probe(&state.identity, &addr).await
}

#[tauri::command]
async fn chat_start(
    state: State<'_, AppState>,
    request_id: String,
    request: ChatRequest,
    on_event: Channel<ChatEvent>,
) -> Result<ChatDone> {
    let token = CancellationToken::new();
    state
        .chats
        .lock()
        .await
        .insert(request_id.clone(), token.clone());
    let result = mesh::chat(&state.identity, &request, token, |t| {
        let _ = on_event.send(ChatEvent::Text {
            text: t.to_string(),
        });
    })
    .await;
    state.chats.lock().await.remove(&request_id);
    result
}

#[tauri::command]
async fn chat_cancel(state: State<'_, AppState>, request_id: String) -> Result<()> {
    if let Some(token) = state.chats.lock().await.remove(&request_id) {
        token.cancel();
    }
    Ok(())
}

async fn run_capture(program: &str, args: &[String]) -> std::result::Result<String, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    match tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await {
        Err(_) => Err("timed out".into()),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("\"{program}\" not found"))
        }
        Ok(Err(e)) => Err(e.to_string()),
        Ok(Ok(out)) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        Ok(Ok(out)) => Err(String::from_utf8_lossy(&out.stderr)
            .lines()
            .last()
            .unwrap_or("failed")
            .to_string()),
    }
}

#[tauri::command]
async fn env_check(command: String, ollama_host: String) -> EnvStatus {
    let parts = bee2bee_core::deploy::split_command(if command.trim().is_empty() {
        "bee2bee"
    } else {
        &command
    });
    let bee2bee = match parts.split_first() {
        None => Check {
            error: Some("empty command".into()),
            ..Default::default()
        },
        Some((program, pre)) => {
            let mut args = pre.to_vec();
            args.push("--version".into());
            match run_capture(program, &args).await {
                Ok(v) => Check {
                    ok: true,
                    version: Some(v.replace("bee2bee, version ", "")),
                    error: None,
                },
                Err(e) => Check {
                    ok: false,
                    version: None,
                    error: Some(e),
                },
            }
        }
    };
    let ollama = match ollama::version(&ollama_host).await {
        Ok(v) => Check {
            ok: true,
            version: Some(v),
            error: None,
        },
        Err(e) => Check {
            ok: false,
            version: None,
            error: Some(e.to_string()),
        },
    };
    EnvStatus { bee2bee, ollama }
}

/// `python -m pip install --upgrade bee2bee`, streaming output lines.
#[tauri::command]
async fn bee2bee_install(python: String, on_line: Channel<String>) -> Result<()> {
    let python = if python.trim().is_empty() {
        "python3".to_string()
    } else {
        python
    };
    let mut cmd = tokio::process::Command::new(&python);
    cmd.args(["-m", "pip", "install", "--upgrade", "bee2bee"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::Other(format!("cannot run {python}: {e}")))?;
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let forward = |stream: Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>>,
                   ch: Channel<String>| async move {
        if let Some(s) = stream {
            let mut lines = BufReader::new(s).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = ch.send(l);
            }
        }
    };
    let a = tokio::spawn(forward(out.map(|s| Box::new(s) as _), on_line.clone()));
    let b = tokio::spawn(forward(err.map(|s| Box::new(s) as _), on_line));
    let status = child.wait().await?;
    let _ = tokio::join!(a, b);
    if status.success() {
        Ok(())
    } else {
        Err(Error::Other(format!("pip exited with {status}")))
    }
}

#[tauri::command]
async fn ollama_list(host: String) -> Result<Vec<OllamaModel>> {
    ollama::list(&host).await
}

#[tauri::command]
async fn ollama_pull(
    host: String,
    model: String,
    on_progress: Channel<PullProgress>,
) -> Result<()> {
    ollama::pull(&host, &model, |p| {
        let _ = on_progress.send(p);
    })
    .await
}

#[tauri::command]
async fn ollama_delete(host: String, model: String) -> Result<()> {
    ollama::delete(&host, &model).await
}

#[tauri::command]
async fn deploy_list(state: State<'_, AppState>) -> Result<Vec<DeploymentView>> {
    Ok(state.deployments.list().await)
}

#[tauri::command]
async fn deploy_save(state: State<'_, AppState>, config: DeploymentConfig) -> Result<()> {
    state.deployments.save(config).await
}

#[tauri::command]
async fn deploy_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    state.deployments.remove(&id).await
}

fn log_sink(app: &AppHandle) -> bee2bee_core::deploy::LogSink {
    let app = app.clone();
    Arc::new(move |id: &str, line: &str| {
        let _ = app.emit(
            "deploy-log",
            DeployLog {
                id: id.to_string(),
                line: line.to_string(),
            },
        );
    })
}

#[tauri::command]
async fn deploy_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    options: LaunchOptions,
) -> Result<()> {
    state.deployments.start(&id, &options, log_sink(&app)).await
}

#[tauri::command]
async fn deploy_stop(state: State<'_, AppState>, id: String) -> Result<()> {
    state.deployments.stop(&id).await
}

#[tauri::command]
async fn deploy_logs(state: State<'_, AppState>, id: String) -> Result<Vec<String>> {
    Ok(state.deployments.logs(&id).await)
}

#[tauri::command]
async fn deploy_status(state: State<'_, AppState>, id: String) -> Result<serde_json::Value> {
    state.deployments.node_status(&id).await
}

/// Stop local nodes before exiting when the app is terminated by a signal
/// (logout, `kill`, Ctrl+C in a terminal), not only when the window closes.
#[cfg(unix)]
fn watch_termination_signals(app: AppHandle, deployments: Arc<DeploymentManager>) {
    use tokio::signal::unix::{signal, SignalKind};
    tauri::async_runtime::spawn(async move {
        let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
            signal(SignalKind::hangup()),
        ) else {
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
            _ = hup.recv() => {}
        }
        deployments.stop_all().await;
        app.exit(0);
    });
}

#[cfg(not(unix))]
fn watch_termination_signals(_app: AppHandle, _deployments: Arc<DeploymentManager>) {
    // Windows: nodes run inside a kill-on-close job object (see bee2bee-core deploy.rs).
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let identity = Identity::load_or_create(&data_dir.join("identity.pem"))
                .map_err(|e| e.to_string())?;
            let deployments = DeploymentManager::load(&data_dir.join("deployments"))
                .map_err(|e| e.to_string())?;
            let deployments = Arc::new(deployments);
            app.manage(AppState {
                identity: Arc::new(identity),
                deployments: Arc::clone(&deployments),
                chats: Mutex::new(HashMap::new()),
                data_dir,
            });
            watch_termination_signals(app.handle().clone(), deployments);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            node_probe,
            chat_start,
            chat_cancel,
            env_check,
            bee2bee_install,
            ollama_list,
            ollama_pull,
            ollama_delete,
            deploy_list,
            deploy_save,
            deploy_remove,
            deploy_start,
            deploy_stop,
            deploy_logs,
            deploy_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Bee2Bee app");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // Stop local nodes cleanly when the app quits.
            let deployments = Arc::clone(&handle.state::<AppState>().deployments);
            tauri::async_runtime::block_on(deployments.stop_all());
        }
    });
}
