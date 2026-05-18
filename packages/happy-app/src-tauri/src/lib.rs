#[tauri::command]
fn debug_log(msg: String) {
    eprintln!("[HAPPY-DEBUG] {}", msg);
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("Only http and https links can be opened externally".to_string());
    }

    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&url).status();

    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open").arg(&url).status();

    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .status();

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let status: Result<std::process::ExitStatus, std::io::Error> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "opening external URLs is not supported on this platform",
    ));

    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("Failed to open URL: exit status {status}")),
        Err(error) => Err(format!("Failed to open URL: {error}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  #[cfg(target_os = "linux")]
  {
    // Work around WebKitGTK dmabuf/GBM rendering issues on some Wayland setups.
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
  }

  tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_websocket::init())
    .invoke_handler(tauri::generate_handler![debug_log, open_external_url])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      #[cfg(debug_assertions)]
      {
        use tauri::Manager;
        let window = app.get_webview_window("main").unwrap();
        window.open_devtools();
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
