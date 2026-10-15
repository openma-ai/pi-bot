use serde_json::{json, Value};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use sha2::{Digest, Sha256};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use std::path::Path;

// Release allowlist is explicit. No trusted runtime release has been published yet.
pub fn supported(os: &str, arch: &str) -> bool {
    os == "macos" && arch == "aarch64"
}
pub fn status() -> Value {
    json!({"supported":supported(std::env::consts::OS,std::env::consts::ARCH),"platform":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH),"availability":"notPublished","installed":null,"version":null})
}
pub fn install() -> Result<(), String> {
    if !supported(std::env::consts::OS, std::env::consts::ARCH) {
        return Err("此 OS/架构不允许下载或执行本地 runtime；请使用远程连接".into());
    }
    Err("尚未发布可信、可验证的 runtime 安装包。没有进行下载或安装".into())
}
// Format-neutral verified staging primitive. Only a vetted manifest may call it;
// it is NOT exposed as an arbitrary URL/path/bytes IPC command.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[allow(dead_code)]
fn stage_verified(
    root: &Path,
    version: &str,
    current: Option<&str>,
    os: &str,
    arch: &str,
    expected: &str,
    payload: &[u8],
) -> Result<(), String> {
    if !supported(os, arch) {
        return Err("Unsupported platform".into());
    }
    let next = semver::Version::parse(version).map_err(|_| "Invalid runtime version")?;
    if let Some(current) = current {
        if next < semver::Version::parse(current).map_err(|_| "Invalid installed version")? {
            return Err("Runtime downgrade rejected".into());
        }
    }
    let digest = format!("{:x}", Sha256::digest(payload));
    if expected.len() != 64 || digest != expected {
        return Err("Runtime integrity verification failed".into());
    }
    std::fs::create_dir_all(root).map_err(|_| "Cannot create runtime install directory")?;
    let destination = root.join(version);
    if destination.exists() {
        return Err("Runtime version already installed".into());
    }
    let temporary = root.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&temporary).map_err(|_| "Cannot stage runtime")?;
    let result = (|| {
        std::fs::write(temporary.join("verified-payload"), payload)
            .map_err(|_| "Cannot stage runtime payload")?;
        std::fs::write(temporary.join("version"), version)
            .map_err(|_| "Cannot stage runtime metadata")?;
        std::fs::rename(&temporary, &destination)
            .map_err(|_| "Cannot atomically install runtime")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowlist_excludes_mobile_and_unverified_desktop_targets() {
        assert!(supported("macos", "aarch64"));
        for (os, arch) in [
            ("ios", "aarch64"),
            ("android", "aarch64"),
            ("windows", "x86_64"),
            ("linux", "x86_64"),
            ("macos", "x86_64"),
        ] {
            assert!(!supported(os, arch));
        }
        assert_eq!(status()["availability"], "notPublished");
        assert!(install().is_err());
    }
    #[test]
    fn fixtures_require_integrity_platform_and_no_downgrade_before_atomic_staging() {
        let root = std::env::temp_dir().join(format!(
            "pi-runtime-install-fixture-{}",
            uuid::Uuid::new_v4()
        ));
        let payload = b"inert disposable test fixture - not executable";
        let digest = format!("{:x}", Sha256::digest(payload));
        assert!(stage_verified(&root, "1.0.0", None, "ios", "aarch64", &digest, payload).is_err());
        assert!(stage_verified(
            &root,
            "1.0.0",
            Some("2.0.0"),
            "macos",
            "aarch64",
            &digest,
            payload
        )
        .is_err());
        assert!(stage_verified(
            &root,
            "1.0.0",
            None,
            "macos",
            "aarch64",
            &"0".repeat(64),
            payload
        )
        .is_err());
        assert!(!root.exists());
        stage_verified(&root, "1.0.0", None, "macos", "aarch64", &digest, payload).unwrap();
        assert_eq!(
            std::fs::read(root.join("1.0.0/verified-payload")).unwrap(),
            payload
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
