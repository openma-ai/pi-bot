mod desktop_transport;
#[cfg(all(debug_assertions, target_os = "ios", feature = "embedded-tailscale"))]
mod direct_probe;
mod file_export;
#[cfg(all(debug_assertions, target_os = "ios"))]
mod ios_probe;
#[cfg_attr(not(any(target_os = "ios", target_os = "android")), allow(dead_code))]
mod mobile_ssh;
mod runtime_distribution;
#[cfg(target_os = "ios")]
mod ssh_credentials;
#[cfg(not(target_os = "ios"))]
#[path = "ssh_credentials_android.rs"]
mod ssh_credentials;
#[cfg(feature = "client-fixtures")]
pub mod ssh_fixture;
mod ssh_interactive;
mod tailnet_secrets;
mod tailnet_transport;
mod tailscale;
mod transport;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use transport::{Endpoint, Profile};

fn valid_saved_profiles(profiles: &[Profile], remote_only: bool) -> bool {
    (remote_only || !profiles.is_empty())
        && profiles.len() <= 32
        && profiles
            .iter()
            .all(|p| p.validate().is_ok() && (!remote_only || p.mode != "local"))
}

struct State {
    profiles: Vec<Profile>,
    active: Option<(String, Profile, Arc<Endpoint>)>,
    file: PathBuf,
    connection_epoch: Arc<std::sync::atomic::AtomicU64>,
    streams: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    forms: HashMap<String, (Arc<Endpoint>, String)>,
}
impl State {
    fn status(&self) -> Value {
        json!({"tailscaleNodeState":tailscale::state(),"embeddedTailscaleAvailable":cfg!(feature="embedded-tailscale"),"remoteOnly":cfg!(any(target_os = "ios", target_os = "android")),"credentialStorage":if cfg!(target_os="android") {"session"} else if cfg!(target_os="ios") {"keychain"} else {"system"},"profiles":self.profiles,"connecting":false,"active":self.active.as_ref().map(|(id,p,_)|json!({"id":id,"profileId":p.id,"mode":p.mode,"baseUrl":format!("/runtime/{id}"),"scope":p.id,"label":p.name,"profile":p}))})
    }
    fn retire(&mut self) {
        self.connection_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        for (_, handle) in self.streams.drain() {
            handle.abort();
        }
        // Dropping the endpoint terminates only the SSH forward owned by this client.
        self.active = None;
        self.forms.clear();
    }
    fn persist(&self) -> Result<(), String> {
        let parent = self.file.parent().ok_or("Invalid profile location")?;
        std::fs::create_dir_all(parent).map_err(|_| "Cannot save runtime profiles")?;
        let tmp = self.file.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.profiles).unwrap())
            .map_err(|_| "Cannot save runtime profiles")?;
        std::fs::rename(tmp, &self.file).map_err(|_| "Cannot save runtime profiles".into())
    }
    fn route(&self, path: &str) -> Result<(Arc<Endpoint>, String), String> {
        let (id, _, endpoint) = self
            .active
            .as_ref()
            .ok_or("没有启用 runtime，请先在设置中连接已运行的服务")?;
        let prefix = format!("/runtime/{id}");
        let suffix = path.strip_prefix(&prefix).ok_or("连接已切换，请重新连接")?;
        if !(suffix == "/rpc"
            || suffix.starts_with("/events?")
            || suffix == "/events"
            || suffix.starts_with("/pi/")
            || suffix.starts_with("/api/desktop/"))
        {
            return Err("此开发版仅支持聊天、任务状态和模型设置".into());
        }
        if suffix.contains("..") || suffix.contains('#') || suffix.contains('\\') {
            return Err("Invalid request path".into());
        }
        Ok((endpoint.clone(), suffix.into()))
    }
}
type Shared = Mutex<State>;

#[tauri::command]
fn layout_diagnostics_enabled(window: tauri::Window) -> Result<bool, String> {
    main_window(&window)?;
    Ok(cfg!(debug_assertions) && std::env::var("PIBOT_LAYOUT_DIAGNOSTICS").as_deref() == Ok("1"))
}

