fn main() {
    let root = std::env::args()
        .nth(1)
        .expect("disposable fixture directory required");
    tauri::async_runtime::block_on(pi_bot_desktop::ssh_fixture::serve(
        std::path::PathBuf::from(root),
    ));
}
