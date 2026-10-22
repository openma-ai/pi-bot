//! Embedded SSH. Never accepts an unknown key, starts a remote runtime, or binds publicly.
use crate::transport::{client, discovery, remote_path, Endpoint, Profile};
use russh::{client as ssh, keys::PublicKeyOrCertificate, ChannelMsg};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};

pub struct PinnedHost(pub String);
impl ssh::Handler for PinnedHost {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key.certificate().is_none()
            && key.public_key().to_openssh().ok().as_deref() == Some(self.0.as_str()))
    }
}
pub fn canonical_key(text: &str) -> Result<String, String> {
    russh::keys::ssh_key::PublicKey::from_openssh(text.trim())
        .and_then(|mut key| {
            key.set_comment("");
            key.to_openssh()
        })
        .map_err(|_| "请填写通过可信渠道核验的完整 SSH 主机公钥（不是指纹）".into())
}
pub fn destination(p: &Profile) -> Result<(&str, &str), String> {
    let (user, host) = p
        .host
        .as_deref()
        .unwrap_or("")
        .split_once('@')
        .ok_or("iOS SSH 主机需明确填写 user@hostname，不支持桌面 SSH 别名")?;
    if user.is_empty() || host.is_empty() || host.contains('@') {
        return Err("请填写 user@hostname".into());
    }
    Ok((user, host))
}
pub struct Tunnel {
    pub(crate) task: JoinHandle<()>,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub type PromptFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<String>, String>> + Send>>;
pub type PromptHandler = Arc<dyn Fn(Vec<String>) -> PromptFuture + Send + Sync>;
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credentials {
    pub method: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub passphrase: String,
    #[serde(default)]
    pub interactive: bool,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.password.zeroize();
        self.private_key.zeroize();
        self.passphrase.zeroize();
    }
}
impl Credentials {
    pub fn password(value: &str) -> Self {
        Self {
            method: "password".into(),
            password: value.into(),
            private_key: String::new(),
            passphrase: String::new(),
            interactive: false,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.password.len() > 4096
            || self.passphrase.len() > 4096
            || self.private_key.len() > 131072
        {
            return Err("SSH 凭据过大".into());
        }
        match self.method.as_str() {
            "password" if !self.password.is_empty() => Ok(()),
            "privateKey" => {
                self.key()?;
                Ok(())
            }
            "interactive" => Ok(()),
            _ => Err("请选择 SSH 认证方式并输入凭据".into()),
        }
    }
    fn key(&self) -> Result<russh::keys::PrivateKey, String> {
        let key = russh::keys::decode_secret_key(
            &self.private_key,
            if self.passphrase.is_empty() {
                None
            } else {
                Some(&self.passphrase)
            },
        )
        .map_err(|_| {
            "无法解密或识别私钥：检查格式与口令；支持 OpenSSH/PEM Ed25519 和 RSA".to_string()
        })?;
        if !matches!(
            key.algorithm(),
            russh::keys::Algorithm::Ed25519 | russh::keys::Algorithm::Rsa { .. }
        ) {
            return Err("当前仅支持 Ed25519/RSA 软件私钥；不支持硬件密钥、SSH agent 或证书".into());
        }
        Ok(key)
    }
}
pub async fn connect(p: &Profile, password: &str) -> Result<Endpoint, String> {
    connect_authenticated(p, &Credentials::password(password), None).await
}
pub async fn connect_authenticated(
    p: &Profile,
    credentials: &Credentials,
    prompt: Option<PromptHandler>,
) -> Result<Endpoint, String> {
    p.validate()?;
    if p.mode != "ssh" {
        return Err("移动客户端仅支持远程 runtime".into());
    }
    let (user, host) = destination(p)?;
    let pin = canonical_key(p.host_key.as_deref().ok_or("请先核验并保存 SSH 主机公钥")?)?;
    credentials.validate()?;
    let config = Arc::new(ssh::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 2,
        ..Default::default()
    });
    let mut session = tokio::time::timeout(Duration::from_secs(12), async {
        if p.embedded_tailscale {
            let stream = crate::tailscale::dial(host, p.ssh_port.unwrap_or(22))
                .await
                .map_err(|e| russh::Error::IO(std::io::Error::other(e)))?;
            ssh::connect_stream(config, stream, PinnedHost(pin)).await
        } else {
            ssh::connect(config, (host, p.ssh_port.unwrap_or(22)), PinnedHost(pin)).await
        }
    })
    .await
    .map_err(|_| "SSH 连接超时")?
    .map_err(|_| "SSH 连接失败：检查地址和已核验公钥，未知或变更的主机密钥会被拒绝")?;
    let authenticated = match credentials.method.as_str() {
        "password" => tokio::time::timeout(
            Duration::from_secs(20),
            session.authenticate_password(user, &credentials.password),
        )
        .await
        .map_err(|_| "SSH 密码认证超时")?
        .map_err(|_| "SSH 密码认证连接中断")?
        .success(),
        "privateKey" => {
            let key = Arc::new(credentials.key()?);
            let hash = if key.algorithm().is_rsa() {
                Some(
                    session
                        .best_supported_rsa_hash()
                        .await
                        .map_err(|_| "无法协商 RSA SHA-2 算法")?
                        .flatten()
                        .ok_or("服务器不支持 RSA SHA-2；不会降级到 SHA-1")?,
                )
            } else {
                None
            };
            tokio::time::timeout(
                Duration::from_secs(20),
                session.authenticate_publickey(
                    user,
                    russh::keys::PrivateKeyWithHashAlg::new(key, hash),
                ),
            )
            .await
            .map_err(|_| "SSH 私钥认证超时")?
            .map_err(|_| "SSH 私钥认证连接中断")?
            .success()
        }
        _ => false,
    };
    if !authenticated {
        if credentials.method != "interactive" && !credentials.interactive {
            return Err(
                "SSH 认证被拒绝：检查用户名、密码/授权公钥；如需验证码，请启用交互验证".into(),
            );
        }
        use ssh::KeyboardInteractiveAuthResponse as Response;
        let handler = prompt.ok_or("SSH 需要交互验证，请在前台连接并完成验证")?;
        let mut response = tokio::time::timeout(
            Duration::from_secs(20),
            session.authenticate_keyboard_interactive_start(user, None),
        )
        .await
        .map_err(|_| "SSH 交互认证超时")?
        .map_err(|_| "服务器不支持交互认证")?;
        let mut success = false;
        for _ in 0..8 {
            match response {
                Response::Success => {
                    success = true;
                    break;
                }
                Response::Failure { .. } => {
                    return Err("SSH 交互验证被拒绝；请检查验证码或服务器认证方式".into())
                }
                Response::InfoRequest { prompts, .. } => {
                    if prompts.len() > 8 || prompts.iter().any(|p| p.prompt.len() > 512) {
                        return Err("服务器认证提示超出安全限制".into());
                    }
                    let count = prompts.len();
                    let answers = tokio::time::timeout(
                        Duration::from_secs(90),
                        handler(
                            prompts
                                .into_iter()
                                .map(|p| p.prompt.chars().filter(|c| !c.is_control()).collect())
                                .collect(),
                        ),
                    )
                    .await
                    .map_err(|_| "交互验证已超时，请重新连接")??;
                    if answers.len() != count || answers.iter().any(|a| a.len() > 4096) {
                        return Err("交互验证响应格式错误".into());
                    }
                    response = tokio::time::timeout(
                        Duration::from_secs(20),
                        session.authenticate_keyboard_interactive_respond(answers),
                    )
                    .await
                    .map_err(|_| "服务器验证响应超时")?
                    .map_err(|_| "SSH 交互认证中断")?;
                }
            }
        }
        if !success {
            return Err("交互验证轮次过多，请检查服务器认证配置".into());
        }
    }
    let command = format!(
        "cd {} && cat {}/daemon.json && printf '\\n' && cat {}/daemon.token",
        remote_path(p.project_dir.as_deref().unwrap()),
        remote_path(&p.data_dir),
        remote_path(&p.data_dir)
    );
    let text = tokio::time::timeout(Duration::from_secs(10), async {
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|_| "无法读取远程 runtime 信息")?;
        channel
            .exec(true, command)
            .await
            .map_err(|_| "无法读取远程 runtime 信息")?;
        let mut output = Vec::new();
        let mut exit = None;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    if output.len() + data.len() > 65536 {
                        return Err("远程 runtime 信息过大");
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                _ => {}
            }
        }
        if exit != Some(0) {
            return Err("远程 runtime 信息读取失败；请独立启动服务并检查路径");
        }
        String::from_utf8(output).map_err(|_| "远程 runtime 信息格式错误")
    })
    .await
    .map_err(|_| "远程 runtime 信息读取超时")??;
    let (info, token) = text
        .trim()
        .rsplit_once('\n')
        .ok_or("远程 runtime 信息缺失")?;
    let (remote, remote_host) = discovery(info, token.trim())?;
    let remote_port = remote.port().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| "无法创建客户端 SSH 转发")?;
    let local_port = listener
        .local_addr()
        .map_err(|_| "无法读取客户端转发地址")?
        .port();
    let session = Arc::new(session);
    let task = tokio::spawn(async move {
        let mut channels = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else { break };
                    // Bound resource use; each HTTP/SSE stream has an independent SSH channel.
                    if channels.len() >= 32 { continue; }
                    let session = session.clone();
                    channels.spawn(async move {
                        let channel = tokio::time::timeout(Duration::from_secs(10), session.channel_open_direct_tcpip("127.0.0.1", remote_port.into(), "127.0.0.1", 0)).await;
                        if let Ok(Ok(channel)) = channel {
                            let mut stream = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                            let _ = socket.shutdown().await;
                        }
                    });
                }
                _ = channels.join_next(), if !channels.is_empty() => {}
            }
        }
        // JoinSet drop aborts all owned streams; dropping session closes SSH.
    });
    let endpoint = Endpoint {
        base: reqwest::Url::parse(&format!("http://127.0.0.1:{local_port}")).unwrap(),
        remote_host,
        token: token.trim().into(),
        client: client()?,
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        _tunnel: None,
        _embedded: Some(Tunnel { task }),
    };
    crate::transport::ready(&endpoint).await?;
    Ok(endpoint)
}

#[cfg(test)]
mod tests {
    #[test]
    fn host_pins_ignore_only_comments_and_reject_malformed_keys() {
        let key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE6kzwKq/JCIHd7g8uGX1s7zk3v/43+d2uzDU1kL6ICV";
        assert_eq!(
            super::canonical_key(key).unwrap(),
            super::canonical_key(&format!("{key} administrator-comment")).unwrap()
        );
        assert!(super::canonical_key("SHA256:not-a-full-key").is_err());
        assert!(super::canonical_key("ssh-ed25519 invalid-base64").is_err());
    }
}
