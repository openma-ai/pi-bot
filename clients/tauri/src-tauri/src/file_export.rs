use base64::Engine;
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 480
        && name != "."
        && name != ".."
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
unsafe extern "C" {
    fn pibo_export_file(
        path: *const std::ffi::c_char,
        name: *const std::ffi::c_char,
        done: unsafe extern "C" fn(i32, *mut std::ffi::c_void),
        context: *mut std::ffi::c_void,
    );
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
unsafe extern "C" fn exported(status: i32, context: *mut std::ffi::c_void) {
    let sender = unsafe { Box::from_raw(context as *mut tokio::sync::oneshot::Sender<i32>) };
    let _ = sender.send(status);
}
#[tauri::command]
pub async fn file_export(
    window: tauri::Window,
    name: String,
    data: String,
) -> Result<bool, String> {
    crate::main_window(&window)?;
    if !safe_name(&name) || data.len() > 11_184_812 {
        return Err("文件名无效或文件超过 8 MiB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|_| "Invalid binary file data")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("File too large".into());
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use std::io::Write;
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let dir = std::env::temp_dir().join(format!("pibo-export-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|_| "Cannot prepare file export")?;
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(dir.clone());
        let path = dir.join(&name);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|_| "Cannot stage file")?;
        file.write_all(&bytes).map_err(|_| "Cannot stage file")?;
        drop(file);
        let path = std::ffi::CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| "Invalid path")?;
        let name = std::ffi::CString::new(name).map_err(|_| "Invalid name")?;
        let (sender, receiver) = tokio::sync::oneshot::channel::<i32>();
        unsafe {
            pibo_export_file(
                path.as_ptr(),
                name.as_ptr(),
                exported,
                Box::into_raw(Box::new(sender)) as *mut std::ffi::c_void,
            );
        }
        match receiver.await.map_err(|_| "File export interrupted")? {
            1 => Ok(true),
            0 => Ok(false),
            _ => Err("无法保存或分享文件".into()),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = bytes;
        Err("Native file export currently supports Apple clients".into())
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn names_cannot_escape_staging() {
        for name in ["../x", "/tmp/x", "x\\y", ".", "a\0b"] {
            assert!(!super::safe_name(name));
        }
        assert!(super::safe_name("报告.pdf"));
    }
}

pub async fn open_tailscale_login(url: &str) -> Result<(), String> {
    if !crate::tailscale::official_login_url(url) {
        return Err("Invalid authorization URL".into());
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        unsafe extern "C" {
            fn pibo_open_login(
                url: *const std::ffi::c_char,
                done: unsafe extern "C" fn(i32, *mut std::ffi::c_void),
                context: *mut std::ffi::c_void,
            );
        }
        let url = std::ffi::CString::new(url).map_err(|_| "Invalid authorization URL")?;
        let (sender, receiver) = tokio::sync::oneshot::channel::<i32>();
        unsafe {
            pibo_open_login(
                url.as_ptr(),
                exported,
                Box::into_raw(Box::new(sender)) as *mut std::ffi::c_void,
            );
        }
        if receiver.await.map_err(|_| "打开浏览器被中断")? == 1 {
            Ok(())
        } else {
            Err("无法打开系统浏览器，请重试".into())
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Err("Browser authorization requires an Apple client".into())
    }
}

pub fn close_tailscale_login() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        unsafe extern "C" {
            fn pibo_close_login();
        }
        unsafe {
            pibo_close_login();
        }
    }
}
