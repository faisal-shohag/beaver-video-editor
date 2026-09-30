pub mod commands;
pub mod enhance;
pub mod ffmpeg;
pub mod jobs;
pub mod model;

use commands::{encoders, export, media, project};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(encoders::EncoderState::default())
        .manage(jobs::Jobs::default())
        .setup(|app| {
            use tauri::Manager;
            if let Ok(dir) = app.path().resource_dir() {
                enhance::onnx::set_runtime_path(dir.join("onnxruntime.dll"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            media::probe_media,
            media::check_needs_proxy,
            media::generate_proxy,
            media::generate_thumbnails,
            media::generate_waveform,
            encoders::get_encoders,
            export::start_export,
            export::cancel_export,
            jobs::cancel_job,
            enhance::start_enhance,
            enhance::enhanced_path,
            enhance::models::enhance_models,
            enhance::models::download_model,
            export::check_copy_eligible,
            export::quick_join_check,
            export::quick_join,
            project::save_project,
            project::load_project,
            project::write_autosave,
            project::read_autosave,
            project::clear_autosave,
            project::files_exist,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Beaver Video Editor");
}
