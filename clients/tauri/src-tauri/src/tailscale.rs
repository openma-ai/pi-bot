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
        fn pibo_tailscale_use_system_routing();
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
        started: AtomicBool,
        persistent: AtomicBool,
        saved: Mutex<Vec<u8>>,
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
            use zeroize::Zeroize;
            if let Ok(saved) = self.saved.get_mut() {
                saved.zeroize();
            }
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
        configure(key, None)
    }
    fn configure(key: &str, reuse: Option<PathBuf>) -> Result<(), String> {
        let mut slot = current().lock().map_err(|_| "Node lock unavailable")?;
        if slot.is_some() {
            return Err("请先停止当前内嵌节点".into());
        }
        let key = CString::new(key).map_err(|_| "Invalid auth key")?;
        let existing = reuse.is_some();
        let dir = reuse.unwrap_or_else(|| {
            std::env::temp_dir().join(format!("pibo-tailnet-{}", uuid::Uuid::new_v4()))
        });
        use std::os::unix::fs::DirBuilderExt;
        if existing {
            let metadata =
                std::fs::symlink_metadata(&dir).map_err(|_| "Missing test identity directory")?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("Invalid test directory".into());
            }
        } else {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .map_err(|_| "Cannot create temporary node directory")?;
        }
        #[cfg(any(target_os = "ios", target_os = "macos"))]
        {
            unsafe extern "C" {
                fn pibo_protect_node_directory(path: *const std::ffi::c_char) -> i32;
            }
            let path =
                CString::new(dir.to_string_lossy().as_bytes()).map_err(|_| "Invalid node path")?;
            if unsafe { pibo_protect_node_directory(path.as_ptr()) } != 0 {
                let _ = std::fs::remove_dir_all(&dir);
                return Err("无法保护网络工作目录".into());
            }
        }
        unsafe {
            pibo_tailscale_use_system_routing();
        }
        let node = Arc::new(Node {
            sd: unsafe { tailscale_new() },
            dir,
            closed: AtomicBool::new(false),
            dialed: AtomicBool::new(false),
            started: AtomicBool::new(false),
            persistent: AtomicBool::new(false),
            saved: Mutex::new(Vec::new()),
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
    // Explicit product action. Restore the device-only Keychain identity; no test flags or deadline.
    pub fn browser_start() -> Result<(), String> {
        static START: Mutex<()> = Mutex::new(());
        let _start = START.lock().map_err(|_| "Login lock unavailable")?;
        let result = browser_start_impl();
        if result.is_err() {
            stop();
        }
        result
    }
    fn browser_start_impl() -> Result<(), String> {
        if current()
            .lock()
            .map_err(|_| "Node lock unavailable")?
            .as_ref()
            .is_some_and(|n| !n.closed.load(Ordering::SeqCst))
        {
            return Ok(());
        }
        configure("", None)?;
        let node = current()
            .lock()
            .map_err(|_| "Node lock unavailable")?
            .clone()
            .ok_or("Missing node")?;
        unsafe extern "C" {
            fn tailscale_start(sd: i32) -> i32;
        }
        node.persistent.store(true, Ordering::SeqCst);
        if let Some(bytes) = crate::tailnet_secrets::load("node-state-v1")? {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            if bytes.len() > 1024 * 1024 {
                stop();
                return Err("保存的网络身份过大".into());
            }
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(node.dir.join("tailscaled.state"))
                .and_then(|mut f| f.write_all(&bytes))
                .map_err(|_| "无法恢复网络身份")?;
            *node.saved.lock().map_err(|_| "Identity lock unavailable")? = bytes;
        }
        if unsafe { tailscale_set_ephemeral(node.sd, 0) } != 0 {
            stop();
            return Err("无法配置持久网络身份".into());
        }
        let hostname = CString::new("pibo").unwrap();
        if unsafe { tailscale_set_hostname(node.sd, hostname.as_ptr()) } != 0
            || unsafe { tailscale_start(node.sd) } != 0
        {
            stop();
            return Err("无法启动应用内网络，请重试".into());
        }
        node.started.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn sdk_status(node: &Node) -> Result<serde_json::Value, String> {
        unsafe extern "C" {
            fn tailscale_status_json(sd: i32, out: *mut *mut std::ffi::c_char) -> i32;
            fn free(ptr: *mut std::ffi::c_void);
        }
        let mut out = std::ptr::null_mut();
        if unsafe { tailscale_status_json(node.sd, &mut out) } != 0 || out.is_null() {
            return Err("网络状态暂不可用，请重试".into());
        }
        let parsed = serde_json::from_slice::<serde_json::Value>(
            unsafe { std::ffi::CStr::from_ptr(out) }.to_bytes(),
        );
        unsafe {
            free(out.cast());
        }
        parsed.map_err(|_| "网络状态暂不可用".into())
    }
    pub fn status() -> Result<serde_json::Value, String> {
        let node = current()
            .lock()
            .map_err(|_| "Node lock unavailable")?
            .clone();
        let Some(node) = node else {
            return Ok(serde_json::json!({"backendState":"NotPrepared","authURL":null,"ips":[]}));
        };
        if node.closed.load(Ordering::SeqCst) {
            return Ok(serde_json::json!({"backendState":"Stopped","authURL":null,"ips":[]}));
        }
        // LocalClient() starts tsnet implicitly: status must not initiate registration.
        if !node.started.load(Ordering::SeqCst) {
            return Ok(serde_json::json!({"backendState":"Prepared","authURL":null,"ips":[]}));
        }
        let status = sdk_status(&node)?;
        let slot = current().lock().map_err(|_| "Node lock unavailable")?;
        if !slot
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &node))
            || node.closed.load(Ordering::SeqCst)
        {
            return Ok(
                serde_json::json!({"backendState":"Stopped","authURL":null,"ips":[],"peers":[]}),
            );
        }
        if status["BackendState"] == "Running" && node.persistent.load(Ordering::SeqCst) {
            if let Ok(bytes) = std::fs::read(node.dir.join("tailscaled.state")) {
                if bytes.len() > 1024 * 1024 {
                    return Err("网络身份过大，无法安全保存".into());
                }
                let mut saved = node.saved.lock().map_err(|_| "Identity lock unavailable")?;
                if *saved != bytes {
                    crate::tailnet_secrets::save("node-state-v1", &bytes)?;
                    *saved = bytes;
                }
            }
        }
        // Return only the minimum device-picker fields; no raw SDK diagnostics or keys.
        let auth_url = status["AuthURL"]
            .as_str()
            .filter(|s| super::official_login_url(s));
        Ok(
            serde_json::json!({"backendState":status["BackendState"],"authURL":auth_url,"ips":status["TailscaleIPs"],"peers":super::peers(&status)}),
        )
    }
    #[cfg(debug_assertions)]
    pub fn browser_test_start() -> Result<(), String> {
        let reuse = std::env::var("PIBOT_TAILSCALE_REUSE_DIR")
            .ok()
            .map(|name| {
                if !name.starts_with("pibo-tailnet-")
                    || name.contains('/')
                    || name.contains('\\')
                    || name.contains("..")
                {
                    return Err("Invalid test identity name".to_string());
                }
                Ok(std::env::temp_dir().join(name))
            })
            .transpose()?;
        configure("tskey-auth-local-placeholder", reuse)?;
        let node = current()
            .lock()
            .map_err(|_| "Node lock unavailable")?
            .clone()
            .ok_or("Missing node")?;
        unsafe extern "C" {
            fn tailscale_start(sd: i32) -> i32;
        }
        use std::os::{fd::IntoRawFd, unix::fs::OpenOptionsExt};
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(node.dir.join("sdk-network.log"))
            .map_err(|_| "Cannot create private SDK diagnostic log")?;
        // The Go logger owns this descriptor; logs remain in this test node's temporary directory.
        unsafe {
            tailscale_set_logfd(node.sd, log.into_raw_fd());
        }
        // Remove the placeholder before starting; interactive official login only.
        if unsafe { tailscale_set_authkey(node.sd, c"".as_ptr()) } != 0
            || unsafe { tailscale_set_hostname(node.sd, c"pibo-ios-simulator-test".as_ptr()) } != 0
            || unsafe { tailscale_start(node.sd) } != 0
        {
            stop();
            return Err("Cannot start temporary browser-login node".into());
        }
        node.started.store(true, Ordering::SeqCst);
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
        let diagnostics: Vec<String> = std::fs::read_to_string(node.dir.join("sdk-network.log"))
            .unwrap_or_default()
            .lines()
            .filter(|line| {
                line.contains("noise dial (")
                    || line.contains("TLS cert verificication")
                    || line.contains("unexpected HTTP response")
            })
            .filter(|line| !line.contains("tskey-"))
            .rev()
            .take(12)
            .map(str::to_owned)
            .collect();

        Ok(
            serde_json::json!({"networkDiagnostics":diagnostics,"backendState":status["BackendState"],"authURL":status["AuthURL"],"health":status["Health"],"ips":status["TailscaleIPs"],"peers":super::peers(&status),"hostname":"pibo-ios-simulator-test","ephemeral":true}),
        )
    }
    #[cfg(debug_assertions)]
    pub async fn peer_test() -> Result<serde_json::Value, String> {
        use sha2::{Digest, Sha256};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        const HOST: &str = "100.104.147.6";
        async fn http(path: &str, body: &[u8]) -> Result<Vec<u8>, String> {
            let mut stream = dial(HOST, 8080).await?;
            let method = if path == "/echo" { "POST" } else { "GET" };
            stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: {HOST}:8080\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",body.len()).as_bytes()).await.map_err(|e|e.to_string())?;
            stream.write_all(body).await.map_err(|e| e.to_string())?;
            let mut bytes = Vec::new();
            stream
                .take(65536)
                .read_to_end(&mut bytes)
                .await
                .map_err(|e| e.to_string())?;
            if !bytes.starts_with(b"HTTP/1.1 200 ") {
                return Err(format!(
                    "HTTP {path}: bytes={}, prefix={:?}",
                    bytes.len(),
                    String::from_utf8_lossy(&bytes[..bytes.len().min(256)])
                ));
            }
            let split = bytes
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .ok_or("Missing HTTP header")?;
            let body = &bytes[split + 4..];
            if String::from_utf8_lossy(&bytes[..split])
                .to_ascii_lowercase()
                .contains("transfer-encoding: chunked")
            {
                let mut remaining = body;
                let mut decoded = Vec::new();
                loop {
                    let end = remaining
                        .windows(2)
                        .position(|w| w == b"\r\n")
                        .ok_or("Invalid chunk header")?;
                    let size = usize::from_str_radix(
                        std::str::from_utf8(&remaining[..end])
                            .map_err(|_| "Invalid chunk size")?
                            .split(';')
                            .next()
                            .unwrap(),
                        16,
                    )
                    .map_err(|_| "Invalid chunk size")?;
                    remaining = &remaining[end + 2..];
                    if size == 0 {
                        break;
                    }
                    if size > 65536
                        || remaining.len() < size + 2
                        || &remaining[size..size + 2] != b"\r\n"
                    {
                        return Err("Invalid chunk body".into());
                    }
                    decoded.extend_from_slice(&remaining[..size]);
                    remaining = &remaining[size + 2..];
                }
                Ok(decoded)
            } else {
                Ok(body.to_vec())
            }
        }
        let first: serde_json::Value =
            serde_json::from_slice(&http("/health", &[]).await?).map_err(|e| e.to_string())?;
        let payload: Vec<u8> = (0..=255).collect();
        if http("/echo", &payload).await? != payload {
            return Err("HTTP byte mismatch".into());
        }
        let mut ws = dial(HOST, 8080).await?;
        ws.write_all(format!("GET /ws HTTP/1.1\r\nHost: {HOST}:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").as_bytes()).await.map_err(|e|e.to_string())?;
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(ws.read_u8().await.map_err(|e| e.to_string())?);
            if header.len() > 8192 {
                return Err("Oversize WS header".into());
            }
        }
        let header = String::from_utf8_lossy(&header);
        if !header.starts_with("HTTP/1.1 101 ") || !header.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        {
            return Err("Invalid WebSocket handshake".into());
        }
        let mask = [11, 22, 33, 44];
        let mut frame = vec![0x82, 0xfe, 1, 0];
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        ws.write_all(&frame).await.map_err(|e| e.to_string())?;
        let mut head = [0; 4];
        ws.read_exact(&mut head).await.map_err(|e| e.to_string())?;
        if head != [0x82, 126, 1, 0] {
            return Err("Invalid WS binary frame".into());
        }
        let mut echoed = vec![0; 256];
        ws.read_exact(&mut echoed)
            .await
            .map_err(|e| e.to_string())?;
        if echoed != payload {
            return Err("WebSocket byte mismatch".into());
        }
        ws.write_all(&[0x88, 0x80, 0, 0, 0, 0])
            .await
            .map_err(|e| e.to_string())?;
        drop(ws);
        let second: serde_json::Value =
            serde_json::from_slice(&http("/health", &[]).await?).map_err(|e| e.to_string())?;
        if first["run"] != second["run"] {
            return Err("Peer run changed".into());
        }
        Ok(
            serde_json::json!({"target":"100.104.147.6:8080","transport":"real libtailscale C ABI dial; no localhost fallback","serverRun":first["run"],"httpBinaryBytes":payload.len(),"webSocketBinaryBytes":echoed.len(),"sha256":format!("{:x}",Sha256::digest(&payload)),"reconnectSameServer":true}),
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
    pub fn credential_scope(host: &str) -> Result<String, String> {
        let node = current()
            .lock()
            .map_err(|_| "Node lock unavailable")?
            .clone()
            .ok_or("请先登录网络")?;
        if node.closed.load(Ordering::SeqCst) || !node.started.load(Ordering::SeqCst) {
            return Err("请先登录网络".into());
        }
        let status = sdk_status(&node)?;
        if status["BackendState"] != "Running" {
            return Err("网络尚未连接".into());
        }
        super::scope_from_status(&status, host)
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
        static DIALS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
        let permit = DIALS
            .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8)))
            .clone()
            .try_acquire_owned()
            .map_err(|_| "网络连接繁忙，请稍后重试")?;
        let address =
            CString::new(format!("{host}:{port}")).map_err(|_| "Invalid Tailnet address")?;
        let owned = node.clone();
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut fd = -1;
            owned.started.store(true, Ordering::SeqCst);
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
                return Err("Tailnet 连接超时，请检查设备在线状态和 ACL 后重试".into());
            }
        };
        node.dialed.store(true, Ordering::SeqCst);
        let stream = std::os::unix::net::UnixStream::from(fd);
        stream
            .set_nonblocking(true)
            .map_err(|_| "Cannot configure Tailnet stream")?;
        tokio::net::UnixStream::from_std(stream).map_err(|_| "Cannot attach Tailnet stream".into())
    }
}
#[cfg(feature = "embedded-tailscale")]
pub use native::{browser_start, credential_scope, dial, start, state, status, stop};
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
    fn authorization_links_stay_on_the_official_browser_endpoint() {
        assert!(super::official_login_url(
            "https://login.tailscale.com/a/synthetic-test"
        ));
        for url in [
            "http://login.tailscale.com/a/test",
            "https://login.tailscale.com.evil.invalid/a/test",
            "https://evil.invalid/a/test",
            "https://name@login.tailscale.com/a/test",
            "https://login.tailscale.com/a/test?redirect=evil",
            "https://login.tailscale.com/a/test#evil",
            "https://login.tailscale.com/admin",
            "https://login.tailscale.com/a/",
        ] {
            assert!(!super::official_login_url(url), "{url}");
        }
    }
    #[cfg(all(feature = "embedded-tailscale", pibo_tailscale_offline_test))]
    #[test]
    fn tailscale_offline_browser_flow_is_explicit_and_cancellable() {
        super::stop();
        assert_eq!(super::status().unwrap()["backendState"], "NotPrepared");
        super::start("tskey-auth-synthetic-offline").unwrap();
        assert_eq!(
            super::status().unwrap()["backendState"],
            "Prepared",
            "status cannot start a prepared node"
        );
        super::stop();
        super::browser_start().unwrap();
        super::browser_start().unwrap(); // idempotent: reuse the active node
        let status = super::status().unwrap();
        assert_eq!(status["backendState"], "NeedsLogin");
        assert!(super::official_login_url(
            status["authURL"].as_str().unwrap()
        ));
        assert_eq!(
            status.as_object().unwrap().len(),
            4,
            "only curated status and peers"
        );
        super::stop();
        assert_eq!(super::status().unwrap()["backendState"], "NotPrepared");
        super::browser_start().unwrap();
        super::stop();
    }
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

