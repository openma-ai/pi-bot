//! Non-secret Pi controls may cross the main WebView. Answers that may contain
//! credentials are accepted only by a native-bound credential window.
use crate::transport::Endpoint;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Serialize)]
pub(crate) struct RequestError {
    pub code: &'static str,
    pub message: String,
    pub submitted: bool,
}
impl RequestError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), submitted: false }
    }
    pub fn transport(message: impl Into<String>, submitted: bool) -> Self {
        Self { code: "connectionLost", message: message.into(), submitted }
    }
}
impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.message) }
}

#[derive(Debug, PartialEq)]
pub(crate) enum Action {
    Forward,
    Select { flow: String, prompt: String, value: String },
    Cancel { flow: String },
}
fn denied() -> RequestError { RequestError::new("nativePolicyDenied", "此请求不符合原生模型设置协议") }
fn expired() -> RequestError { RequestError::new("promptExpired", "登录步骤已结束或已变化，请刷新设置") }
pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn fields(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|o| required.iter().all(|k| o.contains_key(*k))
        && o.keys().all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str())))
}
pub(crate) fn flow_path(path: &str) -> Option<&str> {
    path.strip_prefix("/pi/login/").filter(|id| valid_id(id))
}
pub(crate) fn classify(path: &str, method: &str, body: &str) -> Result<Action, RequestError> {
    if !["GET", "POST"].contains(&method) { return Err(denied()); }
    if !path.starts_with("/pi/") || method == "GET" { return Ok(Action::Forward); }
    let value: Value = serde_json::from_str(body).map_err(|_| denied())?;
    let text = |key: &str| value[key].as_str().unwrap_or("");
    let valid = match path {
        "/pi/login" => fields(&value, &["provider", "type", "requestId"], &[])
            && valid_id(text("provider")) && valid_id(text("requestId"))
            && matches!(text("type"), "oauth" | "api_key"),
        "/pi/model" => fields(&value, &["provider", "model", "thinkingLevel"], &[])
            && valid_id(text("provider")) && !text("model").is_empty() && text("model").len() <= 512
            && matches!(text("thinkingLevel"), "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"),
        "/pi/logout" => fields(&value, &["provider"], &[]) && valid_id(text("provider")),
        "/pi/reload" => fields(&value, &[], &[]),
        _ => {
            if let Some(flow) = path.strip_suffix("/cancel").and_then(flow_path) {
                if fields(&value, &[], &[]) { return Ok(Action::Cancel { flow: flow.into() }); }
            }
            if let Some(flow) = path.strip_suffix("/input").and_then(flow_path) {
                if fields(&value, &["promptId", "value"], &[]) && valid_id(text("promptId"))
                    && !text("value").is_empty() && text("value").len() <= 256 {
                    return Ok(Action::Select { flow: flow.into(), prompt: text("promptId").into(), value: text("value").into() });
                }
            }
            false
        }
    };
    if valid { Ok(Action::Forward) } else { Err(denied()) }
}
pub(crate) fn validate_prompt<'a>(state: &'a Value, flow: &str, prompt: &str) -> Result<&'a Value, RequestError> {
    if state["id"] != flow || state["status"] != "pending" || state["prompt"]["id"] != prompt { return Err(expired()); }
    Ok(&state["prompt"])
}
pub(crate) fn validate_select(state: &Value, flow: &str, prompt: &str, value: &str) -> Result<(), RequestError> {
    let p = validate_prompt(state, flow, prompt)?;
    if p["type"] != "select" {
        return Err(RequestError::new("secureInputRequired", "请在独立安全输入窗口填写凭据或授权码"));
    }
    if !p["options"].as_array().is_some_and(|options| options.iter().any(|o| o["id"].as_str() == Some(value))) { return Err(denied()); }
    Ok(())
}
pub(crate) fn validate_secure(state: &Value, flow: &str, prompt: &str) -> Result<(), RequestError> {
    let p = validate_prompt(state, flow, prompt)?;
    if !matches!(p["type"].as_str(), Some("text" | "secret" | "manual_code")) { return Err(expired()); }
    Ok(())
}
pub(crate) async fn read_login(endpoint: &Endpoint, flow: &str) -> Result<Value, RequestError> {
    if !valid_id(flow) { return Err(denied()); }
    let read = async {
        let response = endpoint.request(&format!("/pi/login/{flow}"), "GET", "", "").await
            .map_err(|_| RequestError::transport("无法检查当前登录步骤", false))?;
        if !response.status().is_success() { return Err(expired()); }
        let bytes = response.bytes().await.map_err(|_| RequestError::transport("无法读取登录步骤", false))?;
        if bytes.len() > 65536 { return Err(denied()); }
        serde_json::from_slice(&bytes).map_err(|_| denied())
    };
    tokio::time::timeout(Duration::from_secs(15), read).await
        .map_err(|_| RequestError::transport("检查登录步骤超时", false))?
}
pub(crate) fn validate_login_url(state: &Value, flow: &str, url: &str) -> Result<(), RequestError> {
    if state["id"] != flow || state["status"] != "pending" { return Err(expired()); }
    if url.len() > 8192 || url.chars().any(char::is_control) { return Err(denied()); }
    let parsed = reqwest::Url::parse(url).map_err(|_| denied())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() { return Err(denied()); }
    let allowed = state["events"].as_array().is_some_and(|events| events.iter().any(|event| match event["type"].as_str() {
        Some("auth_url") => event["url"].as_str() == Some(url),
        Some("device_code") => event["verificationUri"].as_str() == Some(url),
        Some("info") => event["links"].as_array().is_some_and(|links| links.iter().any(|link| link["url"].as_str() == Some(url))),
        _ => false,
    }));
    if allowed { Ok(()) } else { Err(RequestError::new("nativePolicyDenied", "只可打开当前登录步骤提供的 HTTPS 授权链接")) }
}
pub(crate) fn secure_body(prompt: &str, secret: &str) -> Result<zeroize::Zeroizing<String>, RequestError> {
    if !valid_id(prompt) || secret.trim().is_empty() || secret.len() > 16000 { return Err(denied()); }
    Ok(zeroize::Zeroizing::new(json!({"promptId":prompt,"value":secret}).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pending(kind: &str) -> Value { json!({"id":"flow-1","status":"pending","prompt":{"id":"step-1","type":kind,"options":[{"id":"device_code"}]}}) }
    #[test]
    fn only_exact_non_secret_controls_are_accepted() {
        for kind in ["oauth", "api_key"] {
            assert_eq!(classify("/pi/login", "POST", &json!({"provider":"openai-codex","type":kind,"requestId":"request-1"}).to_string()).unwrap(), Action::Forward);
        }
        for body in [json!({"provider":"openai-codex","type":"oauth"}), json!({"provider":"openai-codex","type":"oauth","requestId":"r","apiKey":"synthetic"})] {
            assert!(classify("/pi/login", "POST", &body.to_string()).is_err());
        }
        assert!(classify("/pi/anything", "POST", "{}").is_err());
        assert!(classify("/pi/login/f/input", "POST", r#"{"promptId":"p","value":"device_code","secret":"synthetic"}"#).is_err());
        assert!(classify("/pi/login/../cancel", "POST", "{}").is_err());
        assert_eq!(classify("/pi/login/f/cancel", "POST", "{}").unwrap(), Action::Cancel {flow:"f".into()});
    }
    #[test]
    fn login_urls_are_bound_to_current_sdk_events_and_https() {
        let mut state=json!({"id":"flow-1","status":"pending","events":[{"type":"auth_url","url":"https://login.example.invalid/oauth?test=1"},{"type":"device_code","verificationUri":"https://login.example.invalid/device"},{"type":"info","links":[{"url":"https://login.example.invalid/help"}]}]});
        for url in ["https://login.example.invalid/oauth?test=1","https://login.example.invalid/device","https://login.example.invalid/help"] {
            assert!(validate_login_url(&state,"flow-1",url).is_ok());
        }
        assert!(validate_login_url(&state,"other-flow","https://login.example.invalid/device").is_err());
        for url in ["https://other.example.invalid/", "https://login.example.invalid/oauth?test=2"] {assert!(validate_login_url(&state,"flow-1",url).is_err());}
        for url in ["http://login.example.invalid/","javascript:alert(1)","file:///tmp/test","https://user:pass@login.example.invalid/","https://login.example.invalid/\n"] {
            state["events"]=json!([{"type":"auth_url","url":url}]);assert!(validate_login_url(&state,"flow-1",url).is_err());
        }
        state["events"]=json!([{"type":"auth_url","url":"https://login.example.invalid/"}]);state["status"]=json!("cancelled");
        assert!(validate_login_url(&state,"flow-1","https://login.example.invalid/").is_err());
    }
    #[test]
    fn main_window_can_only_answer_current_select_options() {
        assert!(validate_select(&pending("select"), "flow-1", "step-1", "device_code").is_ok());
        assert!(validate_select(&pending("select"), "flow-1", "step-1", "synthetic-key").is_err());
        for kind in ["secret", "text", "manual_code"] {
            assert_eq!(validate_select(&pending(kind), "flow-1", "step-1", "device_code").unwrap_err().code, "secureInputRequired");
            assert!(validate_secure(&pending(kind), "flow-1", "step-1").is_ok());
        }
        assert!(validate_secure(&pending("select"), "flow-1", "step-1").is_err());
        let mut state=pending("secret");state["status"]=json!("cancelled");
        assert!(validate_secure(&state, "flow-1", "step-1").is_err());
        assert!(validate_secure(&pending("secret"), "other-flow", "step-1").is_err());
        assert!(validate_secure(&pending("secret"), "flow-1", "old-step").is_err());
    }
}
