// Vault — Tauri native app wrapper
// Starts the Python web server as a sidecar and opens the UI in a native window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".loom-app-config.json")
}

fn read_loom_root() -> String {
    // Priority: env var > config file > default
    if let Ok(root) = std::env::var("LOOM_ROOT") {
        return root;
    }
    if let Ok(data) = fs::read_to_string(config_path()) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(root) = config.get("loom_root").and_then(|v| v.as_str()) {
                return root.to_string();
            }
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    format!("{}/Documents/loom", home)
}

fn save_loom_root(root: &str) {
    let config = serde_json::json!({"loom_root": root});
    let _ = fs::write(config_path(), serde_json::to_string_pretty(&config).unwrap());
}

#[tauri::command]
fn get_loom_root() -> String {
    read_loom_root()
}

#[tauri::command]
fn set_loom_root(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }
    save_loom_root(&path);
    Ok(path)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_loom_root, set_loom_root])
        .setup(|_app| {
            let loom_root = read_loom_root();
            save_loom_root(&loom_root); // Persist default if first run

            std::thread::spawn(move || {
                let status = Command::new("uv")
                    .args(["run", "--extra", "web", "python", "-m", "loom_mcp.web"])
                    .env("LOOM_ROOT", &loom_root)
                    .status();

                if let Err(e) = status {
                    eprintln!("Failed to start loom server: {}", e);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vault");
}
