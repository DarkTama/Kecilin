mod commands;

use commands::BatchState;
use tauri::Manager;

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build());
    // Drag-out is Windows-only for now (the UI hides it elsewhere).
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_drag::init());
    builder
        .manage(BatchState::default())
        .invoke_handler(tauri::generate_handler![
            commands::check_ffmpeg,
            commands::scan_directory,
            commands::scan_files,
            commands::start_batch,
            commands::cancel_batch,
            commands::open_output_folder,
            commands::prepare_preview,
            commands::prepare_thumbnail,
            commands::reveal_file,
            commands::copy_file_to_clipboard,
        ])
        .setup(|app| {
            commands::cleanup_cache(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Never leave an orphan ffmpeg encoding behind after the window closes.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<BatchState>() {
                    state.abort();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