#[tauri::command]
fn layout_diagnostics(
    window: tauri::Window,
    app: tauri::AppHandle,
    metrics: Value,
) -> Result<(), String> {
    main_window(&window)?;
    if !cfg!(debug_assertions) || std::env::var("PIBOT_LAYOUT_DIAGNOSTICS").as_deref() != Ok("1") {
        return Err("Diagnostics disabled".into());
    }
    let bytes = serde_json::to_vec_pretty(&metrics).map_err(|_| "Invalid metrics")?;
    if bytes.len() > 32768 {
        return Err("Metrics too large".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "No diagnostics directory")?;
    std::fs::create_dir_all(&dir).map_err(|_| "Cannot create diagnostics directory")?;
    std::fs::write(dir.join("ios-layout-latest.json"), bytes)
        .map_err(|_| "Cannot write metrics".into())
}

#[tauri::command]
async fn ssh_password_store(
    window: tauri::Window,
    state: tauri::State<'_, Shared>,
    profile_id: String,
    password: String,
) -> Result<(), String> {
    main_window(&window)?;
    let password = zeroize::Zeroizing::new(password);
    let s = state.lock().await;
    let p = s
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or("Runtime 不存在")?;
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        ssh_credentials::store(p, &password)
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (p, password);
        Err("桌面继续使用系统 SSH 配置与密钥".into())
    }
}

#[tauri::command]
async fn ssh_credentials_set(
    window: tauri::Window,
    state: tauri::State<'_, Shared>,
    profile_id: String,
    credentials: mobile_ssh::Credentials,
    save: bool,
) -> Result<(), String> {
    main_window(&window)?;
    {
        let s = state.lock().await;
        let p = s
            .profiles
            .iter()
            .find(|p| p.id == profile_id)
            .ok_or("Runtime 不存在")?;
        if !cfg!(any(target_os = "ios", target_os = "android")) && !p.embedded_tailscale {
            return Err("直连桌面使用系统 SSH 配置".into());
        }
        ssh_credentials::configure(p, credentials, save)
    }
}
#[tauri::command]
fn ssh_challenge_reply(
    window: tauri::Window,
    id: String,
    answers: Option<Vec<String>>,
) -> Result<(), String> {
    main_window(&window)?;
    ssh_interactive::respond(&id, answers)
}

#[tauri::command]
fn runtime_distribution_status() -> Value {
    runtime_distribution::status()
}
#[tauri::command]
fn runtime_install() -> Result<(), String> {
    runtime_distribution::install()
}