#[cfg(all(feature = "embedded-tailscale", debug_assertions))]
pub use native::peer_test;

/// Only the official default control server's browser authorization endpoint is allowed.
pub fn official_login_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("login.tailscale.com")
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path().starts_with("/a/")
            && url.path().len() > 3
            && url.query().is_none()
            && url.fragment().is_none()
    })
}
#[cfg(not(feature = "embedded-tailscale"))]
pub fn browser_start() -> Result<(), String> {
    Err("此构建未启用 embedded-tailscale".into())
}
#[cfg(not(feature = "embedded-tailscale"))]
pub fn status() -> Result<serde_json::Value, String> {
    Err("此构建未启用 embedded-tailscale".into())
}

pub fn peers(status: &serde_json::Value) -> Vec<serde_json::Value> {
    status["Peer"].as_object().into_iter().flat_map(|m|m.values()).filter_map(|p|{
        let ips=p["TailscaleIPs"].as_array()?.iter().filter_map(|ip|ip.as_str()).filter(|ip|ip.parse::<std::net::Ipv4Addr>().is_ok_and(|ip|ip.octets()[0]==100&&(64..=127).contains(&ip.octets()[1]))).take(1).collect::<Vec<_>>();
        if ips.is_empty(){return None;}
        Some(serde_json::json!({"name":p["HostName"].as_str().unwrap_or("设备").chars().filter(|c|!c.is_control()).take(100).collect::<String>(),"dnsName":p["DNSName"].as_str().unwrap_or("").chars().filter(|c|!c.is_control()).take(255).collect::<String>(),"ip":ips[0],"online":p["Online"].as_bool().unwrap_or(false)}))
    }).take(256).collect()
}
pub fn logout() -> Result<(), String> {
    stop();
    crate::tailnet_secrets::remove("node-state-v1")
}

