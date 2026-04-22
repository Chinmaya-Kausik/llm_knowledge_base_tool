// Loom — Tauri native app wrapper
// Starts the Python web server as a sidecar and opens the UI in a native window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".loom-app-config.json")
}

fn default_loom_root() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    format!("{}/Documents/loom", home)
}

fn read_loom_root() -> String {
    if let Ok(root) = std::env::var("LOOM_ROOT") {
        return root;
    }
    if let Ok(data) = fs::read_to_string(config_path()) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(root) = config.get("loom_root").and_then(|v| v.as_str()) {
                let path = PathBuf::from(root);
                // Reject temp/pytest paths and non-existent parents
                if !root.contains("/pytest-") && !root.contains("/tmp/") && !root.contains("/var/folders/")
                    && path.parent().map_or(false, |p| p.exists())
                {
                    return root.to_string();
                }
                eprintln!("Loom: ignoring stale config root: {}", root);
            }
        }
    }
    default_loom_root()
}

fn save_loom_root(root: &str) {
    let config = serde_json::json!({"loom_root": root});
    let _ = fs::write(config_path(), serde_json::to_string_pretty(&config).unwrap());
}

/// Find the loom project directory (contains pyproject.toml).
/// Checks known locations in order.
fn find_project_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let candidates = [
        PathBuf::from(&home).join("Documents/loom/projects/loom"),
        PathBuf::from(&home).join("Documents/GitHub/loom"),
    ];
    for dir in &candidates {
        if dir.join("pyproject.toml").exists() {
            return Some(dir.clone());
        }
    }
    None
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

/// Wait for the server to accept connections on the given port.
fn wait_for_server(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// HTML error page shown when the server fails to start.
fn error_page(title: &str, detail: &str) -> String {
    format!(r#"data:text/html,<html>
<head><style>
  body {{ font-family: -apple-system, system-ui, sans-serif; background: %231a1a2e; color: %23e0e0e0;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }}
  .box {{ text-align: center; max-width: 500px; }}
  h1 {{ color: %23ff6b6b; font-size: 1.5em; }}
  p {{ line-height: 1.6; color: %23a0a0a0; }}
  code {{ background: %232a2a3e; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }}
</style></head>
<body><div class="box">
  <h1>{title}</h1>
  <p>{detail}</p>
</div></body></html>"#)
}

fn main() {
    let server_process: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let sp_setup = Arc::clone(&server_process);
    let sp_event = Arc::clone(&server_process);

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_loom_root, set_loom_root])
        .setup(move |app| {
            let loom_root = read_loom_root();
            save_loom_root(&loom_root);

            let window = app.get_webview_window("main").unwrap();

            let project_dir = match find_project_dir() {
                Some(d) => d,
                None => {
                    let _ = window.navigate(error_page(
                        "Loom project not found",
                        "Could not find <code>pyproject.toml</code> in:<br>\
                         <code>~/Documents/loom/projects/loom</code><br>\
                         <code>~/Documents/GitHub/loom</code><br><br>\
                         Clone the loom repo to one of these locations and relaunch."
                    ).parse().unwrap());
                    let _ = window.show();
                    return Ok(());
                }
            };

            // Resolve uv path — GUI apps don't inherit shell PATH
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            let uv_candidates = [
                PathBuf::from(&home).join(".local/bin/uv"),
                PathBuf::from(&home).join(".cargo/bin/uv"),
                PathBuf::from("/usr/local/bin/uv"),
                PathBuf::from("/opt/homebrew/bin/uv"),
            ];
            let uv_path = match uv_candidates.iter().find(|p| p.exists()) {
                Some(p) => p.clone(),
                None => {
                    let _ = window.navigate(error_page(
                        "uv not found",
                        "Loom requires <code>uv</code> to run the Python server.<br><br>\
                         Install it with: <code>curl -LsSf https://astral.sh/uv/install.sh | sh</code><br><br>\
                         Then relaunch Loom."
                    ).parse().unwrap());
                    let _ = window.show();
                    return Ok(());
                }
            };

            eprintln!("Loom: project_dir={}, loom_root={}, uv={}",
                project_dir.display(), loom_root, uv_path.display());

            // Check if port 8420 is already in use
            if TcpStream::connect(("127.0.0.1", 8420)).is_ok() {
                let _ = window.navigate(error_page(
                    "Port 8420 already in use",
                    "Another Loom server (or other application) is already running on port 8420.<br><br>\
                     Close the other server first, then relaunch Loom.<br><br>\
                     To find and kill it: <code>lsof -ti:8420 | xargs kill</code>"
                ).parse().unwrap());
                let _ = window.show();
                return Ok(());
            }

            let child = Command::new(&uv_path)
                .args(["run", "--extra", "web", "python", "-m", "loom_mcp.web"])
                .current_dir(&project_dir)
                .env("LOOM_ROOT", &loom_root)
                .env("PATH", format!("{}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", home))
                .spawn();

            match child {
                Ok(c) => {
                    eprintln!("Loom: server started (pid {})", c.id());
                    *sp_setup.lock().unwrap() = Some(c);
                }
                Err(e) => {
                    eprintln!("Loom: failed to spawn server: {}", e);
                    let _ = window.navigate(error_page(
                        "Server failed to start",
                        &format!("Could not spawn the Python server:<br><code>{}</code><br><br>\
                                  Check that <code>uv</code> and Python are installed correctly.", e)
                    ).parse().unwrap());
                    let _ = window.show();
                    return Ok(());
                }
            }

            // Wait for server to be ready in background, then show the window
            let win = window.clone();
            std::thread::spawn(move || {
                if wait_for_server(8420, Duration::from_secs(15)) {
                    let _ = win.navigate("http://localhost:8420".parse().unwrap());
                } else {
                    eprintln!("Loom: server did not become ready within 15s");
                    let _ = win.navigate(error_page(
                        "Server timeout",
                        "The Python server started but didn't respond within 15 seconds.<br><br>\
                         Check the terminal for errors, or try running <code>loom-dev.command</code> manually."
                    ).parse().unwrap());
                }
                let _ = win.show();
            });

            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = sp_event.lock().unwrap().take() {
                    eprintln!("Loom: shutting down server (pid {})", child.id());
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Loom");
}
