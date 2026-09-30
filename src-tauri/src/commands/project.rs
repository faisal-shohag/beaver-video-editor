//! Project files (.beaver JSON) and crash-safe autosave.
use tauri::{AppHandle, Manager};

fn autosave_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("autosave.beaver"))
}

/// Write via temp file + rename so a crash never leaves a half-written project.
fn atomic_write(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_project(path: String, contents: String) -> Result<(), String> {
    atomic_write(std::path::Path::new(&path), &contents)
}

#[tauri::command]
pub fn load_project(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot open project: {e}"))
}

#[tauri::command]
pub fn write_autosave(app: AppHandle, contents: String) -> Result<(), String> {
    atomic_write(&autosave_path(&app)?, &contents)
}

#[tauri::command]
pub fn read_autosave(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(autosave_path(&app).ok()?).ok()
}

#[tauri::command]
pub fn clear_autosave(app: AppHandle) {
    if let Ok(p) = autosave_path(&app) {
        let _ = std::fs::remove_file(p);
    }
}

#[tauri::command]
pub fn files_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).exists()).collect()
}
