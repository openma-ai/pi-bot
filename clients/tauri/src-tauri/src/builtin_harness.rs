//! The desktop app owns only the child it spawned. External local runtimes are
//! attached by transport.rs and are never stopped by this lifecycle manager.
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}};
use crate::transport::{Endpoint, Profile};

pub const PROFILE_ID: &str = "builtin";
pub fn profile() -> Profile {
    let mut p = Profile::local(PROFILE_ID, "本机", "");
    p.mode = "builtin".into();
    p
}

struct Inner {
    state: &'static str,
    error: Option<String>,
    #[cfg(not(any(target_os="ios", target_os="android")))]
    child: Option<std::process::Child>,
}

pub struct Harness {
    resources: PathBuf,
    home: PathBuf,
    available: bool,
    inner: Mutex<Inner>,
    operation: tokio::sync::Mutex<()>,
}

impl Harness {
    pub fn new(resource_dir: PathBuf, app_data: PathBuf) -> Arc<Self> {
        let mut resources = resource_dir.join("harness");
        // cargo/tauri dev has no .app resource copy. Use the same offline staging
        // artifact as production, never the repo's loose source/dependency tree.
        #[cfg(debug_assertions)]
        if !resources.join("manifest.json").is_file() {
            resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.harness-build");
        }
        let manifest = std::fs::read(resources.join("manifest.json")).ok()
            .and_then(|data| serde_json::from_slice::<Value>(&data).ok());
        let available = cfg!(all(target_os="macos", target_arch="aarch64"))
            && manifest.as_ref().is_some_and(|m| m["format"] == 1 && m["platform"] == "darwin" && m["arch"] == "arm64")
            && resources.join("bin/node").is_file() && resources.join("launcher.mjs").is_file();
        Arc::new(Self {
            resources, home: app_data.join("harness"), available,
            inner: Mutex::new(Inner {
                state: if available {"stopped"} else {"unavailable"}, error: None,
                #[cfg(not(any(target_os="ios", target_os="android")))]
                child: None,
            }),
            operation: tokio::sync::Mutex::new(()),
        })
    }

    pub fn status(&self) -> Value {
        let mut inner = self.inner.lock().unwrap();
        #[cfg(not(any(target_os="ios", target_os="android")))]
        Self::refresh(&mut inner);
        let error = inner.error.clone().or_else(|| {
            if !self.available && cfg!(not(any(target_os="ios", target_os="android"))) {
                Some("此应用未包含适用于当前平台的本机引擎，请使用完整桌面构建或连接远端".into())
            } else { None }
        });
        json!({"supported":cfg!(not(any(target_os="ios", target_os="android"))),"available":self.available,"state":inner.state,"error":error})
    }

    #[cfg(not(any(target_os="ios", target_os="android")))]
    fn refresh(inner: &mut Inner) {
        if let Some(child) = inner.child.as_mut() {
            if let Ok(Some(exit)) = child.try_wait() {
                inner.child = None;
                inner.state = "error";
                inner.error = Some(format!("本机引擎已退出（{}），可以重新启动", exit.code().map(|n| n.to_string()).unwrap_or_else(|| "signal".into())));
            }
        }
    }