#[tauri::command]
async fn runtime_control(
    window: tauri::Window,
    state: tauri::State<'_, Shared>,
    app: tauri::AppHandle,
    method: String,
    params: Value,
) -> Result<Value, String> {
    main_window(&window)?;
    match method.as_str() {
        "tailscale/probe" => tailnet_transport::probe(&params).await,
        "tailscale/pair" => tailnet_transport::pair(&params).await,
        "tailscale/forgetDevice" => {
            tailnet_secrets::remove(&tailnet_transport::account(&params)?)?;
            Ok(json!({"removed":true}))
        }
        "tailscale/browserStart" => {
            tokio::task::spawn_blocking(tailscale::browser_start)
                .await
                .map_err(|_| "授权启动被中断")??;
            Ok(json!({"started":true}))
        }
        "tailscale/status" => {
            let status = tokio::task::spawn_blocking(tailscale::status)
                .await
                .map_err(|_| "状态读取被中断")??;
            if status["backendState"] == "Running" {
                file_export::close_tailscale_login();
            }
            Ok(status)
        }
        "tailscale/closeLogin" => {
            file_export::close_tailscale_login();
            Ok(json!({"closed":true}))
        }
        "tailscale/openLogin" => {
            let status = tokio::task::spawn_blocking(tailscale::status)
                .await
                .map_err(|_| "状态读取被中断")??;
            let url = status["authURL"]
                .as_str()
                .ok_or("授权页面尚未就绪，请稍后重试")?;
            file_export::open_tailscale_login(url).await?;
            Ok(json!({"opened":true}))
        }
        "tailscale/start" => {
            let key = zeroize::Zeroizing::new(
                params["authKey"]
                    .as_str()
                    .ok_or("请输入 Tailscale auth key")?
                    .to_owned(),
            );
            tailscale::start(&key)?;
            Ok(json!({"configured":true}))
        }
        "tailscale/logout" => {
            state.lock().await.retire();
            tailscale::logout()?;
            file_export::close_tailscale_login();
            Ok(json!({"loggedOut":true}))
        }
        "tailscale/stop" => {
            state.lock().await.retire();
            tailscale::stop();
            file_export::close_tailscale_login();
            Ok(json!({"configured":false}))
        }
        "runtime/status" => Ok(state.lock().await.status()),
        "runtime/disconnect" => {
            let mut s = state.lock().await;
            s.retire();
            Ok(s.status())
        }
        "runtime/remove" => {
            let mut s = state.lock().await;
            let id = params["id"].as_str().ok_or("Invalid profile")?;
            if s.active.as_ref().is_some_and(|(_, p, _)| p.id == id) {
                return Err("请先断开此 runtime".into());
            }
            if s.profiles.len() == 1 && !cfg!(any(target_os = "ios", target_os = "android")) {
                return Err("至少保留一个 runtime".into());
            }
            if let Some(p) = s.profiles.iter().find(|p| p.id == id) {
                ssh_credentials::forget(p)?;
            }
            s.connection_epoch
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            s.profiles.retain(|p| p.id != id);
            s.persist()?;
            Ok(s.status())
        }
        "runtime/configure" | "runtime/connect" => {
            let mut p: Profile = serde_json::from_value(params["profile"].clone())
                .map_err(|_| "请检查 runtime 配置")?;
            p.validate()?;
            if cfg!(any(target_os = "ios", target_os = "android")) && p.mode == "local" {
                return Err("移动客户端仅支持远程 runtime".into());
            }
            if p.id.is_empty() {
                p.id = uuid::Uuid::new_v4().to_string();
            }
            if p.name.trim().is_empty() {
                p.name = if p.mode == "local" {
                    "本机"
                } else {
                    "SSH remote"
                }
                .into();
            }
            // No lock is held during network/MFA waits. A later disconnect,
            // configure or connect invalidates this attempt before installation.
            let epoch = state.lock().await.connection_epoch.clone();
            let version = epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let endpoint = if method == "runtime/connect" {
                let cancelled = async {
                    loop {
                        if epoch.load(std::sync::atomic::Ordering::SeqCst) != version {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                };
                #[cfg(any(target_os = "ios", target_os = "android"))]
                let connection = async {
                    if p.mode == "tailnet" {
                        return tailnet_transport::connect(&p).await;
                    }
                    let credentials = ssh_credentials::credentials(&p)?;
                    mobile_ssh::connect_authenticated(
                        &p,
                        &credentials,
                        Some(ssh_interactive::handler(app)),
                    )
                    .await
                };
                #[cfg(not(any(target_os = "ios", target_os = "android")))]
                let connection = async {
                    if p.mode == "tailnet" {
                        tailnet_transport::connect(&p).await
                    } else if p.embedded_tailscale {
                        let credentials = ssh_credentials::credentials(&p)?;
                        mobile_ssh::connect_authenticated(
                            &p,
                            &credentials,
                            Some(ssh_interactive::handler(app)),
                        )
                        .await
                    } else {
                        transport::connect(&p).await
                    }
                };
                Some(Arc::new(tokio::select! {
                    _=cancelled=>return Err("连接已取消".into()),
                    result=tokio::time::timeout(std::time::Duration::from_secs(180),connection)=>result.map_err(|_|"SSH 连接总时限已到，请重试")??,
                }))
            } else {
                None
            };
            let mut s = state.lock().await;
            if epoch.load(std::sync::atomic::Ordering::SeqCst) != version {
                return Err("连接已被更新操作取消".into());
            }
            if let Some(old) = s.profiles.iter().find(|old| old.id == p.id) {
                if !ssh_credentials::same_identity(old, &p) {
                    ssh_credentials::forget(old)?;
                }
            }
            let changed_active = cfg!(any(target_os = "ios", target_os = "android"))
                && s.active.as_ref().is_some_and(|(_, active, _)| {
                    active.id == p.id
                        && (active.host != p.host
                            || active.ssh_port != p.ssh_port
                            || active.host_key != p.host_key
                            || active.data_dir != p.data_dir
                            || active.project_dir != p.project_dir)
                });
            let previous = s.profiles.clone();
            if let Some(old) = s.profiles.iter_mut().find(|old| old.id == p.id) {
                *old = p.clone();
            } else {
                if s.profiles.len() >= 32 {
                    return Err("最多配置 32 个 runtime".into());
                }
                s.profiles.push(p.clone());
            }
            if let Err(error) = s.persist() {
                s.profiles = previous;
                return Err(error);
            }
            if let Some(endpoint) = endpoint {
                s.retire();
                s.active = Some((uuid::Uuid::new_v4().to_string(), p, endpoint));
            } else if changed_active {
                s.retire();
            }
            Ok(s.status())
        }
        _ => Err("Unknown runtime method".into()),
    }
}

#[tauri::command]
async fn desktop_open(
    window: tauri::Window,
    state: tauri::State<'_, Shared>,
    path: String,
    id: String,
) -> Result<String, String> {
    main_window(&window)?;
    if id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("Invalid stream ID".into());
    }
    let mut s = state.lock().await;
    if s.streams.len() >= 32 || s.streams.contains_key(&id) {
        return Err("连接过多或重复".into());
    }
    let (ep, suffix) = s.route(&path)?;
    let bot = suffix
        .strip_prefix("/api/desktop/")
        .and_then(|s| s.strip_suffix("/ws"))
        .ok_or("Invalid desktop path")?;
    if bot.is_empty()
        || !bot
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid desktop ID".into());
    }
    let (url, task) = desktop_transport::open(ep, suffix).await?;
    s.streams.insert(id, task);
    Ok(url)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    status: u16,
    body: String,
    content_type: String,
    binary: bool,
}
#[tauri::command]
async fn runtime_request(
    window: tauri::Window,
    state: tauri::State<'_, Shared>,
    path: String,
    method: String,
    body: String,
    connection: String,
) -> Result<Reply, String> {
    main_window(&window)?;
    if body.len() > 1024 * 1024 {
        return Err("Request too large".into());
    }
    let (endpoint, suffix) = state.lock().await.route(&path)?;
    // Authentication/credential setup remains with the independently managed runtime.
    if suffix.starts_with("/pi/") && method != "GET" && suffix != "/pi/model" {
        return Err("请在独立 runtime 管理认证，桌面客户端不接收凭据".into());
    }
    let response = endpoint
        .request(&suffix, &method, &body, &connection)
        .await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "无法读取 runtime 响应")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Runtime response too large".into());
    }
    let binary =
        !content_type.starts_with("application/json") && !content_type.starts_with("text/");
    use base64::Engine;
    Ok(Reply {
        status,
        body: if binary {
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        } else {
            String::from_utf8_lossy(&bytes).into()
        },
        content_type,
        binary,
    })
}
#[tauri::command]
async fn stream_open(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, Shared>,
    id: String,
    path: String,
    connection: String,
) -> Result<(), String> {
    main_window(&window)?;
    use futures_util::StreamExt;
    let (endpoint, suffix) = state.lock().await.route(&path)?;
    if !suffix.starts_with("/events") {
        return Err("Invalid stream".into());
    }
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        endpoint.request(&suffix, "GET", "", &connection),
    )
    .await
    .map_err(|_| "事件连接超时，请重连 runtime")??;
    if !response.status().is_success() {
        return Err("Event stream rejected; reconnect runtime".into());
    }
    let event_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut bytes = response.bytes_stream();
        while let Some(chunk) = bytes.next().await {
            match chunk {
                Ok(data) => {
                    let _ = app.emit_to(
                        "main",
                        "native-stream",
                        json!({"id":event_id,"data":data.to_vec()}),
                    );
                }
                Err(_) => {
                    let _ = app.emit_to(
                        "main",
                        "native-stream",
                        json!({"id":event_id,"error":"连接中断，请重连 runtime"}),
                    );
                    return;
                }
            }
        }
        let _ = app.emit_to("main", "native-stream", json!({"id":event_id,"done":true}));
    });
    let mut s = state.lock().await;
    if s.streams.len() >= 32 {
        task.abort();
        return Err("Too many streams".into());
    }
    s.streams.insert(id, task);
    Ok(())
}
#[tauri::command]
async fn stream_close(
    window: tauri::Window,
    state: tauri::State<'_, Shared>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    if let Some(task) = state.lock().await.streams.remove(&id) {
        task.abort();
    }
    Ok(())
}

