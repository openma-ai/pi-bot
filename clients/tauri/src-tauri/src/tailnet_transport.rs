//! HTTP, event streams, binary files and desktop WebSocket share one SDK TCP tunnel.
use crate::{
    mobile_ssh::Tunnel,
    transport::{Endpoint, Profile},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{net::TcpListener, task::JoinSet};
pub fn destination(p: &Profile) -> Result<(String, u16), String> {
    let host = p.host.as_deref().unwrap_or("");
    let ip = host
        .parse::<std::net::Ipv4Addr>()
        .map_err(|_| "请选择设备的 Tailscale IPv4 地址")?;
    let octets = ip.octets();
    if octets[0] != 100 || !(64..=127).contains(&octets[1]) || ip.to_string() != host {
        return Err("仅允许明确的 Tailnet 设备地址".into());
    }
    let port = p
        .server_port
        .filter(|p| *p > 0)
        .ok_or("请填写 Pibo 服务端口")?;
    Ok((host.into(), port))
}
fn profile(params: &Value) -> Result<Profile, String> {
    let host = params["host"].as_str().ok_or("缺少设备地址")?;
    let port = params["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or("无效端口")?;
    let mut p = Profile::local("", "", "");
    p.mode = "tailnet".into();
    p.host = Some(host.into());
    p.server_port = Some(port as u16);
    destination(&p)?;
    Ok(p)
}
fn key(p: &Profile) -> Result<String, String> {
    let (h, port) = destination(p)?;
    Ok(format!(
        "runtime-{:x}",
        Sha256::digest(format!(
            "{}\n{h}:{port}",
            crate::tailscale::credential_scope(&h)?
        ))
    ))
}
pub fn account(params: &Value) -> Result<String, String> {
    key(&profile(params)?)
}
async fn ensure_ready() -> Result<(), String> {
    crate::tailscale::resume()?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let status = crate::tailscale::status()?;
        if status["backendState"] == "Running" {
            break;
        }
        if matches!(
            status["backendState"].as_str(),
            Some("NeedsLogin" | "NeedsMachineAuth" | "Stopped" | "NotPrepared")
        ) || tokio::time::Instant::now() >= deadline
        {
            return Err("请先在连接管理登录或批准应用内 Tailscale 网络".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Ok(())
}
async fn endpoint(p: &Profile, token: String) -> Result<Endpoint, String> {
    let (host, port) = destination(p)?;
    ensure_ready().await?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "无法建立应用内传输")?;
    let addr = listener.local_addr().map_err(|_| "无法读取传输端口")?;
    let remote_host = format!("{host}:{port}");
    let task = tokio::spawn(async move {
        let mut children = JoinSet::new();
        loop {
            tokio::select! {result=listener.accept()=>{let Ok((mut local,_))=result else{break};if children.len()>=32 {drop(local);continue;}let host=host.clone();children.spawn(async move{if let Ok(mut remote)=crate::tailscale::dial(&host,port).await{let _=tokio::io::copy_bidirectional(&mut local,&mut remote).await;}});},_=children.join_next(),if !children.is_empty()=>{}}
        }
    });
    Ok(Endpoint {
        base: reqwest::Url::parse(&format!("http://{addr}/")).unwrap(),
        remote_host,
        token,
        client: crate::transport::client()?,
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        _tunnel: None,
        _embedded: Some(Tunnel { task }),
    })
}
async fn control(ep: &Endpoint, path: &str, body: Option<Value>) -> Result<Value, String> {
    let mut r = ep
        .client
        .request(
            if body.is_some() {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            ep.base.join(path).map_err(|_| "Invalid service path")?,
        )
        .header("Host", &ep.remote_host)
        .timeout(std::time::Duration::from_secs(15));
    if !ep.token.is_empty() {
        r = r.bearer_auth(&ep.token);
    }
    if let Some(v) = body {
        r = r.json(&v);
    }
    let mut response = r
        .send()
        .await
        .map_err(|_| "未找到 Pibo 服务，请核对服务端口和网络权限")?;
    if !response.status().is_success() {
        return Err(format!(
            "Pibo 服务拒绝请求（{}）；检查配对码或重新配对",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|n| n > 4096) {
        return Err("服务响应过大".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "服务响应中断")? {
        if bytes.len() + chunk.len() > 4096 {
            return Err("服务响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "不是兼容的 Pibo 服务".into())
}
pub async fn probe(params: &Value) -> Result<Value, String> {
    let p = profile(params)?;
    let ep = endpoint(&p, String::new()).await?;
    let v = control(&ep, "/pibo/service", None).await?;
    if v["service"] != "pibo" || v["protocolVersion"] != "2026-10-13" {
        return Err("该设备没有兼容的 Pibo 服务".into());
    }
    let name = v["name"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 300 && !s.chars().any(|c| c.is_control()))
        .ok_or("无效 Pibo 服务名称")?;
    let pairing = v["pairing"].as_bool().ok_or("无效 Pibo 服务状态")?;
    Ok(json!({"name":name,"pairing":pairing}))
}
pub async fn pair(params: &Value) -> Result<Value, String> {
    let p = profile(params)?;
    let code = zeroize::Zeroizing::new(
        params["code"]
            .as_str()
            .filter(|s| s.len() == 24 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("请输入服务端显示的配对码")?
            .to_owned(),
    );
    let ep = endpoint(&p, String::new()).await?;
    let v = control(&ep, "/pibo/pair", Some(json!({"code":&*code}))).await?;
    let token = zeroize::Zeroizing::new(
        v["token"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("无效配对响应")?
            .to_owned(),
    );
    crate::tailnet_secrets::save(&key(&p)?, token.as_bytes())?;
    Ok(json!({"paired":true,"deviceId":v["deviceId"]}))
}
pub async fn connect(p: &Profile) -> Result<Endpoint, String> {
    // Restore the existing SDK identity before resolving a network-bound credential.
    ensure_ready().await?;
    let bytes = zeroize::Zeroizing::new(
        crate::tailnet_secrets::load(&key(p)?)?.ok_or("请先为这台电脑配对 Pibo 服务")?,
    );
    let token = String::from_utf8(bytes.to_vec()).map_err(|_| "配对信息无效")?;
    let ep = endpoint(p, token).await?;
    let v = control(&ep, "/pibo/ready", None).await?;
    if v["ready"] != true {
        return Err("Pibo 服务还没准备好".into());
    }
    Ok(ep)
}

#[cfg(test)]
mod tests {
    #[test]
    fn tailnet_profiles_have_no_ssh_or_directory_requirement() {
        let p = super::profile(&serde_json::json!({"host":"100.100.1.2","port":4319})).unwrap();
        p.validate().unwrap();
        assert!(p.data_dir.is_empty());
        assert!(p.host_key.is_none());
        for host in [
            "127.0.0.1",
            "100.63.1.2",
            "100.128.1.2",
            "100.100.1.999",
            "user@100.100.1.2",
            "example.com",
        ] {
            assert!(super::profile(&serde_json::json!({"host":host,"port":4319})).is_err());
        }
    }
}

#[cfg(all(test, feature = "embedded-tailscale", pibo_tailscale_offline_test))]
mod tailscale_offline {
    #[test]
    fn direct_sdk_http_binary_and_reconnect_need_no_ssh() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async{
  crate::tailscale::stop();crate::tailscale::browser_start().unwrap();std::env::set_var("PIBO_OFFLINE_RUNNING","1");
  let server=TcpListener::bind("127.0.0.1:0").await.unwrap();let port=server.local_addr().unwrap().port();let task=tokio::spawn(async move{loop{let Ok((mut s,_))=server.accept().await else{break};tokio::spawn(async move{let mut b=Vec::new();loop{let mut c=[0;1024];let n=s.read(&mut c).await.unwrap();if n==0{return;}b.extend_from_slice(&c[..n]);if b.windows(4).any(|w|w==b"\r\n\r\n"){break;}}
    let h=String::from_utf8_lossy(&b).to_lowercase();assert!(h.contains(&format!("host: 100.100.1.2:{port}")));assert!(h.contains(&format!("authorization: bearer {}","b".repeat(64))));
    let _=s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\n\x00\xff\x80\x01\x02\x00").await;
  });}});
  let p=super::profile(&serde_json::json!({"host":"100.100.1.2","port":port})).unwrap();
  for _ in 0..2{let ep=super::endpoint(&p,"b".repeat(64)).await.unwrap();let response=ep.request("/rpc","POST","{}", "synthetic").await.unwrap();assert_eq!(response.bytes().await.unwrap().as_ref(),&[0,255,128,1,2,0]);drop(ep);}
  assert_eq!(crate::tailscale::status().unwrap()["backendState"],"Running"); // dropping a runtime does not stop/re-register SDK node
  task.abort();crate::tailscale::stop();std::env::remove_var("PIBO_OFFLINE_RUNNING");
 });
    }
}
