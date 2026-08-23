mod commands;

use commands::BatchState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(BatchState::default())
        .invoke_handler(tauri::generate_handler![
            commands::check_ffmpeg,
            commands::scan_directory,
            commands::start_batch,
            commands::cancel_batch,
            commands::open_output_folder,
        ])
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
