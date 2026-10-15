//! Opt-in disposable loopback SSH fixture. Not enabled in normal client builds.
use russh::{
    server::{self, Server as _, Session},
    Channel, ChannelId,
};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Mutex,
};
const PASSWORD: &str = "disposable-ios-fixture-password";
#[derive(Clone)]
struct Fixture {
    port: u16,
    info: String,
    token: String,
    root: PathBuf,
    sessions: Arc<Mutex<Vec<server::Handle>>>,
}
impl server::Server for Fixture {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}
impl server::Handler for Fixture {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if user == "fixture" && password == PASSWORD {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: &russh::keys::PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        let allowed = ["client-test-key.pub", "client-test-rsa.pub"]
            .iter()
            .any(|name| {
                std::fs::read_to_string(self.root.join(name))
                    .ok()
                    .and_then(|text| russh::keys::PublicKey::from_openssh(&text).ok())
                    .is_some_and(|public| public.key_data() == key.key_data())
            });
        Ok(if user == "fixture" && allowed {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<server::Auth, Self::Error> {
        if user != "fixture" {
            return Ok(server::Auth::reject());
        }
        if let Some(mut values) = response {
            return Ok(
                if values.next().as_deref() == Some(b"000000".as_slice()) && values.next().is_none()
                {
                    server::Auth::Accept
                } else {
                    server::Auth::reject()
                },
            );
        }
        Ok(server::Auth::Partial {
            name: "Disposable fixture".into(),
            instructions: "Dummy code only".into(),
            prompts: vec![("Fixture verification code".into(), false)].into(),
        })
    }
    async fn auth_succeeded(&mut self, session: &mut Session) -> Result<(), Self::Error> {
        self.sessions.lock().await.push(session.handle());
        Ok(())
    }
    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let expected = format!(
            "cd {} && cat {}/daemon.json && printf '\\n' && cat {}/daemon.token",
            crate::transport::remote_path(self.root.to_str().unwrap()),
            crate::transport::remote_path(self.root.to_str().unwrap()),
            crate::transport::remote_path(self.root.to_str().unwrap())
        );
        if command == expected.as_bytes() {
            session.channel_success(id)?;
            session.data(id, format!("{}\n{}\n", self.info, self.token).into_bytes())?;
            session.exit_status_request(id, 0)?;
        } else {
            session.channel_failure(id)?;
            session.exit_status_request(id, 1)?;
        }
        session.eof(id)?;
        session.close(id)?;
        Ok(())
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        if host != "127.0.0.1" || port != u32::from(self.port) {
            return Ok(());
        }
        let socket = TcpStream::connect(("127.0.0.1", self.port)).await;
        if let Ok(mut socket) = socket {
            reply.accept().await;
            tokio::spawn(async move {
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
        Ok(())
    }
}
pub async fn serve(root: PathBuf) {
    assert!(
        root.starts_with(std::env::temp_dir()) || root.starts_with("/tmp"),
        "fixture must be in temp directory"
    );
    let info = std::fs::read_to_string(root.join("daemon.json")).unwrap();
    let token = std::fs::read_to_string(root.join("daemon.token")).unwrap();
    let (url, _) = crate::transport::discovery(&info, token.trim()).unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let pin = key.public_key().to_openssh().unwrap();
    let sessions = Arc::new(Mutex::new(Vec::<server::Handle>::new()));
    let mut server = Fixture {
        port: url.port().unwrap(),
        info,
        token,
        root: root.clone(),
        sessions: sessions.clone(),
    };
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(50),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let profile = crate::transport::Profile {
        id: "ios-fixture".into(),
        name: "iOS SSH fixture".into(),
        mode: "ssh".into(),
        data_dir: root.to_str().unwrap().into(),
        host: Some("fixture@127.0.0.1".into()),
        project_dir: Some(root.to_str().unwrap().into()),
        ssh_port: Some(port),
        server_port: Some(0),
        host_key: Some(pin),
        ..crate::transport::Profile::local("", "", "")
    };
    std::fs::write(
        root.join("ssh-profile.json"),
        serde_json::to_vec_pretty(&profile).unwrap(),
    )
    .unwrap();
    println!(
        "Disposable SSH fixture on 127.0.0.1:{port}; public configuration: {}",
        root.join("ssh-profile.json").display()
    );
    let running = server.run_on_socket(config, &listener);
    let reset_root = root.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if std::fs::remove_file(reset_root.join("disconnect-ssh")).is_ok() {
                for session in sessions.lock().await.drain(..) {
                    let _ = session
                        .disconnect(
                            russh::Disconnect::ByApplication,
                            "controlled fixture disconnect".into(),
                            "en".into(),
                        )
                        .await;
                }
            }
        }
    });
    running.await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    #[test]
    fn encrypted_key_and_keyboard_interactive_authentication() {
        tauri::async_runtime::block_on(async {
            let root = std::env::var("PIBOT_SSH_FIXTURE_ROOT").expect("isolated fixture required");
            let p: crate::transport::Profile =
                serde_json::from_slice(&std::fs::read(format!("{root}/ssh-profile.json")).unwrap())
                    .unwrap();
            let mut credentials = crate::mobile_ssh::Credentials::password("");
            credentials.method = "privateKey".into();
            credentials.private_key =
                std::fs::read_to_string(format!("{root}/client-test-key")).unwrap();
            credentials.passphrase = "fixture-key-passphrase".into();
            for name in ["client-test-key", "client-test-rsa"] {
                credentials.private_key =
                    std::fs::read_to_string(format!("{root}/{name}")).unwrap();
                let key_endpoint = crate::mobile_ssh::connect_authenticated(&p, &credentials, None)
                    .await
                    .unwrap();
                assert!(key_endpoint
                    .request("/readyz", "GET", "", "")
                    .await
                    .unwrap()
                    .status()
                    .is_success());
                drop(key_endpoint);
            }
            credentials.passphrase = "wrong".into();
            assert!(credentials.validate().is_err());
            credentials.method = "interactive".into();
            credentials.private_key.clear();
            credentials.passphrase.clear();
            let prompt: crate::mobile_ssh::PromptHandler = Arc::new(|prompts| {
                Box::pin(async move {
                    assert_eq!(prompts, vec!["Fixture verification code"]);
                    Ok(vec!["000000".into()])
                })
            });
            let endpoint = crate::mobile_ssh::connect_authenticated(&p, &credentials, Some(prompt))
                .await
                .unwrap();
            assert!(endpoint
                .request("/readyz", "GET", "", "")
                .await
                .unwrap()
                .status()
                .is_success());
            drop(endpoint);
            let wrong: crate::mobile_ssh::PromptHandler =
                Arc::new(|_| Box::pin(async { Ok(vec!["111111".into()]) }));
            assert!(
                crate::mobile_ssh::connect_authenticated(&p, &credentials, Some(wrong))
                    .await
                    .is_err()
            );
            let blocked: crate::mobile_ssh::PromptHandler =
                Arc::new(|_| Box::pin(std::future::pending()));
            assert!(tokio::time::timeout(
                Duration::from_millis(150),
                crate::mobile_ssh::connect_authenticated(&p, &credentials, Some(blocked))
            )
            .await
            .is_err());
            let fresh = crate::mobile_ssh::connect(&p, PASSWORD).await.unwrap();
            assert!(fresh
                .request("/readyz", "GET", "", "")
                .await
                .unwrap()
                .status()
                .is_success());
            drop(fresh);
            let cancel: crate::mobile_ssh::PromptHandler =
                Arc::new(|_| Box::pin(async { Err("cancelled".into()) }));
            assert!(
                crate::mobile_ssh::connect_authenticated(&p, &credentials, Some(cancel))
                    .await
                    .is_err()
            );
        });
    }
    #[test]
    fn embedded_remote_send_stream_reconnect_and_trust() {
        tauri::async_runtime::block_on(async {
            let root = std::env::var("PIBOT_SSH_FIXTURE_ROOT")
                .expect("set PIBOT_SSH_FIXTURE_ROOT to an isolated running fixture");
            let p: crate::transport::Profile =
                serde_json::from_slice(&std::fs::read(format!("{root}/ssh-profile.json")).unwrap())
                    .unwrap();
            let mut wrong = p.clone();
            wrong.host_key = Some(
                "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE6kzwKq/JCIHd7g8uGX1s7zk3v/43+d2uzDU1kL6ICV"
                    .into(),
            );
            assert!(crate::mobile_ssh::connect(&wrong, PASSWORD).await.is_err());
            assert!(crate::mobile_ssh::connect(&p, "wrong-password")
                .await
                .is_err());
            let e = crate::mobile_ssh::connect(&p, PASSWORD).await.unwrap();
            let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-10-13","clientInfo":{"name":"ios-ssh-test","version":"0.1.0"},"capabilities":{"streamingReplies":true}}}).to_string();
            let init: serde_json::Value = e
                .request("/rpc", "POST", &body, "")
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let connection = init["result"]["connectionId"]
                .as_str()
                .expect("initialize connection ID");
            e.request(
                "/rpc",
                "POST",
                "{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}",
                connection,
            )
            .await
            .unwrap();
            let mut events = e
                .request("/events", "GET", "", connection)
                .await
                .unwrap()
                .bytes_stream();
            assert!(events.next().await.unwrap().is_ok());
            let snapshot: serde_json::Value = e.request("/rpc", "POST", &serde_json::json!({"jsonrpc":"2.0","id":2,"method":"daemon/snapshot","params":{}}).to_string(), connection).await.unwrap().json().await.unwrap();
            let bot = snapshot["result"]["bots"][0]["id"]
                .as_str()
                .unwrap_or_else(|| panic!("{snapshot}"));
            let subscribed: serde_json::Value = e.request("/rpc", "POST", &serde_json::json!({"jsonrpc":"2.0","id":4,"method":"events/subscribe","params":{"after":snapshot["result"]["seq"]}}).to_string(), connection).await.unwrap().json().await.unwrap();
            assert!(subscribed.get("error").is_none(), "{subscribed}");
            let sent: serde_json::Value = e.request("/rpc", "POST", &serde_json::json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"botId":bot,"text":"iOS embedded transport test","key":uuid::Uuid::new_v4().to_string()}}).to_string(), connection).await.unwrap().json().await.unwrap();
            assert!(sent.get("error").is_none(), "{sent}");
            let mut captured = String::new();
            tokio::time::timeout(Duration::from_secs(10), async {
                while let Some(Ok(data)) = events.next().await {
                    captured.push_str(&String::from_utf8_lossy(&data));
                    if captured.contains("Fixture reply: iOS embedded transport test") {
                        break;
                    }
                }
            })
            .await
            .unwrap_or_else(|_| panic!("stream timeout: {captured}"));
            assert!(captured.contains("item/agentMessage/delta"));
            assert!(captured.contains("Fixture reply: iOS embedded transport test"));
            std::fs::write(format!("{root}/disconnect-ssh"), "").unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
            assert!(e.request("/rpc", "POST", "{}", connection).await.is_err());
            drop(events);
            drop(e);
            let reconnected = crate::mobile_ssh::connect(&p, PASSWORD).await.unwrap();
            assert!(reconnected
                .request("/readyz", "GET", "", "")
                .await
                .unwrap()
                .status()
                .is_success());
        });
    }
}