    #[cfg(not(any(target_os="ios", target_os="android")))]
    pub async fn connect(&self, epoch: Arc<AtomicU64>, version: u64) -> Result<Endpoint, String> {
        use std::{fs::OpenOptions, process::{Command, Stdio}, time::{Duration, Instant}};
        let _operation = self.operation.lock().await;
        if !self.available { return Err("此桌面构建未包含本机引擎，请连接远端或使用完整构建".into()); }
        if epoch.load(Ordering::SeqCst) != version { return Err("连接已取消".into()); }
        let data_dir = self.home.join("data");
        let local = Profile::local(PROFILE_ID, "本机", &data_dir.to_string_lossy());
        let running = {
            let mut inner = self.inner.lock().unwrap();
            Self::refresh(&mut inner);
            inner.child.is_some() && inner.state == "running"
        };
        if running { return crate::transport::connect(&local).await; }
        for path in [&self.home, &data_dir, &self.home.join("pi"), &self.home.join("workspace"), &self.home.join("tmp")] {
            std::fs::create_dir_all(path).map_err(|_| "无法创建本机引擎的独立数据目录")?;
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|_| "无法保护本机引擎数据目录")?;
            }
        }
        let mut log = OpenOptions::new();
        log.create(true).write(true).truncate(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; log.mode(0o600); }
        let log = log.open(self.home.join("startup.log")).map_err(|_| "无法创建引擎启动日志")?;
        let node = self.resources.join("bin/node");
        let mut command = Command::new(&node);
        command.arg("--import").arg(self.resources.join("node_modules/tsx/dist/loader.mjs"))
            .arg(self.resources.join("launcher.mjs"))
            .args(["daemon", "--data-dir"]).arg(&data_dir)
            .arg("--pi-dir").arg(self.home.join("pi"))
            .args(["--listen", "http://127.0.0.1:0", "--drain-timeout", "3000", "--approval-required"])
            // No shell, inherited API keys, NODE_OPTIONS, proxy, or auth directory.
            .env_clear()
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("TMPDIR", self.home.join("tmp"))
            .env("XDG_CONFIG_HOME", self.home.join("config"))
            .env("XDG_DATA_HOME", self.home.join("share"))
            .env("PATH", format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", self.resources.join("bin").display()))
            .env("LANG", "en_US.UTF-8")
            .env("NODE_ENV", "production")
            .env("TSX_TSCONFIG_PATH", self.resources.join("tsconfig.json"))
            .current_dir(self.home.join("workspace"))
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::from(log));
        let child = command.spawn().map_err(|_| "无法启动随应用提供的本机引擎")?;
        let pid = child.id();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.child = Some(child);
            inner.state = "starting";
            inner.error = None;
        }
        let deadline = Instant::now() + Duration::from_secs(35);
        loop {
            if epoch.load(Ordering::SeqCst) != version {
                self.stop_owned().await?;
                return Err("连接已取消".into());
            }
            {
                let mut inner = self.inner.lock().unwrap();
                Self::refresh(&mut inner);
                if inner.child.is_none() { return Err(inner.error.clone().unwrap_or_else(|| "本机引擎启动失败".into())); }
            }
            // Never attach to stale discovery from a previous or foreign process.
            let owned = std::fs::read(data_dir.join("daemon.json")).ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .is_some_and(|d| d["pid"].as_u64() == Some(pid as u64));
            if owned {
                if let Ok(endpoint) = crate::transport::connect(&local).await {
                    self.inner.lock().unwrap().state = "running";
                    return Ok(endpoint);
                }
            }
            if Instant::now() >= deadline {
                self.stop_owned().await?;
                let error = "本机引擎启动超时，请重试或连接远端".to_string();
                let mut inner = self.inner.lock().unwrap();
                inner.state = "error";
                inner.error = Some(error.clone());
                return Err(error);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[cfg(any(target_os="ios", target_os="android"))]
    pub async fn connect(&self, _epoch: Arc<AtomicU64>, _version: u64) -> Result<Endpoint, String> {
        Err("此平台仅支持连接远端引擎".into())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        self.stop_owned().await
    }

    #[cfg(not(any(target_os="ios", target_os="android")))]
    async fn stop_owned(&self) -> Result<(), String> {
        use std::time::{Duration, Instant};
        let child = {
            let mut inner = self.inner.lock().unwrap();
            inner.state = if self.available {"stopping"} else {"unavailable"};
            inner.child.take()
        };
        if let Some(mut child) = child {
            // Closing this owned pipe requests graceful shutdown. No PID from a
            // discovery/lease file is ever signalled, so unrelated daemons survive.
            drop(child.stdin.take());
            let deadline = Instant::now() + Duration::from_secs(9);
            loop {
                if child.try_wait().map_err(|_| "无法确认本机引擎停止状态")?.is_some() { break; }
                if Instant::now() >= deadline {
                    child.kill().map_err(|_| "无法停止应用拥有的引擎进程")?;
                    child.wait().map_err(|_| "无法回收本机引擎进程")?;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        let mut inner = self.inner.lock().unwrap();
        inner.state = if self.available {"stopped"} else {"unavailable"};
        inner.error = None;
        Ok(())
    }

    #[cfg(any(target_os="ios", target_os="android"))]
    async fn stop_owned(&self) -> Result<(), String> { Ok(()) }
}

impl Drop for Harness {
    fn drop(&mut self) {
        // During an abnormal native exit the OS also closes the pipe. The launcher
        // has the same bounded graceful shutdown path even if this Drop cannot run.
        #[cfg(not(any(target_os="ios", target_os="android")))]
        if let Ok(inner) = self.inner.get_mut() {
            if let Some(mut child) = inner.child.take() { drop(child.stdin.take()); }
        }
    }
}

#[cfg(all(test, target_os="macos", target_arch="aarch64"))]
mod tests {
    use super::*;

    #[test]
    fn builtin_profile_cannot_select_paths_or_network_targets() {
        let mut p = profile();
        assert!(p.validate().is_ok());
        p.data_dir = "/tmp/foreign-runtime".into();
        assert!(p.validate().is_err());
        p = profile();
        p.url = Some("http://127.0.0.1:4317".into());
        assert!(p.validate().is_err());
        p = profile();
        p.id = "other".into();
        assert!(p.validate().is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "Requires prepared real harness and isolated loopback listeners"]
    async fn real_bundled_harness_lifecycle() {
        tokio::spawn(async {
        let root = std::env::temp_dir().join(format!("pibo-native-harness-{}", uuid::Uuid::new_v4())).join("Application Support/Pibo Development App Test");
        let resources = std::env::var_os("PIBOT_HARNESS_TEST_RESOURCES").map(PathBuf::from).unwrap_or_default();
        let manager = Harness::new(resources.clone(), root.join("owner"));
        let other = Harness::new(resources, root.join("independent"));
        assert_eq!(manager.status()["available"], true);
        let epoch = Arc::new(AtomicU64::new(1));
        let first = manager.connect(epoch.clone(), 1).await.unwrap();
        assert_eq!(manager.status()["state"], "running");
        let repeated = manager.connect(epoch.clone(), 1).await.unwrap();
        assert_eq!(first.base, repeated.base, "Repeated start reuses the child");
        let independent = other.connect(epoch.clone(), 1).await.unwrap();
        manager.stop().await.unwrap();
        manager.stop().await.unwrap();
        assert_eq!(manager.status()["state"], "stopped");
        assert!(crate::transport::ready(&independent).await.is_ok());
        let restarted = manager.connect(epoch.clone(), 1).await.unwrap();
        assert!(crate::transport::ready(&restarted).await.is_ok());
        {
            let mut inner = manager.inner.lock().unwrap();
            inner.child.as_mut().unwrap().kill().unwrap();
            inner.child.as_mut().unwrap().wait().unwrap();
        }
        assert_eq!(manager.status()["state"], "error");
        let recovered = manager.connect(epoch.clone(), 1).await.unwrap();
        assert!(crate::transport::ready(&recovered).await.is_ok());
        manager.stop().await.unwrap();
        // Cancellation during startup must clean up exactly the just-started child.
        epoch.store(2, Ordering::SeqCst);
        let owned = manager.clone();
        let cancel_epoch = epoch.clone();
        let starting = tokio::spawn(async move { owned.connect(cancel_epoch, 2).await });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        epoch.store(3, Ordering::SeqCst);
        assert!(starting.await.unwrap().is_err());
        assert_eq!(manager.status()["state"], "stopped");
        other.stop().await.unwrap();
        }).await.unwrap();
    }
}
