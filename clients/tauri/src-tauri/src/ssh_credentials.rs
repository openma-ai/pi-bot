//! Secrets are never part of Profile, JSON persistence, status, URLs, or logs.
use crate::transport::Profile;
use security_framework::{
    access_control::{ProtectionMode, SecAccessControl},
    passwords::{self, PasswordOptions},
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;
const SERVICE: &str = "dev.pibot.ios.ssh-password";
fn account(p: &Profile) -> String {
    // Bind credentials to the connection identity as well as profile ID.
    format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}\n{}\n{}\n{}",
                p.id,
                p.host.as_deref().unwrap_or(""),
                p.ssh_port.unwrap_or(22),
                p.host_key.as_deref().unwrap_or("")
            )
            .as_bytes()
        )
    )
}
pub fn same_identity(a: &Profile, b: &Profile) -> bool {
    account(a) == account(b)
}
fn options(p: &Profile) -> PasswordOptions {
    let mut o = PasswordOptions::new_generic_password(SERVICE, &account(p));
    o.set_access_synchronized(Some(false));
    o
}
pub fn store(p: &Profile, password: &str) -> Result<(), String> {
    p.validate()?;
    crate::mobile_ssh::destination(p)?;
    crate::mobile_ssh::canonical_key(p.host_key.as_deref().ok_or("请先核验主机公钥")?)?;
    if password.is_empty() || password.len() > 4096 {
        return Err("SSH 密码为空或过长".into());
    }
    let mut o = options(p);
    o.set_access_control(
        SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            0,
        )
        .map_err(|_| "无法配置 Keychain 保护")?,
    );
    passwords::set_generic_password_options(password.as_bytes(), o)
        .map_err(|error| format!("无法保存到 Keychain（OSStatus {}）", error.code()))
}
pub fn load(p: &Profile) -> Result<Zeroizing<String>, String> {
    let bytes = Zeroizing::new(
        passwords::generic_password(options(p))
            .map_err(|_| "请在设置中保存 SSH 密码；解锁设备后重试")?,
    );
    String::from_utf8(bytes.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| "Keychain 凭据格式错误".to_string())
}
pub fn remove(p: &Profile) -> Result<(), String> {
    match passwords::delete_generic_password_options(options(p)) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == -25300 => Ok(()),
        Err(_) => Err("无法删除 Keychain 中的 SSH 密码".into()),
    }
}

fn volatile(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, crate::mobile_ssh::Credentials>> {
    static VALUES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, crate::mobile_ssh::Credentials>>,
    > = std::sync::OnceLock::new();
    VALUES.get_or_init(Default::default)
}
fn credential_options(p: &Profile) -> PasswordOptions {
    let mut o = PasswordOptions::new_generic_password("dev.pibot.ios.ssh-credentials", &account(p));
    o.set_access_synchronized(Some(false));
    o
}
pub fn configure(
    p: &Profile,
    mut credentials: crate::mobile_ssh::Credentials,
    save: bool,
) -> Result<(), String> {
    use zeroize::Zeroize;
    if credentials.method != "password" {
        credentials.password.zeroize();
    }
    if credentials.method != "privateKey" {
        credentials.private_key.zeroize();
        credentials.passphrase.zeroize();
    }
    credentials.validate()?;
    crate::mobile_ssh::canonical_key(p.host_key.as_deref().ok_or("请先核验主机公钥")?)?;
    if save {
        let json = Zeroizing::new(serde_json::to_string(&credentials).map_err(|_| "凭据格式错误")?);
        let mut options = credential_options(p);
        options.set_access_control(
            SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
                0,
            )
            .map_err(|_| "无法配置 Keychain 保护")?,
        );
        passwords::set_generic_password_options(json.as_bytes(), options)
            .map_err(|_| "无法保存凭据到 Keychain；请解锁设备后重试")?;
    }
    volatile()
        .lock()
        .map_err(|_| "凭据暂不可用")?
        .insert(account(p), credentials);
    Ok(())
}
pub fn credentials(p: &Profile) -> Result<crate::mobile_ssh::Credentials, String> {
    if let Some(value) = volatile()
        .lock()
        .map_err(|_| "凭据暂不可用")?
        .get(&account(p))
    {
        return Ok(value.clone());
    }
    match passwords::generic_password(credential_options(p)) {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            serde_json::from_slice(&bytes).map_err(|_| "已保存凭据格式错误，请重新导入".to_string())
        }
        Err(e) if e.code() == -25300 => Ok(crate::mobile_ssh::Credentials::password(&load(p)?)),
        Err(_) => Err("无法访问 Keychain；请解锁设备后重连".into()),
    }
}
pub fn forget(p: &Profile) -> Result<(), String> {
    volatile()
        .lock()
        .map_err(|_| "凭据暂不可用")?
        .remove(&account(p));
    match passwords::delete_generic_password_options(credential_options(p)) {
        Ok(()) => {}
        Err(e) if e.code() == -25300 => {}
        Err(_) => return Err("无法删除保存的凭据".into()),
    }
    remove(p)
}
