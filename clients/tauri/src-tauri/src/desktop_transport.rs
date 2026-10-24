//! Browser WebSocket -> private loopback bridge -> Endpoint SDK/SSH tunnel.
//! The browser sees only a random per-view ticket, never a service bearer token.
use crate::transport::Endpoint;
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
};
pub async fn open(
    ep: Arc<Endpoint>,
    path: String,
) -> Result<(String, tauri::async_runtime::JoinHandle<()>), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "无法准备桌面连接")?;
    let port = listener
        .local_addr()
        .map_err(|_| "无法读取桌面端口")?
        .port();
    let ticket = uuid::Uuid::new_v4().simple().to_string();
    let url = format!("ws://127.0.0.1:{port}/{ticket}");
    let task = tauri::async_runtime::spawn(async move {
        let mut children = JoinSet::new();
        loop {
            tokio::select! {r=listener.accept()=>{let Ok((socket,_))=r else{break};if children.len()>=4{drop(socket);continue;}let(ep,path,ticket)=(ep.clone(),path.clone(),ticket.clone());children.spawn(async move{let _=forward(socket,ep,&path,&ticket).await;});},_=children.join_next(),if !children.is_empty()=>{}}
        }
    });
    Ok((url, task))
}
async fn forward(
    mut local: TcpStream,
    ep: Arc<Endpoint>,
    path: &str,
    ticket: &str,
) -> Result<(), String> {
    let mut bytes = Vec::new();
    let end = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let mut buf = [0u8; 2048];
            let n = local
                .read(&mut buf)
                .await
                .map_err(|_| "Header read failed")?;
            if n == 0 {
                return Err("Closed header");
            }
            bytes.extend_from_slice(&buf[..n]);
            if bytes.len() > 16384 {
                return Err("Header too large");
            }
            if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                return Ok(i + 4);
            }
        }
    })
    .await
    .map_err(|_| "Desktop handshake timeout")?
    .map_err(str::to_owned)?;
    let text = std::str::from_utf8(&bytes[..end]).map_err(|_| "Invalid header")?;
    let mut lines = text.split("\r\n");
    if lines.next() != Some(format!("GET /{ticket} HTTP/1.1").as_str()) {
        return Err("Invalid ticket".into());
    }
    let mut headers = Vec::new();
    let mut origins = Vec::new();
    let mut upgrade = false;
    for line in lines.filter(|l| !l.is_empty()) {
        let (k, v) = line.split_once(':').ok_or("Invalid header")?;
        let lower = k.to_ascii_lowercase();
        let v = v.trim();
        if lower == "origin" {
            origins.push(v);
            continue;
        }
        if lower == "upgrade" {
            upgrade = v.eq_ignore_ascii_case("websocket");
        }
        if ["host", "authorization", "cookie", "x-pibot-csrf"].contains(&lower.as_str()) {
            continue;
        }
        headers.push(format!("{k}: {v}"));
    }
    if origins.len() != 1
        || ![
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ]
        .contains(&origins[0])
        || !upgrade
    {
        return Err("Invalid desktop origin".into());
    }
    headers.push(format!("Host: {}", ep.remote_host));
    headers.push(format!("Authorization: Bearer {}", ep.token));
    if let Some(origin) = &ep.desktop_origin {
        headers.push(format!("Origin: {}", origin));
    }
    // reqwest performs verified TLS for HTTPS origins; 101 upgrades preserve raw RFB frames.
    let url = ep.base.join(path).map_err(|_| "Invalid desktop path")?;
    let mut request = ep.client.get(url).timeout(std::time::Duration::from_secs(15));
    for header in headers {
        let (k,v)=header.split_once(':').ok_or("Invalid upgrade header")?;
        request=request.header(k,v.trim());
    }
    let response=request.send().await.map_err(|_| "Desktop TLS/handshake failed")?;
    let status=response.status();
    let mut head=format!("HTTP/1.1 {}\r\n",status);
    for (k,v) in response.headers() { if let Ok(v)=v.to_str() {head.push_str(&format!("{}: {}\r\n",k.as_str(),v));} }
    head.push_str("\r\n");
    local.write_all(head.as_bytes()).await.map_err(|_| "Browser disconnected")?;
    if status != reqwest::StatusCode::SWITCHING_PROTOCOLS {return Err("Desktop upgrade rejected".into());}
    let mut remote=response.upgrade().await.map_err(|_| "Desktop upgrade unavailable")?;
    remote
        .write_all(&bytes[end..])
        .await
        .map_err(|_| "Handshake failed")?;
    tokio::io::copy_bidirectional(&mut local, &mut remote)
        .await
        .map_err(|_| "Desktop disconnected")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_ticket_origin_and_native_bearer_are_enforced() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async{
 let upstream=TcpListener::bind("127.0.0.1:0").await.unwrap();let port=upstream.local_addr().unwrap().port();let ep=Arc::new(Endpoint{desktop_origin:Some(format!("http://127.0.0.1:{port}")),base:reqwest::Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),remote_host:format!("127.0.0.1:{port}"),token:"c".repeat(64),client:crate::transport::client().unwrap(),#[cfg(not(any(target_os="ios",target_os="android")))]_tunnel:None,_embedded:None});
 let(url,task)=super::open(ep,"/api/desktop/synthetic/ws".into()).await.unwrap();let url=reqwest::Url::parse(&url).unwrap();
 let server=tokio::spawn(async move{let(mut s,_)=upstream.accept().await.unwrap();let mut b=vec![0;8192];let n=s.read(&mut b).await.unwrap();let text=String::from_utf8_lossy(&b[..n]);assert!(text.starts_with("GET /api/desktop/synthetic/ws HTTP/1.1"));assert!(text.to_ascii_lowercase().contains(&format!("authorization: bearer {}","c".repeat(64))));assert!(text.to_ascii_lowercase().contains(&format!("origin: http://127.0.0.1:{port}")));assert!(!text.to_ascii_lowercase().contains("cookie:"));s.write_all(b"HTTP/1.1 101 Switching Protocols\r\n\r\n\x82\x02\x00\xff").await.unwrap();});
 let mut denied=TcpStream::connect(("127.0.0.1",url.port().unwrap())).await.unwrap();denied.write_all(format!("GET {} HTTP/1.1\r\nOrigin: http://evil.invalid\r\nUpgrade: websocket\r\n\r\n",url.path()).as_bytes()).await.unwrap();let mut byte=[0];assert_eq!(denied.read(&mut byte).await.unwrap(),0);
 let mut browser=TcpStream::connect(("127.0.0.1",url.port().unwrap())).await.unwrap();browser.write_all(format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: tauri://localhost\r\nCookie: secret=not-forwarded\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",url.path()).as_bytes()).await.unwrap();let mut result=Vec::new();browser.read_to_end(&mut result).await.unwrap();assert!(result.ends_with(&[0x82,2,0,255]));server.await.unwrap();task.abort();
 });
    }
}
