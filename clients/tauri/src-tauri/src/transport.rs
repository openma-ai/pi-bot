use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use std::path::PathBuf;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tokio::process::Child;

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub embedded_tailscale: bool,
    #[serde(default)]
    pub data_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key: Option<String>,
}
impl Profile {
    pub fn local(id: &str, name: &str, path: &str) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            mode: "local".into(),
            url: None,
            embedded_tailscale: false,
            data_dir: path.into(),
            host: None,
            project_dir: None,
            ssh_port: None,
            config_file: None,
            server_port: None,
            node: None,
            agent_dir: None,
            host_key: None,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.mode == "ssh" { return Err("SSH 连接已停用；请新建 Tailscale 或 HTTPS 服务连接并使用服务访问密码登录，旧配置不会自动迁移".into()); }
        if !["local", "builtin", "direct", "tailnet"].contains(&self.mode.as_str())
            || (self.mode == "local" && self.data_dir.is_empty())
            || self.data_dir.len() > 2048
            || self.data_dir.chars().any(|c| c.is_control())
        {
            return Err("请检查 runtime 目录".into());
        }
        if self.mode == "builtin" && (!self.data_dir.is_empty() || self.url.is_some() || self.host.is_some() || self.project_dir.is_some() || self.ssh_port.is_some() || self.config_file.is_some() || self.server_port.is_some() || self.node.is_some() || self.agent_dir.is_some() || self.host_key.is_some() || self.embedded_tailscale || (!self.id.is_empty() && self.id != crate::builtin_harness::PROFILE_ID)) {
            return Err("本机引擎路径和连接由应用管理".into());
        }
        if self.embedded_tailscale && self.mode != "tailnet" { return Err("内嵌 Tailscale 仅用于设备选择连接".into()); }
        if self.name.len() > 300 || self.name.chars().any(|c| c.is_control()) {
            return Err("Invalid runtime name".into());
        }
        if self.mode == "direct" { crate::direct_transport::address(self)?; }
        if self.mode == "tailnet" {
            crate::tailnet_transport::destination(self)?;
        }
        if self.id.len() > 64
            || !self
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
        {
            return Err("Invalid profile ID".into());
        }
        if self.ssh_port == Some(0) {
            return Err("Invalid SSH port".into());
        }
        if self
            .config_file
            .as_ref()
            .is_some_and(|p| p.chars().any(|c| c.is_control()))
        {
            return Err("Invalid SSH configuration path".into());
        }
        if self
            .host_key
            .as_ref()
            .is_some_and(|key| key.len() > 4096 || key.chars().any(|c| c.is_control()))
        {
            return Err("Invalid SSH host public key".into());
        }
        Ok(())
    }
}
pub struct Endpoint {
    pub base: Url,
    pub remote_host: String,
    pub(crate) token: String,
    pub(crate) desktop_origin: Option<String>,
    pub(crate) client: Client,
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    pub(crate) _tunnel: Option<Child>,
    pub(crate) _embedded: Option<Tunnel>,
}
pub struct Tunnel { pub(crate) task: tokio::task::JoinHandle<()> }
impl Drop for Tunnel { fn drop(&mut self) {self.task.abort();} }
impl Endpoint {
    pub async fn request(
        &self,
        path: &str,
        method: &str,
        body: &str,
        connection: &str,
    ) -> Result<reqwest::Response, String> {
        if !["GET", "POST"].contains(&method) {
            return Err("Unsupported method".into());
        }
        let request = self
            .client
            .request(
                Method::from_bytes(method.as_bytes()).unwrap(),
                format!("{}{}", self.base.as_str().trim_end_matches('/'), path),
            )
            .header("Host", &self.remote_host)
            .bearer_auth(&self.token)
            .header("X-PiBot-Connection", connection)
            .header("Content-Type", "application/json")
            .body(body.to_string());
        let request = if cfg!(any(target_os = "ios", target_os = "android"))
            && !path.starts_with("/events")
        {
            request.timeout(Duration::from_secs(30))
        } else {
            request
        };
        request
            .send()
            .await
            .map_err(|_| "无法连接 runtime，请检查服务是否已独立启动".into())
    }
}
pub(crate) fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Cannot initialize transport".into())
}
pub(crate) fn discovery(text: &str, token: &str) -> Result<(Url, String), String> {
    let d: Value = serde_json::from_str(text).map_err(|_| "Runtime discovery is invalid")?;
    if d["protocolVersion"] != "2026-10-13" {
        return Err(
            "Runtime protocol incompatible; update the independently managed runtime".into(),
        );
    }
    let u = Url::parse(d["http"].as_str().ok_or("Missing runtime endpoint")?)
        .map_err(|_| "Invalid runtime endpoint")?;
    if u.scheme() != "http"
        || u.host_str() != Some("127.0.0.1")
        || u.port().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("Only a discovered loopback runtime is supported".into());
    }
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(
            "Runtime authentication unavailable; manage it in the runtime installation".into(),
        );
    }
    let host = format!("127.0.0.1:{}", u.port().unwrap());
    Ok((u, host))
}
#[cfg(feature="client-fixtures")]
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}
#[cfg(feature="client-fixtures")]
pub(crate) fn remote_path(path: &str) -> String {
    if let Some(tail) = path.strip_prefix("~/") {
        format!("\"$HOME\"/{}", quote(tail))
    } else {
        quote(path)
    }
}
pub(crate) async fn ready(endpoint: &Endpoint) -> Result<(), String> {
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        endpoint
            .client
            .get(endpoint.base.join("readyz").unwrap())
            .header("Host", &endpoint.remote_host)
            .send(),
    )
    .await
    .map_err(|_| "Runtime timeout")?
    .map_err(|_| "Runtime unavailable; start it independently")?;
    if !response.status().is_success() {
        return Err("Runtime unavailable; start it independently".into());
    }
    Ok(())
}
pub async fn connect(p: &Profile) -> Result<Endpoint, String> {
    p.validate()?;
    #[cfg(not(any(target_os="ios",target_os="android")))]
    if p.mode == "local" {
        let path = PathBuf::from(&p.data_dir);
        if !path.is_absolute() {
            return Err("本地 runtime 数据目录必须为绝对路径".into());
        }
        let data = std::fs::read_to_string(path.join("daemon.json"))
            .map_err(|_| "未找到运行中的 runtime；请独立启动 pi-bot daemon 后填写其数据目录")?;
        // The renderer never receives the existing runtime transport credential.
        let token = std::fs::read_to_string(path.join("daemon.token"))
            .map_err(|_| "Runtime authentication unavailable")?;
        let (base, remote_host) = discovery(&data, token.trim())?;
        let endpoint = Endpoint {
            base,
            desktop_origin: Some(format!("http://{remote_host}")),
            remote_host,
            token: token.trim().into(),
            client: client()?,
            _tunnel: None,
            _embedded: None,
        };
        ready(&endpoint).await?;
        return Ok(endpoint);
    }
    Err("请使用 Tailscale 或 HTTPS 服务连接；移动客户端不支持本机数据目录".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_route_requires_remote_profile_and_host_pin() {
        let mut p = Profile::local("fixture", "fixture", "/tmp/fixture");
        p.embedded_tailscale = true;
        assert!(p.validate().is_err());
        p.mode = "ssh".into();
        p.host = Some("user@pibo.tail.ts.net".into());
        p.project_dir = Some("~/pi-bot".into());
        assert!(p.validate().is_err());
        p.host_key = Some("ssh-ed25519 checked-separately".into());
        assert!(p.validate().is_err());
        let old: Profile =
            serde_json::from_str(r#"{"mode":"local","dataDir":"/tmp/fixture"}"#).unwrap();
        assert!(!old.embedded_tailscale);
        assert!(!serde_json::to_value(old)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("embeddedTailscale"));
    }
    #[test]
    fn discovery_rejects_non_loopback_and_credentials() {
        let token = "a".repeat(64);
        assert!(discovery(
            r#"{"protocolVersion":"2026-10-13","http":"http://127.0.0.1:4318"}"#,
            &token
        )
        .is_ok());
        assert!(discovery(
            r#"{"protocolVersion":"2026-10-13","http":"http://evil.example:4318"}"#,
            &token
        )
        .is_err());
        assert!(discovery(
            r#"{"protocolVersion":"2026-10-13","http":"http://user:secret@127.0.0.1:4318"}"#,
            &token
        )
        .is_err());
        assert!(discovery(
            r#"{"protocolVersion":"old","http":"http://127.0.0.1:4318"}"#,
            &token
        )
        .is_err());
    }
    #[test]
    fn missing_runtime_never_launches_node() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            assert!(connect(&Profile::local(
                "local",
                "local",
                "/tmp/pi-bot-no-such-runtime-fixture"
            ))
            .await
            .unwrap_err_text()
            .contains("runtime"));
        });
    }
    #[test]
    fn tunneled_http_keeps_remote_host_and_native_auth() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut bytes = [0u8; 8192];
            let n = socket.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]).to_lowercase();
            assert!(request.contains("host: 127.0.0.1:4318"));
            assert!(request.contains(&format!("authorization: bearer {}", "a".repeat(64))));
            assert!(request.contains("x-pibot-connection: fixture-connection"));
            let body="data: {\"method\":\"item/agentMessage/delta\",\"params\":{\"textDelta\":\"fixture\"}}\n\n";
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{}",body.len(),body).unwrap();
        });
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let endpoint = Endpoint {
                base: Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),
                remote_host: "127.0.0.1:4318".into(),
                token: "a".repeat(64),
                desktop_origin: None,
                client: client().unwrap(),
                _tunnel: None,
                _embedded: None,
            };
            let response = endpoint
                .request(
                    "/events?connection=fixture-connection",
                    "GET",
                    "",
                    "fixture-connection",
                )
                .await
                .unwrap();
            assert!(response.text().await.unwrap().contains("textDelta"));
        });
        server.join().unwrap();
    }
    trait ErrorText {
        fn unwrap_err_text(self) -> String;
    }
    impl ErrorText for Result<Endpoint, String> {
        fn unwrap_err_text(self) -> String {
            match self {
                Err(e) => e,
                Ok(_) => panic!("Unexpected connection"),
            }
        }
    }
}
