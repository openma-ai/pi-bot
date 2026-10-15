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
