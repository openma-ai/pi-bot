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
    task: JoinHandle<()>,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn connect(p: &Profile, password: &str) -> Result<Endpoint, String> {
    p.validate()?;
    if p.mode != "ssh" {
        return Err("iOS 仅支持远程 runtime".into());
    }
    let (user, host) = destination(p)?;
    let pin = canonical_key(p.host_key.as_deref().ok_or("请先核验并保存 SSH 主机公钥")?)?;
    if password.is_empty() {
        return Err("请先在设置中保存 SSH 密码".into());
    }
    let config = Arc::new(ssh::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 2,
        ..Default::default()
    });
    let mut session = tokio::time::timeout(
        Duration::from_secs(12),
        ssh::connect(config, (host, p.ssh_port.unwrap_or(22)), PinnedHost(pin)),
    )
    .await
    .map_err(|_| "SSH 连接超时")?
    .map_err(|_| "SSH 连接失败：检查地址和已核验公钥，未知或变更的主机密钥会被拒绝")?;
    let auth = tokio::time::timeout(
        Duration::from_secs(12),
        session.authenticate_password(user, password),
    )
    .await
    .map_err(|_| "SSH 认证超时")?
    .map_err(|_| "SSH 认证失败")?;
    if !auth.success() {
        return Err("SSH 密码认证失败；此版本尚不支持密钥或交互式认证".into());
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
        #[cfg(not(target_os = "ios"))]
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