pub fn resume() -> Result<(), String> {
    if state() == "notPrepared" || state() == "stopped" {
        if crate::tailnet_secrets::load("node-state-v1")?.is_none() {
            return Err("请先登录应用内 Tailscale 网络".into());
        }
        browser_start()?;
    }
    Ok(())
}

#[cfg(test)]
mod peer_tests {
    #[test]
    fn pairing_credentials_are_bound_to_network_and_peer_identity() {
        let mut s = serde_json::json!({"CurrentTailnet":{"StableID":"network-a"},"Peer":{"key":{"ID":"node-a","TailscaleIPs":["100.100.1.2"]}}});
        let original = super::scope_from_status(&s, "100.100.1.2").unwrap();
        s["CurrentTailnet"]["StableID"] = serde_json::json!("network-b");
        assert_ne!(
            original,
            super::scope_from_status(&s, "100.100.1.2").unwrap()
        );
        s["CurrentTailnet"]["StableID"] = serde_json::json!("network-a");
        s["Peer"]["key"]["ID"] = serde_json::json!("node-b");
        assert_ne!(
            original,
            super::scope_from_status(&s, "100.100.1.2").unwrap()
        );
        assert!(super::scope_from_status(&s, "100.100.1.3").is_err());
    }
    #[test]
    fn peer_picker_never_exposes_node_keys_or_external_addresses() {
        let status = serde_json::json!({"Peer":{"secret-key-map-id":{"HostName":"desk\nname","DNSName":"desk.example.","TailscaleIPs":["192.168.1.1","100.100.1.2"],"Online":true,"PrivateNodeKey":"secret"},"bad":{"TailscaleIPs":["10.0.0.2"]}}});
        let peers = super::peers(&status);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0]["name"], "deskname");
        assert_eq!(peers[0]["ip"], "100.100.1.2");
        assert_eq!(peers[0].as_object().unwrap().len(), 4);
        assert!(!serde_json::to_string(&peers).unwrap().contains("secret"));
    }
}

fn scope_from_status(status: &serde_json::Value, host: &str) -> Result<String, String> {
    let network = status["CurrentTailnet"]["StableID"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            status["CurrentTailnet"]["MagicDNSSuffix"]
                .as_str()
                .filter(|s| !s.is_empty())
        })
        .ok_or("网络身份不可用，请重新连接")?;
    let peer = status["Peer"]
        .as_object()
        .and_then(|m| {
            m.values().find(|p| {
                p["TailscaleIPs"]
                    .as_array()
                    .is_some_and(|ips| ips.iter().any(|ip| ip.as_str() == Some(host)))
            })
        })
        .and_then(|p| p["ID"].as_str())
        .filter(|s| !s.is_empty())
        .ok_or("设备身份不可用，请刷新设备列表")?;
    Ok(format!("{network}\n{peer}"))
}
#[cfg(not(feature = "embedded-tailscale"))]
pub fn credential_scope(_: &str) -> Result<String, String> {
    Err("此构建不支持内嵌 Tailscale".into())
}
