// Vault — Tauri native app wrapper
// Starts the Python web server as a sidecar and opens the UI in a native window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Start the Python web server in the background
            let vault_root = std::env::var("VAULT_ROOT")
                .unwrap_or_else(|_| {
                    dirs::home_dir()
                        .map(|h| h.join("vault").to_string_lossy().to_string())
                        .unwrap_or_else(|| ".".to_string())
                });

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
