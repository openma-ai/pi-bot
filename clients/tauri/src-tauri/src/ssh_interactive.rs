//! The only outbound event contains untrusted, bounded server prompts. Answers
//! travel through a one-shot command to SSH, never through events or persistence.
use crate::mobile_ssh::{PromptFuture, PromptHandler};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::Emitter;
use tokio::sync::oneshot;
type Answer = Result<Vec<String>, String>;
fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<Answer>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<Answer>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}
struct Pending(String, tauri::AppHandle);
impl Drop for Pending {
    fn drop(&mut self) {
        if let Ok(mut map) = pending().lock() {
            map.remove(&self.0);
        }
        let _ = self.1.emit_to(
            "main",
            "ssh-challenge-closed",
            serde_json::json!({"id":self.0}),
        );
    }
}
pub fn handler(app: tauri::AppHandle) -> PromptHandler {
    Arc::new(move |prompts| {
        let app = app.clone();
        Box::pin(async move {
            let id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = oneshot::channel();
            pending()
                .lock()
                .map_err(|_| "交互验证暂不可用")?
                .insert(id.clone(), tx);
            let _guard = Pending(id.clone(), app.clone());
            app.emit_to(
                "main",
                "ssh-challenge",
                serde_json::json!({"id":id,"prompts":prompts}),
            )
            .map_err(|_| "无法显示 SSH 验证")?;
            let result = rx.await.map_err(|_| "SSH 验证已取消")?;
            let _ = app.emit_to("main", "ssh-challenge-closed", serde_json::json!({"id":id}));
            result
        }) as PromptFuture
    })
}
pub fn respond(id: &str, answers: Option<Vec<String>>) -> Result<(), String> {
    if id.len() != 36
        || answers
            .as_ref()
            .is_some_and(|values| values.len() > 8 || values.iter().any(|value| value.len() > 4096))
    {
        return Err("验证响应超出限制".into());
    }
    let tx = pending()
        .lock()
        .map_err(|_| "验证暂不可用")?
        .remove(id)
        .ok_or("此验证已过期，请重新连接")?;
    tx.send(answers.ok_or_else(|| "SSH 验证已取消".into()))
        .map_err(|_| "此验证已结束".into())
}
