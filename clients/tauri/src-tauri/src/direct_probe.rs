//! Explicit, debug-only driver for the isolated simulator bundle. No release entry.
use crate::{
    tailnet_transport, tailscale,
    transport::{Endpoint, Profile},
};
use base64::Engine;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;
fn report(dir: &Path, value: Value) {
    let _ = std::fs::write(dir.join("direct-progress.tmp"), value.to_string());
    let _ = std::fs::rename(
        dir.join("direct-progress.tmp"),
        dir.join("direct-progress.json"),
    );
}
pub fn launch(app: tauri::AppHandle) {
    if std::env::var("PIBO_DIRECT_TEST").as_deref() != Ok("1") {
        return;
    }
    unsafe extern "C" {
        fn pibo_is_direct_test_bundle() -> bool;
    }
    if !unsafe { pibo_is_direct_test_bundle() } {
        return;
    }
    let Ok(host) = std::env::var("PIBO_DIRECT_TEST_HOST") else {
        return;
    };
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run(app, dir.clone(), host).await {
            report(&dir, json!({"phase":"error","error":error}));
        }
    });
}
async fn rpc(ep: &Endpoint, c: &str, method: &str, params: Value) -> Result<Value, String> {
    let body=json!({"jsonrpc":"2.0","id":uuid::Uuid::new_v4().to_string(),"method":method,"params":params}).to_string();
    let v: Value = ep
        .request("/rpc", "POST", &body, c)
        .await?
        .json()
        .await
        .map_err(|_| "Invalid RPC JSON")?;
    if v.get("error").is_some() {
        return Err(format!("RPC {method} rejected: {}", v["error"]["message"]));
    }
    Ok(v["result"].clone())
}
async fn run(app: tauri::AppHandle, dir: PathBuf, host: String) -> Result<(), String> {
    let mut p = Profile::local("tailnet-direct-fixture", "Tailnet direct fixture", "");
    p.mode = "tailnet".into();
    p.embedded_tailscale = true;
    p.host = Some(host.clone());
    p.server_port = Some(4319);
    p.validate()?;
    tokio::task::spawn_blocking(tailscale::browser_start)
        .await
        .map_err(|_| "Start interrupted")??;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
    let mut opened = false;
    loop {
        let status = tokio::task::spawn_blocking(tailscale::status)
            .await
            .map_err(|_| "Status interrupted")??;
        report(&dir, json!({"phase":"login","status":status}));
        if status["backendState"] == "Running" {
            crate::file_export::close_tailscale_login();
            break;
        }
        if !opened {
            if let Some(url) = status["authURL"].as_str() {
                opened = true;
                let _ = crate::file_export::open_tailscale_login(url).await;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Explicit test wait deadline reached; no new login requested".into());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let params = json!({"host":host,"port":4319});
    let service = tailnet_transport::probe(&params).await?;
    report(
        &dir,
        json!({"phase":"awaitPairing","status":tailscale::status()?,"service":service}),
    );
    let mut reused = false;
    loop {
        if tailnet_transport::connect(&p).await.is_ok() {
            reused = true;
            break;
        }
        if let Ok(code) = std::fs::read_to_string(dir.join("direct-pair-code")) {
            let code = zeroize::Zeroizing::new(code.trim().to_owned());
            let _ = std::fs::remove_file(dir.join("direct-pair-code"));
            let paired =
                tailnet_transport::pair(&json!({"host":host,"port":4319,"code":&*code})).await?;
            report(
                &dir,
                json!({"phase":"paired","deviceId":paired["deviceId"],"status":tailscale::status()?}),
            );
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Pairing input wait expired".into());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let webview = app
        .get_webview_window("main")
        .ok_or("Missing test window")?;
    let window = webview.as_ref().window();
    crate::runtime_control(
        window,
        app.state::<crate::Shared>(),
        app.clone(),
        "runtime/connect".into(),
        json!({"profile":p}),
    )
    .await?;
    let ep = app
        .state::<crate::Shared>()
        .lock()
        .await
        .active
        .as_ref()
        .map(|(_, _, e)| e.clone())
        .ok_or("Missing active runtime")?;
    let init=rpc(&ep,"","initialize",json!({"protocolVersion":"2026-10-13","clientInfo":{"name":"isolated-direct-simulator","version":"1"},"capabilities":{"streamingReplies":true}})).await?;
    let c = init["connectionId"]
        .as_str()
        .ok_or("Missing connection")?
        .to_owned();
    ep.request(
        "/rpc",
        "POST",
        "{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}",
        &c,
    )
    .await?;
    let list = rpc(&ep, &c, "bot/list", json!({})).await?;
    let bot = if let Some(id) = list["bots"]
        .as_array()
        .and_then(|v| {
            v.iter()
                .find(|b| b["name"] == "SDK direct synthetic desktop")
        })
        .and_then(|b| b["id"].as_str())
    {
        id.to_owned()
    } else {
        rpc(
            &ep,
            &c,
            "bot/create",
            json!({"name":"SDK direct synthetic desktop"}),
        )
        .await?["bot"]["id"]
            .as_str()
            .ok_or("Missing bot")?
            .to_owned()
    };
    let snapshot = rpc(&ep, &c, "daemon/snapshot", json!({})).await?;
    let mut events = ep.request("/events", "GET", "", &c).await?.bytes_stream();
    tokio::time::timeout(Duration::from_secs(10), events.next())
        .await
        .map_err(|_| "SSE timeout")?
        .ok_or("Missing SSE")?
        .map_err(|_| "SSE failed")?;
    rpc(
        &ep,
        &c,
        "events/subscribe",
        json!({"after":snapshot["seq"]}),
    )
    .await?;
    let mut files = Vec::new();
    let binary = (0..300073).map(|i| (i % 256) as u8).collect::<Vec<_>>();
    let image = include_bytes!("../../../../test/fixtures/images/synthetic.png").to_vec();
    for (name, mime, bytes) in [
        ("synthetic.bin", "application/octet-stream", binary),
        ("synthetic.png", "image/png", image),
    ] {
        let start = rpc(
            &ep,
            &c,
            "file/begin",
            json!({"botId":bot,"name":name,"mime":mime,"size":bytes.len()}),
        )
        .await?;
        let id = start["file"]["id"]
            .as_str()
            .ok_or("Missing file")?
            .to_owned();
        for (offset, chunk) in bytes.chunks(256 * 1024).enumerate() {
            rpc(&ep,&c,"file/append",json!({"botId":bot,"id":id,"offset":offset*256*1024,"data":base64::engine::general_purpose::STANDARD.encode(chunk)})).await?;
        }
        let hash = format!("{:x}", Sha256::digest(&bytes));
        rpc(
            &ep,
            &c,
            "file/finish",
            json!({"botId":bot,"id":id,"sha256":hash}),
        )
        .await?;
        rpc(&ep,&c,"turn/start",json!({"botId":bot,"text":"Copy this synthetic attachment as data","attachments":[id],"key":uuid::Uuid::new_v4().to_string()})).await?;
        let mut result = None;
        for _ in 0..100 {
            let snap = rpc(&ep, &c, "daemon/snapshot", json!({})).await?;
            result = snap["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|i| i["message"]["attachments"].as_array())
                .flatten()
                .find(|f| {
                    f["sha256"] == hash
                        && f["name"].as_str().is_some_and(|n| n.starts_with("answer-"))
                })
                .cloned();
            if result.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let output = result.ok_or("Generated file card missing")?;
        let mut downloaded = Vec::new();
        while downloaded.len() < bytes.len() {
            let part = rpc(
                &ep,
                &c,
                "file/read",
                json!({"botId":bot,"id":output["id"],"offset":downloaded.len()}),
            )
            .await?;
            let chunk = base64::engine::general_purpose::STANDARD
                .decode(part["data"].as_str().ok_or("Missing chunk")?)
                .map_err(|_| "Invalid base64")?;
            if chunk.is_empty() {
                return Err("Empty output chunk".into());
            }
            downloaded.extend(chunk);
        }
        if downloaded != bytes {
            return Err("Downloaded file bytes differ".into());
        }
        files.push(json!({"name":name,"bytes":bytes.len(),"sha256":hash,"image":output["image"],"fileCard":true,"agentCopy":true}));
    }
    let response = ep
        .request(
            "/api/desktop/bind",
            "POST",
            &json!({"botId":bot}).to_string(),
            &c,
        )
        .await?;
    if !response.status().is_success() {
        return Err("Desktop bind failed".into());
    }
    let screen = ep
        .request(&format!("/api/desktop/{bot}/screen"), "GET", "", &c)
        .await?
        .bytes()
        .await
        .map_err(|_| "Screen read failed")?;
    if !screen.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Desktop did not return PNG".into());
    }
    std::fs::write(dir.join("direct-desktop.png"), &screen)
        .map_err(|_| "Cannot save synthetic screen")?;
    report(
        &dir,
        json!({"phase":"nativeChecksPassed","status":tailscale::status()?,"pairingReused":reused,"http":true,"sse":true,"files":files,"desktopPngBytes":screen.len(),"botId":bot}),
    );
    if let Some(webview) = app.get_webview_window("main") {
        let script=format!("location.hash='#/chat/bot/{}';setTimeout(()=>document.querySelector('[aria-label=\"打开会话详情\"]')?.click(),2500);setTimeout(()=>[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent==='电脑')?.click(),4000);setTimeout(()=>document.querySelector('.screen-preview')?.click(),6500);setTimeout(()=>{{const c=document.querySelector('.vnc-stage canvas');window.__TAURI_INTERNALS__.invoke('layout_diagnostics',{{metrics:{{directDesktop:{{canvasWidth:c?.width||0,canvasHeight:c?.height||0,canvasPresent:!!c,viewText:document.querySelector('.computer-fullscreen')?.innerText?.slice(0,500)}}}}}})}},15000);",bot);
        let _ = webview.eval(&script);
    }
    Ok(())
}
