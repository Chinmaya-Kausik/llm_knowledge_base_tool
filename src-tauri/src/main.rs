// Vault — Tauri native app wrapper
// Starts the Python web server as a sidecar and opens the UI in a native window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".vault-app-config.json")
}

fn read_vault_root() -> String {
    // Priority: env var > config file > default
    if let Ok(root) = std::env::var("VAULT_ROOT") {
        return root;
    }
    if let Ok(data) = fs::read_to_string(config_path()) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(root) = config.get("vault_root").and_then(|v| v.as_str()) {
                return root.to_string();
            }
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    format!("{}/vault", home)
}

fn save_vault_root(root: &str) {
    let config = serde_json::json!({"vault_root": root});
    let _ = fs::write(config_path(), serde_json::to_string_pretty(&config).unwrap());
}

#[tauri::command]
fn get_vault_root() -> String {
    read_vault_root()
}

#[tauri::command]
fn set_vault_root(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }
    save_vault_root(&path);
    Ok(path)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_vault_root, set_vault_root])
        .setup(|_app| {
            let vault_root = read_vault_root();
            save_vault_root(&vault_root); // Persist default if first run

            std::thread::spawn(move || {
                let status = Command::new("uv")
                    .args(["run", "--extra", "web", "python", "-m", "vault_mcp.web"])
                    .env("VAULT_ROOT", &vault_root)
                    .status();

                if let Err(e) = status {
                    eprintln!("Failed to start vault server: {}", e);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vault");
}
