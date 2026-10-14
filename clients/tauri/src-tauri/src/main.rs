mod runtime_distribution;
mod transport;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use transport::{Endpoint, Profile};

struct State {
    profiles: Vec<Profile>,
    active: Option<(String, Profile, Arc<Endpoint>)>,
    file: PathBuf,
    streams: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
}
impl State {
    fn status(&self) -> Value {
        json!({"profiles":self.profiles,"connecting":false,"active":self.active.as_ref().map(|(id,p,_)|json!({"id":id,"profileId":p.id,"mode":p.mode,"baseUrl":format!("/runtime/{id}"),"scope":p.id,"label":p.name,"profile":p}))})
    }
    fn retire(&mut self) {
        for (_, handle) in self.streams.drain() {
            handle.abort();
        }
        // Dropping the endpoint terminates only the SSH forward owned by this client.
        self.active = None;
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
            || suffix.starts_with("/pi/"))
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
fn runtime_distribution_status() -> Value {
    runtime_distribution::status()
}
#[tauri::command]
fn runtime_install() -> Result<(), String> {
    runtime_distribution::install()
}

#[tauri::command]
async fn runtime_control(
    state: tauri::State<'_, Shared>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    match method.as_str() {
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
            if s.profiles.len() == 1 {
                return Err("至少保留一个 runtime".into());
            }
            s.profiles.retain(|p| p.id != id);
            s.persist()?;
            Ok(s.status())
        }
        "runtime/configure" | "runtime/connect" => {
            let mut p: Profile = serde_json::from_value(params["profile"].clone())
                .map_err(|_| "请检查 runtime 配置")?;
            p.validate()?;
            if cfg!(target_os = "ios") && p.mode != "ssh" {
                return Err("iPhone/iPad 仅支持远程 runtime".into());
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
            // Serialize connection changes to avoid out-of-order installation.
            let mut s = state.lock().await;
            let endpoint = if method == "runtime/connect" {
                Some(Arc::new(transport::connect(&p).await?))
            } else {
                None
            };
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
            }
            Ok(s.status())
        }
        _ => Err("Unknown runtime method".into()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    status: u16,
    body: String,
    content_type: String,
}
#[tauri::command]
async fn runtime_request(
    state: tauri::State<'_, Shared>,
    path: String,
    method: String,
    body: String,
    connection: String,
) -> Result<Reply, String> {
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
    Ok(Reply {
        status,
        body: String::from_utf8_lossy(&bytes).into(),
        content_type,
    })
}
#[tauri::command]
async fn stream_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, Shared>,
    id: String,
    path: String,
    connection: String,
) -> Result<(), String> {
    use futures_util::StreamExt;
    let (endpoint, suffix) = state.lock().await.route(&path)?;
    if !suffix.starts_with("/events") {
        return Err("Invalid stream".into());
    }
    let response = endpoint.request(&suffix, "GET", "", &connection).await?;
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
async fn stream_close(state: tauri::State<'_, Shared>, id: String) -> Result<(), String> {
    if let Some(task) = state.lock().await.streams.remove(&id) {
        task.abort();
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let file = app.path().app_data_dir()?.join("profiles.json");
            let profiles = std::fs::read(&file)
                .ok()
                .and_then(|b| serde_json::from_slice::<Vec<Profile>>(&b).ok())
                .filter(|p| {
                    !p.is_empty() && p.len() <= 32 && p.iter().all(|p| p.validate().is_ok())
                })
                .unwrap_or_else(|| {
                    vec![Profile::local(
                        "local",
                        "本机",
                        "/path/to/existing/pi-bot/data",
                    )]
                });
            app.manage(Mutex::new(State {
                profiles,
                active: None,
                file,
                streams: HashMap::new(),
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_distribution_status,
            runtime_install,
            runtime_control,
            runtime_request,
            stream_open,
            stream_close
        ])
        .build(tauri::generate_context!())
        .expect("Cannot build desktop application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle.state::<Shared>().lock().await.retire();
                        handle.exit(0);
                    });
                }
            }
        });
}
