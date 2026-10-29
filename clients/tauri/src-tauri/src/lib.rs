mod builtin_harness;
mod pi_settings_security;
mod direct_transport;
mod desktop_transport;
#[cfg(all(debug_assertions, target_os = "ios", feature = "embedded-tailscale"))]
mod direct_probe;
mod file_export;
#[cfg(all(debug_assertions, target_os = "ios", feature="client-fixtures"))]
mod ios_probe;
#[cfg(feature="client-fixtures")]
mod mobile_ssh;
mod runtime_distribution;
#[cfg(all(target_os = "ios",feature="client-fixtures"))]
mod ssh_credentials;
#[cfg(all(not(target_os = "ios"),feature="client-fixtures"))]
#[path = "ssh_credentials_android.rs"]
mod ssh_credentials;
#[cfg(feature = "client-fixtures")]
pub mod ssh_fixture;
#[cfg(feature="client-fixtures")]
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
        && profiles.len() <= 33
        && profiles
            .iter()
            .all(|p| (p.mode == "ssh" || p.validate().is_ok()) && (!remote_only || (p.mode != "local" && p.mode != "builtin")))
}

#[derive(Clone)]
enum FormTarget {
    Credential(String),
    PiPrompt { flow: String, prompt: String },
}
#[derive(Clone)]
struct SecureForm { endpoint: Arc<Endpoint>, target: FormTarget, claimed: bool }
impl SecureForm {
    fn belongs_to(&self, endpoint: &Arc<Endpoint>, flow: &str) -> bool {
        Arc::ptr_eq(&self.endpoint, endpoint) && matches!(&self.target, FormTarget::PiPrompt { flow: id, .. } if id == flow)
    }
}

