//! Android first test build deliberately has no persistent credential backend.
//! Only non-secret profiles are saved. Process death requires re-entry/import.
use crate::{mobile_ssh::Credentials, transport::Profile};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use zeroize::{Zeroize, Zeroizing};
fn values() -> &'static Mutex<HashMap<String, Credentials>> {
    static VALUES: OnceLock<Mutex<HashMap<String, Credentials>>> = OnceLock::new();
    VALUES.get_or_init(Default::default)
}
fn account(p: &Profile) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\n{}\n{}\n{}",
            p.id,
            p.host.as_deref().unwrap_or(""),
            p.ssh_port.unwrap_or(22),
            p.host_key.as_deref().unwrap_or("")
        ))
    )
}
pub fn same_identity(a: &Profile, b: &Profile) -> bool {
    account(a) == account(b)
}
pub fn configure(p: &Profile, mut credentials: Credentials, save: bool) -> Result<(), String> {
    if save {
        return Err("Android 测试版仅支持会话内凭据；未启用持久化安全存储".into());
    }
    p.validate()?;
    crate::mobile_ssh::destination(p)?;
    crate::mobile_ssh::canonical_key(p.host_key.as_deref().ok_or("请先核验主机公钥")?)?;
    if credentials.method != "password" {
        credentials.password.zeroize();
    }
    if credentials.method != "privateKey" {
        credentials.private_key.zeroize();
        credentials.passphrase.zeroize();
    }
    credentials.validate()?;
    values()
        .lock()
        .map_err(|_| "凭据暂不可用")?
        .insert(account(p), credentials);
    Ok(())
}
pub fn credentials(p: &Profile) -> Result<Credentials, String> {
    values()
        .lock()
        .map_err(|_| "凭据暂不可用")?
        .get(&account(p))
        .cloned()
        .ok_or("此 Android 会话没有凭据，请在设置中重新输入密码或导入私钥".into())
}
pub fn store(p: &Profile, password: &str) -> Result<(), String> {
    configure(p, Credentials::password(password), false)
}
pub fn load(p: &Profile) -> Result<Zeroizing<String>, String> {
    Ok(Zeroizing::new(credentials(p)?.password.clone()))
}
pub fn forget(p: &Profile) -> Result<(), String> {
    values()
        .lock()
        .map_err(|_| "凭据暂不可用")?
        .remove(&account(p));
    Ok(())
}