fn main_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("This command belongs to the conversation window".into());
    }
    Ok(())
}
fn valid_form(path: &str) -> bool {
    path.strip_prefix("/credential/").is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 256
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
    })
}
#[tauri::command]
async fn credential_window(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, Shared>,
    path: String,
) -> Result<(), String> {
    main_window(&window)?;
    if !valid_form(&path) {
        return Err("Invalid secure credential form".into());
    }
    let mut s = state.lock().await;
    s.forms
        .retain(|label, _| app.get_webview_window(label).is_some());
    if s.forms.len() >= 8 {
        return Err("请先关闭已有安全窗口".into());
    }
    let endpoint = s
        .active
        .as_ref()
        .ok_or("Runtime changed; reopen the request")?
        .2
        .clone();
    let response = endpoint.request(&path, "GET", "", "").await?;
    if !response.status().is_success() {
        return Err("安全表单已失效，请检查请求状态".into());
    }
    let label = format!("credential-{}", uuid::Uuid::new_v4());
    // Neither runtime auth nor form data is placed in the window URL or renderer state.
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("credential.html".into()),
    )
    .title("安全输入凭据")
    .inner_size(420.0, 300.0)
    .resizable(false)
    .build()
    .map_err(|_| "Cannot open secure input window")?;
    s.forms.insert(label, (endpoint, path));
    Ok(())
}
#[tauri::command]
async fn credential_submit(
    window: tauri::Window,
    state: tauri::State<'_, Shared>,
    secret: String,
) -> Result<(), String> {
    if !window.label().starts_with("credential-") || secret.is_empty() || secret.len() > 16000 {
        return Err("Invalid secure form submission".into());
    }
    let (endpoint, path) = state
        .lock()
        .await
        .forms
        .remove(window.label())
        .ok_or("Form is no longer active; reopen it from the conversation")?;
    let body = json!({"secret":secret}).to_string();
    let response = endpoint.request(&path, "POST", &body, "").await?;
    if !response.status().is_success() {
        return Err("Credential submission not confirmed".into());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(all(debug_assertions, feature = "embedded-tailscale", target_os = "ios"))]
            if std::env::var("PIBOT_TAILSCALE_LOCAL_PROBE").as_deref() == Ok("1") {
                let result = tailscale::local_probe();
                let dir = app.path().app_data_dir()?;
                std::fs::create_dir_all(&dir)?;
                std::fs::write(dir.join("tailscale-local-probe.json"), serde_json::to_vec_pretty(&result)?)?;
            }

            #[cfg(all(debug_assertions, feature = "embedded-tailscale", target_os = "ios"))]
            if std::env::var("PIBOT_TAILSCALE_BROWSER_TEST").as_deref() == Ok("1") {
                let dir = app.path().app_data_dir()?;
                std::fs::create_dir_all(&dir)?;
                tauri::async_runtime::spawn(async move {
                    let control_probe = match reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(15)).build() {
                        Ok(client) => match client.get("https://controlplane.tailscale.com/key?v=148").send().await {
                            Ok(response) => json!({"status":response.status().as_u16()}),
                            Err(error) => json!({"error":error.to_string()}),
                        },
                        Err(error) => json!({"error":error.to_string()}),
                    };
                    let _ = std::fs::write(dir.join("tailscale-control-probe.json"), serde_json::to_vec_pretty(&control_probe).unwrap());
                    let started = tokio::task::spawn_blocking(tailscale::browser_test_start).await;
                    if !matches!(started, Ok(Ok(()))) {
                        let _ = std::fs::write(dir.join("tailscale-browser-test.json"), b"{\"error\":\"SDK start failed\"}");
                        return;
                    }
                    let mut tested = false;
                    let deadline = std::env::var("PIBOT_TAILSCALE_TEST_DEADLINE").ok().and_then(|v|v.parse::<u64>().ok())
                        .unwrap_or_else(||std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()+900);
                    while std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() < deadline {
                        let status = tokio::task::spawn_blocking(tailscale::browser_test_status).await;
                        if let Ok(result) = status {
                            if !tested && result.as_ref().ok().is_some_and(|v|v["backendState"]=="Running") && std::env::var("PIBOT_TAILSCALE_PEER_TEST").as_deref()==Ok("100.104.147.6:8080") {
                                tested=true;
                                let result=tokio::time::timeout(std::time::Duration::from_secs(deadline.saturating_sub(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()).min(60)),async {
                                    let mut result=Err("Not attempted".to_string());
                                    for _ in 0..3 {tokio::time::sleep(std::time::Duration::from_secs(3)).await;result=tailscale::peer_test().await;if result.is_ok(){break;}}
                                    result
                                }).await;
                                let report=match result {Ok(v)=>serde_json::to_value(v).unwrap(),Err(_)=>json!({"Err":"Peer test timeout"})};
                                let _=std::fs::write(dir.join("tailscale-peer-test.json"),serde_json::to_vec_pretty(&report).unwrap());
                            }
                            if let Ok(bytes) = serde_json::to_vec_pretty(&result) {
                                let _ = std::fs::write(dir.join("tailscale-browser-test.json"), bytes);
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                    tailscale::stop();
                });
            }
            let file = app.path().app_data_dir()?.join("profiles.json");
            let profiles = std::fs::read(&file)
                .ok()
                .and_then(|b| serde_json::from_slice::<Vec<Profile>>(&b).ok())
                .filter(|p|valid_saved_profiles(p,cfg!(any(target_os="ios",target_os="android"))))
                .unwrap_or_else(|| {
                    if cfg!(any(target_os = "ios", target_os = "android")) {
                        Vec::new()
                    } else {
                        vec![Profile::local(
                            "local",
                            "本机",
                            "/path/to/existing/pi-bot/data",
                        )]
                    }
                });
            #[cfg(all(debug_assertions, target_os = "ios"))]
            let fixture = ios_probe::profile();
            #[cfg(all(debug_assertions, target_os = "ios"))]
            let profiles = fixture.clone().map(|p| vec![p]).unwrap_or(profiles);
            app.manage(Mutex::new(State {
                profiles,
                active: None,
                file,
                connection_epoch: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                streams: HashMap::new(),
                forms: HashMap::new(),
            }));
            #[cfg(all(debug_assertions,target_os="ios",feature="embedded-tailscale"))]
            direct_probe::launch(app.handle().clone());
            #[cfg(debug_assertions)]
            if std::env::var("PIBOT_LAYOUT_DIAGNOSTICS").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    if let Some(webview) = handle.get_webview_window("main") {
                        let _ = webview.eval("(async()=>{const report=metrics=>window.__TAURI_INTERNALS__.invoke('layout_diagnostics',{metrics});const root=document.getElementById('root');if(!root?.children.length){const scripts=[...document.scripts].filter(s=>s.type==='module').map(s=>s.src);let error='';try{await import(scripts[0])}catch(e){error=String(e)}await report({startup:true,readyState:document.readyState,rootChildren:root?.children.length,scripts,error})}})()");
                    }
                });
            }
            #[cfg(all(debug_assertions, target_os = "ios"))]
            if let Some(profile) = fixture {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let result = ios_probe::run(&profile).await;
                    let report = match &result {
                        Ok(value) => json!({"ok":true,"checks":value}),
                        Err(error) => json!({"ok":false,"error":error}),
                    };
                    if let Ok(dir) = handle.path().app_data_dir() {
                        let _ = std::fs::create_dir_all(&dir);
                        let _ = std::fs::write(
                            dir.join("ios-fixture-result.json"),
                            serde_json::to_vec_pretty(&report).unwrap(),
                        );
                    }
                    if result.is_ok() {
                        let endpoint = if std::env::var("PIBOT_IOS_FIXTURE_INTERACTIVE").as_deref()==Ok("1") {
                            let credentials=mobile_ssh::Credentials {method:"interactive".into(),password:String::new(),private_key:String::new(),passphrase:String::new(),interactive:false};
                            mobile_ssh::connect_authenticated(&profile,&credentials,Some(ssh_interactive::handler(handle.clone()))).await
                        } else { transport::connect(&profile).await };
                        if let Ok(endpoint) = endpoint {
                            handle.state::<Shared>().lock().await.active = Some((
                                uuid::Uuid::new_v4().to_string(),
                                profile,
                                Arc::new(endpoint),
                            ));
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            layout_diagnostics_enabled,
            layout_diagnostics,
            ssh_password_store,
            ssh_credentials_set,
            ssh_challenge_reply,
            runtime_distribution_status,
            runtime_install,
            runtime_control,
            runtime_request,
            desktop_open,
            stream_open,
            stream_close,
            credential_window,
            credential_submit,
            file_export::file_export
        ])
        .build(tauri::generate_context!())
        .expect("Cannot build Pi Bot application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle.state::<Shared>().lock().await.retire();
                        tailscale::stop();
                        handle.exit(0);
                    });
                }
            }
        });
}

#[cfg(test)]
mod saved_profile_tests {
    #[test]
    fn mobile_restart_retains_direct_tailnet_profiles_without_allowing_local_runtime() {
        let tailnet:super::Profile=serde_json::from_value(serde_json::json!({"id":"saved","name":"private","mode":"tailnet","host":"100.127.171.114","serverPort":4319,"dataDir":"","embeddedTailscale":true})).unwrap();
        assert!(super::valid_saved_profiles(&[tailnet.clone()], true));
        let mut invalid = tailnet;
        invalid.host = Some("127.0.0.1".into());
        assert!(!super::valid_saved_profiles(&[invalid], true));
        let local = super::Profile::local("local", "Local", "/tmp/synthetic");
        assert!(!super::valid_saved_profiles(&[local.clone()], true));
        assert!(super::valid_saved_profiles(&[local], false));
        assert!(super::valid_saved_profiles(&[], true));
        assert!(!super::valid_saved_profiles(&[], false));
    }
}
