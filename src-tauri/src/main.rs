// Vault — Tauri native app wrapper
// Starts the Python web server as a sidecar and opens the UI in a native window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            // Start the Python web server in the background
            let vault_root = std::env::var("VAULT_ROOT").unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                format!("{}/vault", home)
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
