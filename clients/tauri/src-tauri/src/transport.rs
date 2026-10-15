use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "ios"))]
use serde_json::Value;
#[cfg(not(target_os = "ios"))]
use std::time::Duration;
#[cfg(not(target_os = "ios"))]
use std::{path::PathBuf, process::Stdio};
#[cfg(not(target_os = "ios"))]
use tokio::process::{Child, Command};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub mode: String,
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
}
impl Profile {
    pub fn local(id: &str, name: &str, path: &str) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            mode: "local".into(),
            data_dir: path.into(),
            host: None,
            project_dir: None,
            ssh_port: None,
            config_file: None,
            server_port: None,
            node: None,
            agent_dir: None,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if !["local", "ssh"].contains(&self.mode.as_str())
            || self.data_dir.is_empty()
            || self.data_dir.len() > 2048
            || self.data_dir.chars().any(|c| c.is_control())
        {
            return Err("请检查 runtime 目录".into());
        }
        if self.name.len() > 300 || self.name.chars().any(|c| c.is_control()) {
            return Err("Invalid runtime name".into());
        }
        if self.mode == "ssh" {
            let h = self.host.as_deref().unwrap_or("");
            if h.is_empty()
                || h.len() > 255
                || h.starts_with('-')
                || !h
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_.-:@".contains(c))
            {
                return Err("Invalid SSH host".into());
            }
            let p = self.project_dir.as_deref().unwrap_or("");
            if !(p.starts_with('/') || p.starts_with("~/")) || p.chars().any(|c| c.is_control()) {
                return Err("SSH project directory must be absolute or ~/…".into());
            }
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
        Ok(())
    }
}
pub struct Endpoint {
    pub base: Url,
    pub remote_host: String,
    token: String,
    client: Client,
    #[cfg(not(target_os = "ios"))]
    _tunnel: Option<Child>,
}
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
        self.client
            .request(
                Method::from_bytes(method.as_bytes()).unwrap(),
                format!("{}{}", self.base.as_str().trim_end_matches('/'), path),
            )
            .header("Host", &self.remote_host)
            .bearer_auth(&self.token)
            .header("X-PiBot-Connection", connection)
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|_| "无法连接 runtime，请检查服务是否已独立启动".into())
    }
}
#[cfg(not(target_os = "ios"))]
fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Cannot initialize transport".into())
}
#[cfg(not(target_os = "ios"))]
fn discovery(text: &str, token: &str) -> Result<(Url, String), String> {
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
#[cfg(not(target_os = "ios"))]
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}
#[cfg(not(target_os = "ios"))]
fn remote_path(path: &str) -> String {
    if let Some(tail) = path.strip_prefix("~/") {
        format!("\"$HOME\"/{}", quote(tail))
    } else {
        quote(path)
    }
}
#[cfg(not(target_os = "ios"))]
fn ssh_args(p: &Profile) -> Vec<String> {
    let mut args = vec![
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
    ]
    .into_iter()
    .map(String::from)
    .collect::<Vec<_>>();
    if let Some(port) = p.ssh_port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(file) = &p.config_file {
        args.extend(["-F".into(), file.clone()]);
    }
    args
}
#[cfg(not(target_os = "ios"))]
fn ssh_error() -> String {
    "SSH 连接失败：请检查已配置的密钥、可信主机指纹、路径和独立 runtime；客户端不会接受未知 host key 或启动远端服务".into()
}
#[cfg(not(target_os = "ios"))]
async fn ready(endpoint: &Endpoint) -> Result<(), String> {
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
#[cfg(target_os = "ios")]
pub async fn connect(p: &Profile) -> Result<Endpoint, String> {
    if p.mode != "ssh" {
        return Err("iPhone/iPad 仅支持远程 runtime".into());
    }
    Err("共享嵌入式 SSH adapter 尚在验证；iOS 不使用系统 ssh 或执行本地 runtime".into())
}
#[cfg(not(target_os = "ios"))]
pub async fn connect(p: &Profile) -> Result<Endpoint, String> {
    p.validate()?;
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
            remote_host,
            token: token.trim().into(),
            client: client()?,
            _tunnel: None,
        };
        ready(&endpoint).await?;
        return Ok(endpoint);
    }
    let mut args = ssh_args(p);
    args.push(p.host.clone().unwrap());
    args.push(format!(
        "cd {} && cat {}/daemon.json && printf '\\n' && cat {}/daemon.token",
        remote_path(p.project_dir.as_deref().unwrap()),
        remote_path(&p.data_dir),
        remote_path(&p.data_dir)
    ));
    let mut command = Command::new("ssh");
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| ssh_error())?
        .map_err(|_| ssh_error())?;
    if !output.status.success() || output.stdout.len() > 65536 {
        return Err(ssh_error());
    }
    let text = String::from_utf8(output.stdout).map_err(|_| ssh_error())?;
    let (data, token) = text.trim().rsplit_once('\n').ok_or_else(ssh_error)?;
    let (remote, remote_host) = discovery(data.trim(), token.trim())?;
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|_| "Cannot reserve local SSH port")?;
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut args = ssh_args(p);
    args.extend([
        "-N".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-L".into(),
        format!("127.0.0.1:{port}:127.0.0.1:{}", remote.port().unwrap()),
        p.host.clone().unwrap(),
    ]);
    let child = Command::new("ssh")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ssh_error())?;
    let endpoint = Endpoint {
        base: Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),
        remote_host,
        token: token.trim().into(),
        client: client()?,
        _tunnel: Some(child),
    };
    for _ in 0..40 {
        if tokio::time::timeout(Duration::from_millis(200), ready(&endpoint))
            .await
            .is_ok_and(|r| r.is_ok())
        {
            return Ok(endpoint);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(ssh_error())
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn ssh_keeps_strict_trust_and_quotes_paths() {
        let mut p = Profile::local("remote", "remote", "work/runtime");
        p.mode = "ssh".into();
        p.host = Some("user@host".into());
        p.project_dir = Some("~/pi-bot".into());
        assert!(p.validate().is_ok());
        let args = ssh_args(&p);
        assert!(args.contains(&"StrictHostKeyChecking=yes".into()));
        assert!(args.contains(&"ForwardAgent=no".into()));
        p.host = Some("-oProxyCommand=evil".into());
        assert!(p.validate().is_err());
        assert_eq!(quote("a'$(bad)"), "'a'\"'\"'$(bad)'");
        assert!(!serde_json::to_string(&p).unwrap().contains("token"));
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
                client: client().unwrap(),
                _tunnel: None,
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
