//! Official libtailscale C ABI: private userspace node, no TUN or system proxy.
//! Authentication is explicit; no node starts when the application launches.
#[cfg(feature = "embedded-tailscale")]
mod native {
    use std::{
        ffi::CString,
        os::fd::{FromRawFd, OwnedFd},
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex, OnceLock,
        },
    };
    unsafe extern "C" {
        fn tailscale_new() -> i32;
        fn tailscale_set_dir(sd: i32, path: *const std::ffi::c_char) -> i32;
        fn tailscale_set_hostname(sd: i32, name: *const std::ffi::c_char) -> i32;
        fn tailscale_set_authkey(sd: i32, key: *const std::ffi::c_char) -> i32;
        fn tailscale_set_ephemeral(sd: i32, value: i32) -> i32;
        fn tailscale_set_logfd(sd: i32, fd: i32) -> i32;
        fn tailscale_dial(
            sd: i32,
            network: *const std::ffi::c_char,
            address: *const std::ffi::c_char,
            out: *mut i32,
        ) -> i32;
        fn tailscale_close(sd: i32) -> i32;
    }
    pub struct Node {
        sd: i32,
        dir: PathBuf,
        closed: AtomicBool,
        dialed: AtomicBool,
    }
    impl Node {
        fn close(&self) {
            if !self.closed.swap(true, Ordering::SeqCst) {
                unsafe {
                    tailscale_close(self.sd);
                }
            }
        }
    }
    impl Drop for Node {
        fn drop(&mut self) {
            self.close();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn current() -> &'static Mutex<Option<Arc<Node>>> {
        static NODE: OnceLock<Mutex<Option<Arc<Node>>>> = OnceLock::new();
        NODE.get_or_init(Default::default)
    }
    pub fn start(key: &str) -> Result<(), String> {
        if !key.starts_with("tskey-auth-") || key.len() > 1024 {
            return Err("请输入有效 Tailscale auth key".into());
        }
        let mut slot = current().lock().map_err(|_| "Node lock unavailable")?;
        if slot.is_some() {
            return Err("请先停止当前内嵌节点".into());
        }
        let key = CString::new(key).map_err(|_| "Invalid auth key")?;
        let dir = std::env::temp_dir().join(format!("pibo-tailnet-{}", uuid::Uuid::new_v4()));
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|_| "Cannot create temporary node directory")?;
        let node = Arc::new(Node {
            sd: unsafe { tailscale_new() },
            dir,
            closed: AtomicBool::new(false),
            dialed: AtomicBool::new(false),
        });
        let path = CString::new(node.dir.to_string_lossy().as_bytes())
            .map_err(|_| "Invalid node directory")?;
        // Discard SDK output: login URLs and device metadata must not enter logs.
        let results = unsafe {
            [
                tailscale_set_logfd(node.sd, -1),
                tailscale_set_dir(node.sd, path.as_ptr()),
                tailscale_set_hostname(node.sd, c"pibo-embedded".as_ptr()),
                tailscale_set_ephemeral(node.sd, 1),
                tailscale_set_authkey(node.sd, key.as_ptr()),
            ]
        };
        if results.iter().any(|r| *r != 0) {
            return Err("Cannot configure embedded node".into());
        }
        *slot = Some(node);
        Ok(())
    }
    pub fn state() -> &'static str {
        match current().lock() {
            Ok(slot) => match slot.as_ref() {
                None => "notPrepared",
                Some(node) if node.closed.load(Ordering::SeqCst) => "stopped",
                Some(node) if node.dialed.load(Ordering::SeqCst) => "dialed",
                Some(_) => "prepared",
            },
            Err(_) => "stopped",
        }
    }
    pub fn stop() {
        if let Ok(mut slot) = current().lock() {
            if let Some(node) = slot.take() {
                node.close();
            }
        }
    }
    #[cfg(debug_assertions)]
    pub fn browser_test_start() -> Result<(), String> {
        start("tskey-auth-local-placeholder")?;
        let node = current()
            .lock()
            .map_err(|_| "Node lock unavailable")?
            .clone()
            .ok_or("Missing node")?;
        unsafe extern "C" {
            fn tailscale_start(sd: i32) -> i32;
        }
        // Remove the placeholder before starting; interactive official login only.
        if unsafe { tailscale_set_authkey(node.sd, c"".as_ptr()) } != 0
            || unsafe { tailscale_set_hostname(node.sd, c"pibo-ios-simulator-test".as_ptr()) } != 0
            || unsafe { tailscale_start(node.sd) } != 0
        {
            stop();
            return Err("Cannot start temporary browser-login node".into());
        }
        Ok(())
    }
    #[cfg(debug_assertions)]
    pub fn browser_test_status() -> Result<serde_json::Value, String> {
        unsafe extern "C" {
            fn tailscale_status_json(sd: i32, out: *mut *mut std::ffi::c_char) -> i32;
            fn free(ptr: *mut std::ffi::c_void);
        }
        let node = current()
            .lock()
            .map_err(|_| "Node lock unavailable")?
            .clone()
            .ok_or("Missing node")?;
        let mut out = std::ptr::null_mut();
        if unsafe { tailscale_status_json(node.sd, &mut out) } != 0 || out.is_null() {
            return Err("Status unavailable".into());
        }
        let parsed = serde_json::from_slice::<serde_json::Value>(
            unsafe { std::ffi::CStr::from_ptr(out) }.to_bytes(),
        );
        unsafe {
            free(out.cast());
        }
        let status = parsed.map_err(|_| "Invalid SDK status")?;
        Ok(
            serde_json::json!({"backendState":status["BackendState"],"authURL":status["AuthURL"],"health":status["Health"],"ips":status["TailscaleIPs"],"hostname":"pibo-ios-simulator-test","ephemeral":true}),
        )
    }
    /// Local initialization only: never invokes start/up/dial or persists identity.
    #[cfg(debug_assertions)]
    pub fn local_probe() -> Result<serde_json::Value, String> {
        if state() != "notPrepared" {
            return Err("Probe requires an unused node".into());
        }
        let mut cycles = Vec::new();
        for _ in 0..3 {
            start("tskey-auth-local-init-only")?;
            let node = current()
                .lock()
                .map_err(|_| "Node lock unavailable")?
                .take()
                .ok_or("Missing node")?;
            let dir = node.dir.clone();
            let empty = std::fs::read_dir(&dir)
                .map_err(|e| e.to_string())?
                .next()
                .is_none();
            let configured = !node.closed.load(Ordering::SeqCst);
            let close_code = unsafe { tailscale_close(node.sd) };
            node.closed.store(true, Ordering::SeqCst);
            drop(node);
            let removed = !dir.exists();
            if !empty || !configured || close_code != 0 || !removed {
                return Err(format!(
                    "Lifecycle failed: empty={empty}, close={close_code}, removed={removed}"
                ));
            }
            cycles.push(serde_json::json!({"configured":configured,"stateDirectoryEmpty":empty,"closeCode":close_code,"temporaryDirectoryRemoved":removed}));
        }
        Ok(serde_json::json!({"cycles":cycles,"finalState":state(),"networkStarted":false}))
    }
    pub async fn dial(host: &str, port: u16) -> Result<tokio::net::UnixStream, String> {
        let node = current()
            .lock()
            .map_err(|_| "Node lock unavailable")?
            .clone()
            .ok_or("请先授权并准备内嵌节点")?;
        if node.closed.load(Ordering::SeqCst) {
            return Err("内嵌节点已停止，请重新授权".into());
        }
        // Cancellation closes a pending blocking dial; no orphan connect worker.
        struct PendingDial {
            node: Arc<Node>,
            armed: bool,
        }
        impl Drop for PendingDial {
            fn drop(&mut self) {
                if self.armed {
                    self.node.close();
                }
            }
        }
        let mut pending = PendingDial {
            node: node.clone(),
            armed: true,
        };
        let address =
            CString::new(format!("{host}:{port}")).map_err(|_| "Invalid Tailnet address")?;
        let owned = node.clone();
        let task = tokio::task::spawn_blocking(move || {
            let mut fd = -1;
            if unsafe { tailscale_dial(owned.sd, c"tcp".as_ptr(), address.as_ptr(), &mut fd) } != 0
                || fd < 0
            {
                return Err("Tailnet 连接失败：检查授权、ACL、地址及当前网络".to_string());
            }
            // libtailscale returns one end of a Unix SOCK_STREAM socketpair.
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        });
        let fd = match tokio::time::timeout(std::time::Duration::from_secs(10), task).await {
            Ok(result) => result.map_err(|_| "Tailnet worker failed")??,
            Err(_) => {
                node.close();
                return Err("Tailnet 连接超时；节点已停止，请重新授权".into());
            }
        };
        pending.armed = false;
        node.dialed.store(true, Ordering::SeqCst);
        let stream = std::os::unix::net::UnixStream::from(fd);
        stream
            .set_nonblocking(true)
            .map_err(|_| "Cannot configure Tailnet stream")?;
        tokio::net::UnixStream::from_std(stream).map_err(|_| "Cannot attach Tailnet stream".into())
    }
}
#[cfg(feature = "embedded-tailscale")]
pub use native::{dial, start, state, stop};
#[cfg(not(feature = "embedded-tailscale"))]
pub fn start(_: &str) -> Result<(), String> {
    Err("此构建未启用 embedded-tailscale；请安装启用内嵌库的 Apple 构建".into())
}
#[cfg(not(feature = "embedded-tailscale"))]
pub fn stop() {}
#[cfg(all(not(feature = "embedded-tailscale"), unix))]
pub async fn dial(_: &str, _: u16) -> Result<tokio::net::UnixStream, String> {
    Err("此构建未启用 embedded-tailscale".into())
}

#[cfg(all(not(feature = "embedded-tailscale"), not(unix)))]
pub async fn dial(_: &str, _: u16) -> Result<tokio::io::DuplexStream, String> {
    Err("Embedded Tailscale requires an Apple build".into())
}
#[cfg(test)]
mod tests {
    #[test]
    fn startup_requires_explicit_valid_auth_key() {
        assert!(super::start("").is_err());
        assert!(super::start("not-an-auth-key").is_err());
    }
}

#[cfg(not(feature = "embedded-tailscale"))]
pub fn state() -> &'static str {
    "unavailable"
}

#[cfg(all(feature = "embedded-tailscale", debug_assertions))]
pub use native::local_probe;

#[cfg(all(feature = "embedded-tailscale", debug_assertions))]
pub use native::{browser_test_start, browser_test_status};
