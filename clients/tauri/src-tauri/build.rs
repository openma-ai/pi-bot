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
        let dir = std::env::var("PIBO_TAILSCALE_LIB_DIR").expect(
            "Set PIBO_TAILSCALE_LIB_DIR to the target-specific directory containing libtailscale.a",
        );
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-lib=static=tailscale");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
        println!("cargo:rustc-link-lib=resolv");
    }
    tauri_build::build()
}
