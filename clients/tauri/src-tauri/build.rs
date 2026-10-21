fn main() {
    println!("cargo:rustc-check-cfg=cfg(pibo_tailscale_offline_test)");
    println!("cargo:rerun-if-env-changed=PIBO_TAILSCALE_OFFLINE_TEST");
    if std::env::var("PIBO_TAILSCALE_OFFLINE_TEST").as_deref() == Ok("1") {
        println!("cargo:rustc-cfg=pibo_tailscale_offline_test");
    }
    if std::env::var_os("CARGO_FEATURE_EMBEDDED_TAILSCALE").is_some() {
        let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
        assert!(
            target == "macos" || target == "ios",
            "Embedded Tailscale supports Apple targets only"
        );
        println!("cargo:rerun-if-env-changed=PIBO_TAILSCALE_LIB_DIR");
        // Xcode's Tauri phase filters arbitrary environment variables. The pinned
        // project-local helper output is therefore also a deterministic default.
        let platform = if target == "ios" {
            if std::env::var("TARGET").unwrap().contains("-sim")
                || std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64")
            {
                "ios-sim"
            } else {
                "ios"
            }
        } else {
            "macos"
        };
        let mut fallback = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("../.tailscale-build")
            .join(platform);
        if platform == "ios-sim" {
            fallback = fallback.join(std::env::var("CARGO_CFG_TARGET_ARCH").unwrap());
        }
        let dir = std::env::var("PIBO_TAILSCALE_LIB_DIR")
            .unwrap_or_else(|_| fallback.to_string_lossy().into_owned());
        assert!(
            std::path::Path::new(&dir).join("libtailscale.a").is_file(),
            "Build the pinned userspace archive with scripts/build-embedded-tailscale.sh first"
        );
        println!("cargo:rerun-if-changed={dir}/libtailscale.a");
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-lib=static=tailscale");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
        println!("cargo:rustc-link-lib=resolv");
    }
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    if os == "macos" || os == "ios" {
        println!("cargo:rerun-if-changed=native/file_export.m");
        cc::Build::new()
            .file("native/file_export.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("pibo_file_export");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!(
            "cargo:rustc-link-lib=framework={}",
            if os == "ios" { "UIKit" } else { "AppKit" }
        );
    }
    tauri_build::build()
}
