//! Device-only application secrets. Never serialize these into profiles or logs.
#[cfg(all(
    any(target_os = "macos", target_os = "ios"),
    not(pibo_tailscale_offline_test)
))]
mod apple {
    use security_framework::{
        access_control::{ProtectionMode, SecAccessControl},
        passwords::{self, PasswordOptions},
    };
    fn options(account: &str) -> PasswordOptions {
        let mut o = PasswordOptions::new_generic_password("dev.pibot.tailnet", account);
        o.set_access_synchronized(Some(false));
        o
    }
    pub fn load(account: &str) -> Result<Option<Vec<u8>>, String> {
        match passwords::generic_password(options(account)) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.code() == -25300 => Ok(None),
            Err(e) => Err(format!(
                "无法读取 Pibo 网络身份（OSStatus {}）；请检查设备解锁和应用权限",
                e.code()
            )),
        }
    }
    pub fn save(account: &str, value: &[u8]) -> Result<(), String> {
        let mut o = options(account);
        o.set_access_control(
            SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
                0,
            )
            .map_err(|_| "无法配置设备保护")?,
        );
        passwords::set_generic_password_options(value, o)
            .map_err(|e| format!("无法安全保存 Pibo 网络身份（OSStatus {}）", e.code()))
    }
    pub fn remove(account: &str) -> Result<(), String> {
        match passwords::delete_generic_password_options(options(account)) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()),
            Err(_) => Err("无法删除 Pibo 网络身份".into()),
        }
    }
}
#[cfg(all(
    any(target_os = "macos", target_os = "ios"),
    not(pibo_tailscale_offline_test)
))]
pub use apple::*;
#[cfg(any(
    pibo_tailscale_offline_test,
    not(any(target_os = "macos", target_os = "ios"))
))]
mod temporary {
    pub fn load(_: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
    pub fn save(_: &str, _: &[u8]) -> Result<(), String> {
        Err("此构建不支持持久化网络身份".into())
    }
    pub fn remove(_: &str) -> Result<(), String> {
        Ok(())
    }
}
#[cfg(any(
    pibo_tailscale_offline_test,
    not(any(target_os = "macos", target_os = "ios"))
))]
pub use temporary::*;
