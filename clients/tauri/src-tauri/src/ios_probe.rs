//! Debug-only simulator verification. Compiled out of release builds. Never targets a real host.
use crate::{
    mobile_ssh, ssh_credentials,
    transport::{Endpoint, Profile},
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
const PASSWORD: &str = "disposable-ios-fixture-password";
pub fn profile() -> Option<Profile> {
    let p: Profile =
        serde_json::from_str(&std::env::var("PIBOT_IOS_FIXTURE_PROFILE").ok()?).ok()?;
    if p.id != "ios-fixture"
        || p.host.as_deref() != Some("fixture@127.0.0.1")
        || p.mode != "ssh"
        || !p.data_dir.starts_with("/tmp/pi-bot-ios-remote-fixture-")
    {
        return None;
    }
    p.validate().ok()?;
    Some(p)
}
async fn rpc(e: &Endpoint, connection: &str, method: &str, params: Value) -> Result<Value, String> {
    let body = json!({"jsonrpc":"2.0","id":uuid::Uuid::new_v4().to_string(),"method":method,"params":params}).to_string();
    let value: Value = e
        .request("/rpc", "POST", &body, connection)
        .await?
        .json()
        .await
        .map_err(|_| "fixture RPC JSON invalid")?;
    if value.get("error").is_some() {
        return Err(format!("fixture RPC {method} rejected"));
    }
    Ok(value["result"].clone())
}
pub async fn run(p: &Profile) -> Result<Value, String> {
    ssh_credentials::store(p, "temporary-disposable-fixture-password")?;
    ssh_credentials::store(p, PASSWORD)?;
    if ssh_credentials::load(p)?.as_str() != PASSWORD {
        return Err("Keychain roundtrip mismatch".into());
    }
    ssh_credentials::remove(p)?;
    if ssh_credentials::load(p).is_ok() {
        return Err("Keychain delete failed".into());
    }
    ssh_credentials::store(p, PASSWORD)?;
    let mut wrong = p.clone();
    wrong.host_key = Some(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE6kzwKq/JCIHd7g8uGX1s7zk3v/43+d2uzDU1kL6ICV".into(),
    );
    if mobile_ssh::connect(&wrong, PASSWORD).await.is_ok() {
        return Err("changed host key accepted".into());
    }
    if mobile_ssh::connect(p, "wrong-password").await.is_ok() {
        return Err("wrong password accepted".into());
    }
    let e = crate::transport::connect(p).await?;
    let init = rpc(&e, "", "initialize", json!({"protocolVersion":"2026-10-13","clientInfo":{"name":"ios-simulator-probe","version":"0.1.0"},"capabilities":{"streamingReplies":true}})).await?;
    let connection = init["connectionId"]
        .as_str()
        .ok_or("missing fixture connection")?;
    e.request(
        "/rpc",
        "POST",
        "{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}",
        connection,
    )
    .await?;
    let snapshot = rpc(&e, connection, "daemon/snapshot", json!({})).await?;
    let bot = snapshot["bots"][0]["id"]
        .as_str()
        .ok_or("missing fixture bot")?;
    let mut events = e
        .request("/events", "GET", "", connection)
        .await?
        .bytes_stream();
    events
        .next()
        .await
        .ok_or("missing SSE header")?
        .map_err(|_| "SSE failed")?;
    rpc(
        &e,
        connection,
        "events/subscribe",
        json!({"after":snapshot["seq"]}),
    )
    .await?;
    let text = "iOS simulator embedded SSH verified";
    rpc(
        &e,
        connection,
        "turn/start",
        json!({"botId":bot,"text":text,"key":uuid::Uuid::new_v4().to_string()}),
    )
    .await?;
    let mut captured = String::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(Ok(data)) = events.next().await {
            captured.push_str(&String::from_utf8_lossy(&data));
            if captured.contains("Fixture reply: iOS simulator embedded SSH verified") {
                break;
            }
            if captured.len() > 200000 {
                break;
            }
        }
    })
    .await
    .map_err(|_| "simulator streaming timed out")?;
    if !captured.contains("item/agentMessage/delta")
        || !captured.contains("Fixture reply: iOS simulator embedded SSH verified")
    {
        return Err("stream delta/completion missing".into());
    }
    e.request("/fixture/disconnect-ssh", "POST", "{}", connection)
        .await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    if e.request("/readyz", "GET", "", "").await.is_ok() {
        return Err("forced disconnect did not close tunnel".into());
    }
    drop(events);
    drop(e);
    let reconnected = crate::transport::connect(p).await?;
    if !reconnected
        .request("/readyz", "GET", "", "")
        .await?
        .status()
        .is_success()
    {
        return Err("reconnect readiness failed".into());
    }
    Ok(
        json!({"platform":"iOS simulator","keychainStoreLoadUpdateDelete":true,"unknownHostRejected":true,"wrongPasswordRejected":true,"send":true,"streamDelta":true,"completeReply":true,"forcedDisconnect":true,"reconnect":true,"realServerTested":false}),
    )
}