struct State {
    profiles: Vec<Profile>,
    active: Option<(String, Profile, Arc<Endpoint>)>,
    file: PathBuf,
    builtin: Arc<builtin_harness::Harness>,
    connection_epoch: Arc<std::sync::atomic::AtomicU64>,
    login_epoch: Arc<std::sync::atomic::AtomicU64>,
    streams: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    forms: HashMap<String, SecureForm>,
}
impl State {
    fn take_pi_form_labels(&mut self, endpoint: &Arc<Endpoint>, flow: &str) -> Vec<String> {
        let labels: Vec<_> = self.forms.iter().filter(|(_, form)| form.belongs_to(endpoint, flow)).map(|(label, _)| label.clone()).collect();
        for label in &labels { self.forms.remove(label); }
        labels
    }
    fn invalidate_pi_forms(&mut self, endpoint: &Arc<Endpoint>, flow: &str) {
        self.take_pi_form_labels(endpoint, flow);
    }
    fn status(&self) -> Value {
        json!({"builtinHarness":self.builtin.status(),"tailscaleNodeState":tailscale::state(),"embeddedTailscaleAvailable":cfg!(feature="embedded-tailscale"),"remoteOnly":cfg!(any(target_os = "ios", target_os = "android")),"credentialStorage":if cfg!(target_os="android") {"session"} else if cfg!(target_os="ios") {"keychain"} else {"system"},"profiles":self.profiles,"connecting":false,"active":self.active.as_ref().map(|(id,p,_)|json!({"id":id,"profileId":p.id,"mode":p.mode,"baseUrl":format!("/runtime/{id}"),"scope":p.id,"label":p.name,"profile":p}))})
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
    let filename = if metrics.get("directDesktop").is_some() {
        "direct-ui.json"
    } else {
        "ios-layout-latest.json"
    };
    std::fs::write(dir.join(filename), bytes)
        .map_err(|_| "Cannot write metrics".into())
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
        "tailscale/login" => {
            let epoch=state.lock().await.login_epoch.clone();
            let version=epoch.fetch_add(1,std::sync::atomic::Ordering::SeqCst)+1;
            tailnet_transport::login(&params,epoch,version).await
        },
        "tailscale/cancelLogin" => {state.lock().await.login_epoch.fetch_add(1,std::sync::atomic::Ordering::SeqCst);Ok(json!({"cancelled":true}))},
        "tailscale/logoutService" => { let result=tailnet_transport::logout(&params).await?; state.lock().await.retire(); Ok(result) },
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
            file_export::open_tailscale_login(&app, url).await?;
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
        "runtime/builtinStop" => {
            let builtin = {
                let mut s = state.lock().await;
                if s.active.as_ref().is_some_and(|(_, p, _)| p.mode == "builtin") { s.retire(); }
                else { s.connection_epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
                s.builtin.clone()
            };
            builtin.stop().await?;
            Ok(state.lock().await.status())
        }
        "runtime/remove" => {
            let mut s = state.lock().await;
            let id = params["id"].as_str().ok_or("Invalid profile")?;
            if id == builtin_harness::PROFILE_ID { return Err("本机引擎由应用管理，不能删除".into()); }
            if s.active.as_ref().is_some_and(|(_, p, _)| p.id == id) {
                return Err("请先断开此 runtime".into());
            }
            if s.profiles.len() == 1 && !cfg!(any(target_os = "ios", target_os = "android")) {
                return Err("至少保留一个 runtime".into());
            }
            s.connection_epoch
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            s.profiles.retain(|p| p.id != id);
            s.persist()?;
            Ok(s.status())
        }
        "runtime/configure" | "runtime/connect" | "runtime/builtinStart" | "runtime/builtinRestart" => {
            let mut p: Profile = if method.starts_with("runtime/builtin") { builtin_harness::profile() } else {
                serde_json::from_value(params["profile"].clone()).map_err(|_| "请检查 runtime 配置")?
            };
            p.validate()?;
            if p.id == builtin_harness::PROFILE_ID && p.mode != "builtin" { return Err("本机引擎配置不可替换".into()); }
            if p.mode == "builtin" {
                if method == "runtime/configure" { return Err("本机引擎由应用管理，无需编辑配置".into()); }
                p = builtin_harness::profile();
            }
            if cfg!(any(target_os = "ios", target_os = "android")) && (p.mode == "local" || p.mode == "builtin") {
                return Err("移动客户端仅支持远程 runtime".into());
            }
            if p.id.is_empty() {
                p.id = uuid::Uuid::new_v4().to_string();
            }
            if p.name.trim().is_empty() {
                p.name = if p.mode == "local" {
                    "本机"
                } else {
                    "Pibo service"
                }
                .into();
            }
            // No lock is held during network/MFA waits. A later disconnect,
            // configure or connect invalidates this attempt before installation.
            let epoch = state.lock().await.connection_epoch.clone();
            let version = epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let builtin = state.lock().await.builtin.clone();
            if method == "runtime/builtinRestart" {
                let mut s = state.lock().await;
                if s.active.as_ref().is_some_and(|(_, p, _)| p.mode == "builtin") {
                    for (_, stream) in s.streams.drain() { stream.abort(); }
                    s.active = None;
                    s.forms.clear();
                }
                drop(s);
                builtin.stop().await?;
            }
            let endpoint = if p.mode == "builtin" {
                // The manager checks cancellation while holding its operation
                // lease; dropping an in-flight future cannot orphan the child.
                Some(Arc::new(builtin.connect(epoch.clone(), version).await?))
            } else if method == "runtime/connect" {
                let cancelled = async {
                    loop {
                        if epoch.load(std::sync::atomic::Ordering::SeqCst) != version {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                };
                let connection = async {
                    if p.mode == "tailnet" || p.mode == "direct" {tailnet_transport::connect(&p).await}
                    else {transport::connect(&p).await}
                };
                Some(Arc::new(tokio::select! {
                    _=cancelled=>return Err("连接已取消".into()),
                    result=tokio::time::timeout(std::time::Duration::from_secs(180),connection)=>result.map_err(|_|"连接总时限已到，请重试")??,
                }))
            } else {
                None
            };
            let mut s = state.lock().await;
            if epoch.load(std::sync::atomic::Ordering::SeqCst) != version {
                return Err("连接已被更新操作取消".into());
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
                if s.profiles.len() >= 33 {
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
) -> Result<Reply, pi_settings_security::RequestError> {
    use pi_settings_security::{Action, RequestError};
    main_window(&window).map_err(|e| RequestError::new("nativePolicyDenied", e))?;
    if body.len() > 1024 * 1024 {
        return Err(RequestError::new("nativePolicyDenied", "Request too large"));
    }
    let (endpoint, suffix) = state.lock().await.route(&path)
        .map_err(|e| RequestError::new("runtimeChanged", e))?;
    match pi_settings_security::classify(&suffix, &method, &body)? {
        Action::Select { flow, prompt, value } => {
            let current = pi_settings_security::read_login(&endpoint, &flow).await?;
            pi_settings_security::validate_select(&current, &flow, &prompt, &value)?;
        }
        Action::Cancel { flow } => {
            // Invalidate just this flow's secure windows before sending cancel.
            state.lock().await.invalidate_pi_forms(&endpoint, &flow);
        }
        Action::Forward => {}
    }
    if !state.lock().await.active.as_ref().is_some_and(|(_, _, active)| Arc::ptr_eq(active, &endpoint)) {
        return Err(RequestError::new("runtimeChanged", "运行环境已切换，请重新打开设置"));
    }
    request_reply(&endpoint, &suffix, &method, &body, &connection, std::time::Duration::from_secs(30)).await
}
async fn request_reply(
    endpoint: &Endpoint, path: &str, method: &str, body: &str, connection: &str, pi_timeout: std::time::Duration,
) -> Result<Reply, pi_settings_security::RequestError> {
    use pi_settings_security::RequestError;
    let request = async {
    let response = endpoint.request(path, method, body, connection).await
        .map_err(|e| RequestError::transport(e, method == "POST"))?;
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
        .map_err(|_| RequestError::transport("无法读取 runtime 响应", method == "POST"))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(RequestError::transport("Runtime response too large", method == "POST"));
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

    };
    if path.starts_with("/pi/") {
        tokio::time::timeout(pi_timeout, request).await
            .map_err(|_| RequestError::transport("模型设置请求超时，请检查登录状态；不会自动重试", method == "POST"))?
    } else {
        request.await
    }
}

#[tauri::command]
fn pi_settings_capabilities() -> serde_json::Value { serde_json::json!({"modelConnectionsVersion":1}) }

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
    s.forms.insert(label, SecureForm { endpoint, target: FormTarget::Credential(path), claimed: false });
    Ok(())
}
#[tauri::command]
async fn pi_settings_open_login(
    window: tauri::Window, app: tauri::AppHandle, state: tauri::State<'_, Shared>, path: String, url: String,
) -> Result<(), pi_settings_security::RequestError> {
    use pi_settings_security::RequestError;
    main_window(&window).map_err(|e| RequestError::new("nativePolicyDenied", e))?;
    let (endpoint, suffix) = state.lock().await.route(&path).map_err(|e| RequestError::new("runtimeChanged", e))?;
    let flow = pi_settings_security::flow_path(&suffix).ok_or_else(|| RequestError::new("nativePolicyDenied", "Invalid Pi login path"))?;
    let current = pi_settings_security::read_login(&endpoint, flow).await?;
    pi_settings_security::validate_login_url(&current, flow, &url)?;
    let s = state.lock().await;
    if !s.active.as_ref().is_some_and(|(_, _, active)| Arc::ptr_eq(active, &endpoint)) {
        return Err(RequestError::new("runtimeChanged", "运行环境已切换，请重新打开设置"));
    }
    // Only an explicit user action reaches this command. No general URL opener
    // is exposed to the WebView, and the Tailscale login session is untouched.
    file_export::open_model_login(&app, &url).await
        .map_err(|e| RequestError::new("browserOpenFailed", e))
}
#[tauri::command]
async fn pi_settings_credential_window(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, Shared>,
    path: String,
    prompt_id: String,
) -> Result<(), pi_settings_security::RequestError> {
    use pi_settings_security::RequestError;
    main_window(&window).map_err(|e| RequestError::new("nativePolicyDenied", e))?;
    let (endpoint, suffix) = state.lock().await.route(&path)
        .map_err(|e| RequestError::new("runtimeChanged", e))?;
    let flow = pi_settings_security::flow_path(&suffix)
        .ok_or_else(|| RequestError::new("nativePolicyDenied", "Invalid Pi login path"))?.to_owned();
    let current = pi_settings_security::read_login(&endpoint, &flow).await?;
    pi_settings_security::validate_secure(&current, &flow, &prompt_id)?;
    let mut s = state.lock().await;
    if !s.active.as_ref().is_some_and(|(_, _, active)| Arc::ptr_eq(active, &endpoint)) {
        return Err(RequestError::new("runtimeChanged", "运行环境已切换，请重新打开设置"));
    }
    s.forms.retain(|label, _| app.get_webview_window(label).is_some());
    // Double-clicking focuses the already-bound window rather than issuing a second form.
    for (label, form) in &s.forms {
        if form.belongs_to(&endpoint, &flow) {
            if let FormTarget::PiPrompt { prompt, .. } = &form.target {
                if prompt == &prompt_id {
                    if let Some(existing) = app.get_webview_window(label) { let _ = existing.set_focus(); }
                    return Ok(());
                }
            }
        }
    }
    if s.forms.len() >= 8 { return Err(RequestError::new("nativePolicyDenied", "请先关闭已有安全窗口")); }
    let label = format!("credential-{}", uuid::Uuid::new_v4());
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("credential.html".into()))
        .title("模型登录 · 安全输入").inner_size(420.0, 300.0).resizable(false).build()
        .map_err(|_| RequestError::new("nativePolicyDenied", "无法打开安全输入窗口"))?;
    s.forms.insert(label, SecureForm { endpoint, target: FormTarget::PiPrompt { flow, prompt: prompt_id }, claimed: false });
    Ok(())
}
async fn form_metadata(label: &str, state: &Shared) -> Result<pi_settings_security::CredentialMetadata, pi_settings_security::RequestError> {
    use pi_settings_security::{CredentialMetadata, RequestError};
    if !label.starts_with("credential-") { return Err(RequestError::new("nativePolicyDenied", "此命令只属于安全输入窗口")); }
    let form = {
        let s=state.lock().await;
        let Some(form)=s.forms.get(label) else { return Ok(CredentialMetadata::closed("expired")); };
        if !s.active.as_ref().is_some_and(|(_,_,active)|Arc::ptr_eq(active,&form.endpoint)) { return Ok(CredentialMetadata::closed("expired")); }
        form.clone()
    };
    let mut metadata=match &form.target {
        FormTarget::Credential(_) => CredentialMetadata {state:if form.claimed {"locked"} else {"pending"},field_type:"credential",label:"安全输入"},
        FormTarget::PiPrompt {flow,prompt} => match pi_settings_security::read_login(&form.endpoint,flow).await {
            Ok(current) => pi_settings_security::credential_metadata(&current,flow,prompt,form.claimed),
            Err(error) if error.code=="promptExpired" => CredentialMetadata::closed("expired"),
            Err(error) => return Err(error),
        }
    };
    let mut s=state.lock().await;
    if !s.forms.contains_key(label) || !s.active.as_ref().is_some_and(|(_,_,active)|Arc::ptr_eq(active,&form.endpoint)) {
        return Ok(CredentialMetadata::closed("expired"));
    }
    if metadata.state=="pending" && s.forms.get(label).is_some_and(|form|form.claimed) {metadata.state="locked";}
    if metadata.is_terminal() {s.forms.remove(label);}
    Ok(metadata)
}
#[tauri::command]
async fn credential_form_metadata(window: tauri::Window, state: tauri::State<'_, Shared>) -> Result<pi_settings_security::CredentialMetadata, pi_settings_security::RequestError> {
    let metadata=form_metadata(window.label(),state.inner()).await?;
    // This command can close only its own bound secure window, never another flow.
    if metadata.is_terminal() {let _=window.close();}
    Ok(metadata)
}
#[tauri::command]
async fn pi_settings_close_forms(window: tauri::Window, app: tauri::AppHandle, state: tauri::State<'_, Shared>, path: String) -> Result<usize, pi_settings_security::RequestError> {
    use pi_settings_security::RequestError;
    main_window(&window).map_err(|e| RequestError::new("nativePolicyDenied",e))?;
    let (endpoint,suffix)=state.lock().await.route(&path).map_err(|e| RequestError::new("runtimeChanged",e))?;
    let flow=pi_settings_security::flow_path(&suffix).ok_or_else(||RequestError::new("nativePolicyDenied","Invalid Pi login path"))?;
    let terminal=match pi_settings_security::read_login(&endpoint,flow).await {
        Ok(current) => current["id"]==flow && matches!(current["status"].as_str(),Some("complete"|"cancelled"|"failed")),
        Err(error) if error.code=="promptExpired" => true,
        Err(error) => return Err(error),
    };
    if !terminal {return Ok(0);}
    let labels=state.lock().await.take_pi_form_labels(&endpoint,flow);
    for label in &labels {if let Some(window)=app.get_webview_window(label) {let _=window.close();}}
    Ok(labels.len())
}
#[tauri::command]
async fn credential_submit(
    window: tauri::Window,
    state: tauri::State<'_, Shared>,
    secret: String,
) -> Result<(), String> {
    submit_credential(window.label(), state.inner(), secret).await
}
async fn submit_credential(label: &str, state: &Shared, secret: String) -> Result<(), String> {
    let secret = zeroize::Zeroizing::new(secret);
    if !label.starts_with("credential-") || secret.trim().is_empty() || secret.len() > 16000 {
        return Err("Invalid secure form submission".into());
    }
    let form = {
        let mut s = state.lock().await;
        let form = s.forms.get_mut(label).ok_or("Form is no longer active; reopen it from settings")?;
        if form.claimed { return Err("Submission already attempted; check login status".into()); }
        form.claimed = true;
        form.clone()
    };
    let prepared: Result<_, String> = async {
        match &form.target {
            FormTarget::Credential(path) => Ok((path.clone(), zeroize::Zeroizing::new(json!({"secret":secret.as_str()}).to_string()))),
            FormTarget::PiPrompt { flow, prompt } => {
                let current = pi_settings_security::read_login(&form.endpoint, flow).await.map_err(|e| e.message)?;
                pi_settings_security::validate_secure(&current, flow, prompt).map_err(|e| e.message)?;
                Ok((format!("/pi/login/{flow}/input"), pi_settings_security::secure_body(prompt, &secret).map_err(|e| e.message)?))
            }
        }
    }.await;
    let mut s = state.lock().await;
    let still_valid = s.forms.contains_key(label)
        && s.active.as_ref().is_some_and(|(_, _, active)| Arc::ptr_eq(active, &form.endpoint));
    if !still_valid { return Err("登录已取消或运行环境已切换，请重新打开安全输入窗口".into()); }
    let (path, body) = match prepared { Ok(value)=>value, Err(error)=>{s.forms.remove(label);return Err(error);} };
    if matches!(form.target,FormTarget::Credential(_)) {s.forms.remove(label);}
    // Serialize the final bounded POST against cancel/runtime switching. A cancel
    // that already invalidated the form can never be followed by a late answer.
    let response = tokio::time::timeout(std::time::Duration::from_secs(30), form.endpoint.request(&path, "POST", &body, ""))
        .await.map_err(|_| "提交结果尚未确认，请检查登录状态；不会自动重试")??;
    drop(s);
    if !response.status().is_success() { return Err("Credential submission not confirmed; check login status".into()); }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_page_load(|_webview, _payload| {
            #[cfg(target_os = "ios")]
            if _webview.label() == "main" && matches!(_payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = _webview.with_webview(|native| unsafe {
                    extern "C" { fn pibo_configure_ios_viewport(webview: *mut std::ffi::c_void); }
                    pibo_configure_ios_viewport(native.inner());
                });
            }
        })
        .setup(|app| {
            #[cfg(all(feature="embedded-tailscale", target_os="android"))]
            tailscale::set_android_cache(app.path().app_cache_dir()?);
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
            let app_data = app.path().app_data_dir()?;
            let file = app_data.join("profiles.json");
            let builtin = builtin_harness::Harness::new(app.path().resource_dir()?, app_data);
            let mut profiles = std::fs::read(&file)
                .ok()
                .and_then(|b| serde_json::from_slice::<Vec<Profile>>(&b).ok())
                .filter(|p|valid_saved_profiles(p,cfg!(any(target_os="ios",target_os="android"))))
                .unwrap_or_default();
            if !cfg!(any(target_os="ios", target_os="android")) {
                // Remove only the old, never-usable default. Real local daemon
                // profiles and all saved remote connections remain untouched.
                profiles.retain(|p| p.id != builtin_harness::PROFILE_ID && !(p.id == "local" && p.mode == "local" && p.data_dir == "/path/to/existing/pi-bot/data"));
                profiles.insert(0, builtin_harness::profile());
            }
            #[cfg(all(debug_assertions, target_os = "ios", feature="client-fixtures"))]
            let fixture = ios_probe::profile();
            #[cfg(all(debug_assertions, target_os = "ios", feature="client-fixtures"))]
            let profiles = fixture.clone().map(|p| vec![p]).unwrap_or(profiles);
            app.manage(Mutex::new(State {
                profiles,
                active: None,
                file,
                builtin,
                connection_epoch: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                login_epoch: Arc::new(std::sync::atomic::AtomicU64::new(0)),
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
            #[cfg(all(debug_assertions, target_os = "ios", feature="client-fixtures"))]
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
            runtime_distribution_status,
            runtime_install,
            runtime_control,
            runtime_request,
            desktop_open,
            stream_open,
            stream_close,
            credential_window,
            pi_settings_credential_window,
            pi_settings_open_login,
            credential_submit,
            credential_form_metadata,
            pi_settings_close_forms,
            pi_settings_capabilities,
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
                        let builtin = {
                            let shared = handle.state::<Shared>();
                            let mut state = shared.lock().await;
                            state.retire();
                            state.builtin.clone()
                        };
                        let _ = builtin.stop().await;
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

#[cfg(test)]
mod secure_form_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, sync::Notify};
    struct Fixture {
        endpoint: Arc<Endpoint>,
        state: Arc<Shared>,
        seen: Arc<Notify>,
        release: Arc<Notify>,
        posts: Arc<AtomicUsize>,
        server: tokio::task::JoinHandle<()>,
    }
    impl Drop for Fixture { fn drop(&mut self) { self.server.abort(); } }
    async fn fixture(status: &str, prompt: &str) -> Fixture {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = Arc::new(Endpoint { base: reqwest::Url::parse(&format!("http://{address}")).unwrap(), remote_host: address.to_string(), token: "synthetic-test-token".into(), desktop_origin: None, client: transport::client().unwrap(), #[cfg(not(any(target_os="ios",target_os="android")))] _tunnel: None, _embedded: None });
        let seen = Arc::new(Notify::new()); let release = Arc::new(Notify::new()); let posts = Arc::new(AtomicUsize::new(0));
        let (server_seen, server_release, server_posts) = (seen.clone(), release.clone(), posts.clone());
        let public = json!({"id":"flow-1","status":status,"prompt":{"id":prompt,"type":"secret"}}).to_string();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut data=Vec::new(); let header_end;
                loop { let mut bytes=[0;1024]; let n=stream.read(&mut bytes).await.unwrap(); if n==0 {return;} data.extend_from_slice(&bytes[..n]); if let Some(i)=data.windows(4).position(|w| w==b"\r\n\r\n") {header_end=i+4;break;} }
                let header=String::from_utf8_lossy(&data[..header_end]);
                let post=header.starts_with("POST /pi/login/flow-1/input ");
                let length=header.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);
                while data.len()<header_end+length { let mut bytes=[0;1024]; let n=stream.read(&mut bytes).await.unwrap();if n==0 {return;} data.extend_from_slice(&bytes[..n]); }
                let response = if post {
                    assert_eq!(serde_json::from_slice::<Value>(&data[header_end..]).unwrap(),json!({"promptId":"prompt-1","value":"synthetic-only"}));
                    server_posts.fetch_add(1,Ordering::SeqCst); "{\"submitted\":true}"
                } else { server_seen.notify_one(); server_release.notified().await; &public };
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(),response).as_bytes()).await.unwrap();
            }
        });
        let unused=std::env::temp_dir().join(format!("pibo-policy-test-{}",uuid::Uuid::new_v4()));
        let mut forms=HashMap::new();
        for (label, flow) in [("credential-test","flow-1"),("credential-other","flow-2")] {
            forms.insert(label.into(), SecureForm {endpoint:endpoint.clone(),target:FormTarget::PiPrompt {flow:flow.into(),prompt:"prompt-1".into()},claimed:false});
        }
        let state=Arc::new(Mutex::new(State { profiles:vec![],active:Some(("test".into(),Profile::local("test","Test","/synthetic-unused"),endpoint.clone())),file:unused.join("profiles.json"),builtin:builtin_harness::Harness::new(unused.join("resources"),unused),connection_epoch:Arc::new(std::sync::atomic::AtomicU64::new(0)),login_epoch:Arc::new(std::sync::atomic::AtomicU64::new(0)),streams:HashMap::new(),forms }));
        Fixture { endpoint,state,seen,release,posts,server }
    }
    fn submit(state: Arc<Shared>) -> tokio::task::JoinHandle<Result<(), String>> {
        tokio::spawn(async move {submit_credential("credential-test",&state,"synthetic-only".into()).await})
    }
    async fn result(task: tokio::task::JoinHandle<Result<(), String>>) -> Result<(), String> {
        tokio::time::timeout(std::time::Duration::from_secs(5),task).await.unwrap().unwrap()
    }
    #[tokio::test]
    async fn metadata_closes_only_the_bound_completed_form() {
        let f=fixture("complete","prompt-1").await;f.release.notify_one();
        let metadata=form_metadata("credential-test",&f.state).await.unwrap();
        assert_eq!(metadata.state,"complete");assert_eq!(metadata.field_type,"none");
        let state=f.state.lock().await;assert!(!state.forms.contains_key("credential-test"));assert!(state.forms.contains_key("credential-other"));
        assert_eq!(f.posts.load(Ordering::SeqCst),0);
    }
    #[tokio::test]
    async fn metadata_denies_main_window_and_scope_cleanup_preserves_other_endpoints() {
        let f=fixture("pending","prompt-1").await;let other=fixture("pending","prompt-1").await;
        assert_eq!(form_metadata("main",&f.state).await.unwrap_err().code,"nativePolicyDenied");
        let mut state=f.state.lock().await;
        state.forms.insert("credential-other-runtime".into(),SecureForm {endpoint:other.endpoint.clone(),target:FormTarget::PiPrompt {flow:"flow-1".into(),prompt:"prompt-1".into()},claimed:false});
        assert_eq!(state.take_pi_form_labels(&f.endpoint,"flow-1"),vec!["credential-test"]);
        assert!(state.forms.contains_key("credential-other-runtime"));assert!(state.forms.contains_key("credential-other"));
    }
    #[tokio::test]
    async fn submitted_pi_form_keeps_only_locked_metadata_until_its_flow_ends() {
        let f=fixture("pending","prompt-1").await;f.release.notify_one();assert!(result(submit(f.state.clone())).await.is_ok());
        f.release.notify_one();let metadata=form_metadata("credential-test",&f.state).await.unwrap();
        assert_eq!(metadata.state,"locked");assert!(result(submit(f.state.clone())).await.is_err());assert_eq!(f.posts.load(Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn cancel_during_prompt_check_prevents_late_secret_post_and_preserves_other_flow() {
        let f=fixture("pending","prompt-1").await;let task=submit(f.state.clone()); f.seen.notified().await;
        f.state.lock().await.invalidate_pi_forms(&f.endpoint,"flow-1"); f.release.notify_one();
        assert!(result(task).await.is_err());assert_eq!(f.posts.load(Ordering::SeqCst),0);
        assert!(f.state.lock().await.forms.contains_key("credential-other"));
    }
    #[tokio::test]
    async fn runtime_switch_during_prompt_check_prevents_late_secret_post() {
        let f=fixture("pending","prompt-1").await;let task=submit(f.state.clone());f.seen.notified().await;
        f.state.lock().await.retire();f.release.notify_one();
        assert!(result(task).await.is_err());assert_eq!(f.posts.load(Ordering::SeqCst),0);
    }
    #[tokio::test]
    async fn repeated_submission_is_not_replayed_and_one_bound_post_succeeds() {
        let f=fixture("pending","prompt-1").await;let first=submit(f.state.clone());f.seen.notified().await;
        assert!(result(submit(f.state.clone())).await.is_err());f.release.notify_one();assert!(result(first).await.is_ok());
        assert!(result(submit(f.state.clone())).await.is_err());assert_eq!(f.posts.load(Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn server_cancelled_or_replaced_prompt_is_never_submitted() {
        for (status,prompt) in [("cancelled","prompt-1"),("pending","new-prompt")] {
            let f=fixture(status,prompt).await;let task=submit(f.state.clone());f.seen.notified().await;f.release.notify_one();
            assert!(result(task).await.is_err());assert_eq!(f.posts.load(Ordering::SeqCst),0);
        }
    }
}

#[cfg(test)]
mod pi_request_timeout_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn endpoint(partial_body: bool, eventually_reply: bool) -> (Endpoint, tokio::task::JoinHandle<()>) {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            let (mut stream,_)=listener.accept().await.unwrap();let mut bytes=[0;4096];let _=stream.read(&mut bytes).await.unwrap();
            if partial_body {stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{").await.unwrap();}
            if eventually_reply {
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}").await.unwrap();
            } else {std::future::pending::<()>().await;}
        });
        (Endpoint {base:reqwest::Url::parse(&format!("http://{address}")).unwrap(),remote_host:address.to_string(),token:"synthetic-test-token".into(),desktop_origin:None,client:transport::client().unwrap(),#[cfg(not(any(target_os="ios",target_os="android")))] _tunnel:None,_embedded:None},server)
    }
    #[tokio::test]
    async fn pi_header_and_body_stalls_return_bounded_uncertainty_without_replay() {
        for partial in [false,true] { for method in ["GET","POST"] {
            let (ep,server)=endpoint(partial,false).await;
            let result=request_reply(&ep,"/pi/login",method,"{}","",std::time::Duration::from_millis(40)).await;
            let error=match result {Err(error)=>error,Ok(_)=>panic!("stalled Pi response unexpectedly succeeded")};
            assert_eq!(error.code,"connectionLost");assert_eq!(error.submitted,method=="POST");server.abort();
        }}
    }
    #[tokio::test]
    async fn pi_deadline_does_not_change_ordinary_rpc_transport() {
        let (ep,server)=endpoint(false,true).await;
        let result=request_reply(&ep,"/rpc","POST","{}","",std::time::Duration::from_millis(1)).await.unwrap();
        assert_eq!(result.status,200);assert_eq!(result.body,"{}");server.await.unwrap();
    }
}
