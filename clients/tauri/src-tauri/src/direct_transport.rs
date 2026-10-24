//! Manually configured runtime origin. Credentials remain in native secure storage.
use crate::transport::{Endpoint, Profile};
pub fn address(p: &Profile) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(p.url.as_deref().unwrap_or("")).map_err(|_| "请输入完整 HTTPS 服务地址")?;
    let loopback = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(u.scheme() == "https" || (u.scheme() == "http" && loopback)) || u.host_str().is_none() || !u.username().is_empty() || u.password().is_some() || u.path() != "/" || u.query().is_some() || u.fragment().is_some() {
        return Err("服务地址须为 HTTPS origin（无路径、账号或参数）；仅本机 loopback 允许 HTTP。Tailscale 地址请使用设备选择入口".into());
    }
    Ok(u)
}
pub fn endpoint(p: &Profile, token: String) -> Result<Endpoint, String> {
    let base = address(p)?;
    let remote_host = format!("{}{}", base.host_str().unwrap(), base.port().map(|p|format!(":{p}")).unwrap_or_default());
    Ok(Endpoint {desktop_origin:None,base, remote_host, token, client: crate::transport::client()?, #[cfg(not(any(target_os="ios",target_os="android")))] _tunnel:None, _embedded:None})
}
#[cfg(test)] mod tests {
    #[test] fn origins_require_tls_and_no_embedded_credentials() {
        let mut p=crate::transport::Profile::local("direct","service",""); p.mode="direct".into();
        for url in ["https://example.com:4319/","http://127.0.0.1:4319/"] {p.url=Some(url.into()); assert!(p.validate().is_ok());}
        for url in ["http://example.com/","http://100.100.1.2:4319/","https://u:p@example.com/","https://example.com/private","https://example.com/?token=a","file:///tmp/a"] {p.url=Some(url.into());assert!(p.validate().is_err(),"{url}");}
    }
}

#[cfg(test)] mod cancellation_tests {
    #[test]
    fn cancelled_password_login_revokes_issued_session_without_saving_it() {
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let server=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port=server.local_addr().unwrap().port();
            let task=tokio::spawn(async move {
                for path in ["/pibo/login","/pibo/logout"] {
                    let(mut s,_)=server.accept().await.unwrap();let mut b=Vec::new();
                    loop {let mut chunk=[0;2048];let n=s.read(&mut chunk).await.unwrap();assert!(n>0);b.extend_from_slice(&chunk[..n]);if b.windows(4).any(|w|w==b"\r\n\r\n"){break;}}
                    assert!(String::from_utf8_lossy(&b).starts_with(&format!("POST {path} ")));
                    let body=if path=="/pibo/login"{format!(r#"{{"token":"{}"}}"#,"b".repeat(64))}else{"{}".into()};
                    s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                }
            });
            let epoch=std::sync::Arc::new(std::sync::atomic::AtomicU64::new(2));
            let result=crate::tailnet_transport::login(&serde_json::json!({"url":format!("http://127.0.0.1:{port}"),"password":"synthetic-password"}),epoch,1).await;
            assert!(result.unwrap_err().contains("登录已取消"));task.await.unwrap();
        });
    }
}
