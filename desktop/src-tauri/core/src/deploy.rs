//! Local deployments: run `bee2bee serve-*` processes, keep their logs, persist their configuration.
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::{Error, Result};

const MAX_LOG_LINES: usize = 2000;
pub const BACKENDS: [&str; 4] = ["ollama", "hf", "hf_remote", "echo"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeploymentConfig {
    pub id: String,
    pub name: String,
    /// ollama | hf | hf_remote | echo
    pub backend: String,
    pub model: String,
    #[serde(default = "default_region")]
    pub region: String,
    pub port: u16,
    pub api_port: u16,
    /// Public wss:// URL if the node sits behind a proxy or tunnel.
    #[serde(default)]
    pub announce_addr: Option<String>,
    #[serde(default)]
    pub public_host: Option<String>,
    #[serde(default)]
    pub bootstrap: Option<String>,
    #[serde(default)]
    pub price: f64,
    #[serde(default)]
    pub auto_start: bool,
}

fn default_region() -> String {
    "Auto".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RunState {
    Stopped,
    Running { pid: u32, started_at: u64 },
    Exited { code: Option<i32>, at: u64 },
    Failed { error: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct DeploymentView {
    pub config: DeploymentConfig,
    pub state: RunState,
    pub home: String,
}

/// Everything a deployment needs from the app at start time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LaunchOptions {
    /// Command used to run the CLI, e.g. "bee2bee" or "python3 -m bee2bee".
    pub command: String,
    pub directory_url: Option<String>,
    pub ollama_host: Option<String>,
    /// Never persisted; passed as HF_TOKEN.
    pub hf_token: Option<String>,
}

struct Runtime {
    child: Option<Child>,
    state: RunState,
    logs: VecDeque<String>,
}

pub type LogSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub struct DeploymentManager {
    root: PathBuf,
    configs: Mutex<Vec<DeploymentConfig>>,
    runtimes: Arc<Mutex<HashMap<String, Runtime>>>,
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn split_command(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in cmd.trim().chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => quote = Some(c),
            (None, c) if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            (_, c) => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub fn validate(cfg: &DeploymentConfig) -> Result<()> {
    if !BACKENDS.contains(&cfg.backend.as_str()) {
        return Err(Error::Other(format!("unknown backend {}", cfg.backend)));
    }
    if cfg.model.trim().is_empty() || cfg.model.len() > 200 {
        return Err(Error::Other("model name is required".into()));
    }
    if cfg.name.trim().is_empty() || cfg.name.len() > 64 {
        return Err(Error::Other("name must be 1-64 characters".into()));
    }
    if cfg.port == 0 || cfg.api_port == 0 || cfg.port == cfg.api_port {
        return Err(Error::Other(
            "P2P and API ports must be different and non-zero".into(),
        ));
    }
    if !cfg
        .id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
        || cfg.id.is_empty()
    {
        return Err(Error::Other("invalid id".into()));
    }
    Ok(())
}

impl DeploymentManager {
    pub fn load(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        let file = root.join("deployments.json");
        let configs = if file.exists() {
            serde_json::from_str(&std::fs::read_to_string(&file)?)?
        } else {
            Vec::new()
        };
        Ok(Self {
            root: root.to_path_buf(),
            configs: Mutex::new(configs),
            runtimes: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn home(&self, id: &str) -> PathBuf {
        self.root.join("nodes").join(id)
    }

    async fn persist(&self, configs: &[DeploymentConfig]) -> Result<()> {
        let tmp = self.root.join("deployments.json.tmp");
        tokio::fs::write(&tmp, serde_json::to_vec_pretty(configs)?).await?;
        tokio::fs::rename(&tmp, self.root.join("deployments.json")).await?;
        Ok(())
    }

    pub async fn list(&self) -> Vec<DeploymentView> {
        let configs = self.configs.lock().await.clone();
        let runtimes = self.runtimes.lock().await;
        configs
            .into_iter()
            .map(|c| DeploymentView {
                state: runtimes
                    .get(&c.id)
                    .map(|r| r.state.clone())
                    .unwrap_or(RunState::Stopped),
                home: self.home(&c.id).display().to_string(),
                config: c,
            })
            .collect()
    }

    pub async fn save(&self, cfg: DeploymentConfig) -> Result<()> {
        validate(&cfg)?;
        let mut configs = self.configs.lock().await;
        for other in configs.iter().filter(|c| c.id != cfg.id) {
            let used = [other.port, other.api_port];
            if used.contains(&cfg.port) || used.contains(&cfg.api_port) {
                return Err(Error::Other(format!(
                    "ports are already used by \"{}\"",
                    other.name
                )));
            }
        }
        match configs.iter_mut().find(|c| c.id == cfg.id) {
            Some(existing) => *existing = cfg,
            None => configs.push(cfg),
        }
        self.persist(&configs).await
    }

    pub async fn remove(&self, id: &str) -> Result<()> {
        self.stop(id).await?;
        let mut configs = self.configs.lock().await;
        configs.retain(|c| c.id != id);
        self.persist(&configs).await?;
        self.runtimes.lock().await.remove(id);
        Ok(())
    }

    pub async fn logs(&self, id: &str) -> Vec<String> {
        self.runtimes
            .lock()
            .await
            .get(id)
            .map(|r| r.logs.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn build_command(&self, cfg: &DeploymentConfig, opts: &LaunchOptions) -> Result<Command> {
        let parts = split_command(if opts.command.trim().is_empty() {
            "bee2bee"
        } else {
            &opts.command
        });
        let (program, pre_args) = parts
            .split_first()
            .ok_or_else(|| Error::Other("empty command".into()))?;
        let mut cmd = Command::new(program);
        cmd.args(pre_args)
            .arg(format!("serve-{}", cfg.backend.replace('_', "-")))
            .args([
                "--model",
                &cfg.model,
                "--name",
                &cfg.name,
                "--region",
                &cfg.region,
            ])
            .args([
                "--port",
                &cfg.port.to_string(),
                "--api-port",
                &cfg.api_port.to_string(),
            ])
            .args(["--price", &cfg.price.to_string()]);
        if let Some(host) = cfg.public_host.as_ref().filter(|s| !s.is_empty()) {
            cmd.args(["--public-host", host]);
        }
        if let Some(b) = cfg.bootstrap.as_ref().filter(|s| !s.is_empty()) {
            cmd.args(["--bootstrap", b]);
        }
        let home = self.home(&cfg.id);
        cmd.env("BEE2BEE_HOME", &home)
            .env("BEE2BEE_LOG_JSON", "false")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(addr) = cfg.announce_addr.as_ref().filter(|s| !s.is_empty()) {
            cmd.env("BEE2BEE_ANNOUNCE_ADDR", addr);
        }
        if let Some(url) = opts.directory_url.as_ref().filter(|s| !s.is_empty()) {
            cmd.env("BEE2BEE_DIRECTORY_URL", url);
        }
        if let Some(host) = opts.ollama_host.as_ref().filter(|s| !s.is_empty()) {
            cmd.env("OLLAMA_HOST", host);
        }
        if let Some(token) = opts.hf_token.as_ref().filter(|s| !s.is_empty()) {
            cmd.env("HF_TOKEN", token);
        }
        #[cfg(windows)]
        {
            // Do not flash a console window.
            cmd.creation_flags(0x0800_0000);
        }
        #[cfg(target_os = "linux")]
        // SAFETY: prctl is async-signal-safe and runs in the forked child before exec.
        unsafe {
            cmd.pre_exec(|| {
                // Ask the kernel to stop the node if the app dies without cleaning up.
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
        Ok(cmd)
    }

    pub async fn start(&self, id: &str, opts: &LaunchOptions, sink: LogSink) -> Result<()> {
        let cfg = self
            .configs
            .lock()
            .await
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| Error::Other("unknown deployment".into()))?;
        {
            let runtimes = self.runtimes.lock().await;
            if matches!(
                runtimes.get(id).map(|r| &r.state),
                Some(RunState::Running { .. })
            ) {
                return Err(Error::Other("already running".into()));
            }
        }
        std::fs::create_dir_all(self.home(id))?;
        let mut child = match self.build_command(&cfg, opts)?.spawn() {
            Ok(c) => c,
            Err(e) => {
                let msg = if e.kind() == std::io::ErrorKind::NotFound {
                    format!("\"{}\" was not found. Install bee2bee (pip install bee2bee) or set the command in Settings.", opts.command)
                } else {
                    e.to_string()
                };
                self.runtimes.lock().await.insert(
                    id.into(),
                    Runtime {
                        child: None,
                        state: RunState::Failed { error: msg.clone() },
                        logs: VecDeque::new(),
                    },
                );
                return Err(Error::Other(msg));
            }
        };
        let pid = child.id().unwrap_or(0);
        #[cfg(windows)]
        job::assign(&child);
        for stream in [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
            child.stderr.take().map(|s| Box::new(s) as _),
        ]
        .into_iter()
        .flatten()
        {
            let runtimes = Arc::clone(&self.runtimes);
            let sink = Arc::clone(&sink);
            let id = id.to_string();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let line = strip_ansi(&line);
                    sink(&id, &line);
                    if let Some(rt) = runtimes.lock().await.get_mut(&id) {
                        rt.logs.push_back(line);
                        while rt.logs.len() > MAX_LOG_LINES {
                            rt.logs.pop_front();
                        }
                    }
                }
            });
        }
        self.runtimes.lock().await.insert(
            id.into(),
            Runtime {
                child: Some(child),
                state: RunState::Running {
                    pid,
                    started_at: now_s(),
                },
                logs: VecDeque::new(),
            },
        );
        // Watch for exit.
        let runtimes = Arc::clone(&self.runtimes);
        let id = id.to_string();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let mut guard = runtimes.lock().await;
                let Some(rt) = guard.get_mut(&id) else { return };
                let Some(child) = rt.child.as_mut() else {
                    return;
                };
                if let Ok(Some(status)) = child.try_wait() {
                    rt.state = RunState::Exited {
                        code: status.code(),
                        at: now_s(),
                    };
                    rt.child = None;
                    return;
                }
            }
        });
        Ok(())
    }

    /// Graceful stop (SIGTERM, then kill after 8 s).
    pub async fn stop(&self, id: &str) -> Result<()> {
        let child = {
            let mut runtimes = self.runtimes.lock().await;
            match runtimes.get_mut(id) {
                Some(rt) => rt.child.take(),
                None => None,
            }
        };
        let Some(mut child) = child else {
            return Ok(());
        };
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            // SAFETY: sending a signal to a child process we own.
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        #[cfg(not(unix))]
        let _ = child.start_kill();
        let status =
            match tokio::time::timeout(std::time::Duration::from_secs(8), child.wait()).await {
                Ok(s) => s.ok(),
                Err(_) => {
                    let _ = child.kill().await;
                    child.wait().await.ok()
                }
            };
        if let Some(rt) = self.runtimes.lock().await.get_mut(id) {
            rt.state = RunState::Exited {
                code: status.and_then(|s| s.code()),
                at: now_s(),
            };
        }
        Ok(())
    }

    pub async fn stop_all(&self) {
        let ids: Vec<String> = self
            .configs
            .lock()
            .await
            .iter()
            .map(|c| c.id.clone())
            .collect();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }

    pub async fn auto_start(&self, opts: &LaunchOptions, sink: LogSink) {
        let ids: Vec<String> = self
            .configs
            .lock()
            .await
            .iter()
            .filter(|c| c.auto_start)
            .map(|c| c.id.clone())
            .collect();
        for id in ids {
            let _ = self.start(&id, opts, Arc::clone(&sink)).await;
        }
    }

    /// Read the running node's local API (key from its BEE2BEE_HOME).
    pub async fn node_status(&self, id: &str) -> Result<Value> {
        let cfg = self
            .configs
            .lock()
            .await
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| Error::Other("unknown deployment".into()))?;
        let key = std::fs::read_to_string(self.home(id).join("api_key"))
            .unwrap_or_default()
            .trim()
            .to_string();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()?;
        let base = format!("http://127.0.0.1:{}", cfg.api_port);
        let home: Value = client.get(format!("{base}/")).send().await?.json().await?;
        let peers: Value = client
            .get(format!("{base}/peers"))
            .bearer_auth(&key)
            .send()
            .await?
            .json()
            .await
            .unwrap_or(Value::Null);
        Ok(serde_json::json!({ "node": home, "peers": peers }))
    }
}

/// Windows: put every node in a job object that is killed when the app's handle closes,
/// so nodes never outlive the app even if it is terminated abruptly.
#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    fn job() -> Option<&'static Job> {
        static JOB: OnceLock<Option<Job>> = OnceLock::new();
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(Job(handle))
        })
        .as_ref()
    }

    pub fn assign(child: &tokio::process::Child) {
        if let (Some(job), Some(handle)) = (job(), child.raw_handle()) {
            // SAFETY: both handles are valid for the lifetime of the call.
            unsafe {
                AssignProcessToJobObject(job.0, handle as HANDLE);
            }
        }
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(id: &str, port: u16) -> DeploymentConfig {
        DeploymentConfig {
            id: id.into(),
            name: "n".into(),
            backend: "echo".into(),
            model: "m".into(),
            region: "lab".into(),
            port,
            api_port: port + 1,
            announce_addr: None,
            public_host: None,
            bootstrap: None,
            price: 0.0,
            auto_start: false,
        }
    }

    #[test]
    fn splits_commands() {
        assert_eq!(
            split_command("python3 -m bee2bee"),
            vec!["python3", "-m", "bee2bee"]
        );
        assert_eq!(
            split_command(r#""C:\Program Files\Python\python.exe" -m bee2bee"#),
            vec![r"C:\Program Files\Python\python.exe", "-m", "bee2bee"]
        );
    }

    #[test]
    fn strips_ansi() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m done"), "ok done");
    }

    #[tokio::test]
    async fn validates_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let m = DeploymentManager::load(dir.path()).unwrap();
        m.save(cfg("a", 5000)).await.unwrap();
        assert!(m.save(cfg("b", 5001)).await.is_err(), "port clash");
        assert!(m
            .save(DeploymentConfig {
                backend: "evil".into(),
                ..cfg("c", 6000)
            })
            .await
            .is_err());
        assert!(m
            .save(DeploymentConfig {
                id: "../x".into(),
                ..cfg("x", 6100)
            })
            .await
            .is_err());
        let again = DeploymentManager::load(dir.path()).unwrap();
        assert_eq!(again.list().await.len(), 1);
        again.remove("a").await.unwrap();
        assert!(again.list().await.is_empty());
    }

    #[test]
    fn builds_cli_invocation() {
        let dir = tempfile::tempdir().unwrap();
        let m = DeploymentManager::load(dir.path()).unwrap();
        let mut c = cfg("a", 5000);
        c.backend = "hf_remote".into();
        let cmd = m
            .build_command(
                &c,
                &LaunchOptions {
                    command: "python3 -m bee2bee".into(),
                    hf_token: Some("hf_x".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let std = cmd.as_std();
        assert_eq!(std.get_program(), "python3");
        let args: Vec<_> = std
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(&args[..3], ["-m", "bee2bee", "serve-hf-remote"]);
        assert!(args.windows(2).any(|w| w == ["--port", "5000"]));
        let envs: Vec<_> = std
            .get_envs()
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        assert!(
            envs.contains(&"HF_TOKEN".to_string()) && envs.contains(&"BEE2BEE_HOME".to_string())
        );
    }
}
