#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use std::env;

static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Config {
    token: String,
    server_id: String,
    role_ids: Vec<String>,
    target_channel_id: String,
    test_message: String,
    timeout: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct LeakerInfo {
    id: String,
    username: String,
    display_name: String,
    avatar: String,
    roles: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SearchProgress {
    step: u32,
    total: u32,
    remaining: u32,
    message: String,
}

#[tauri::command]
async fn start_binary_search(
    config: Config,
    app_handle: tauri::AppHandle,
) -> Result<Option<LeakerInfo>, String> {
    if RUNNING.load(Ordering::SeqCst) {
        return Err("搜索已在运行中".to_string());
    }

    RUNNING.store(true, Ordering::SeqCst);

    let config_json = serde_json::to_string(&config)
        .map_err(|e| e.to_string())?;

    // 获取Python脚本路径
    let script_path = if cfg!(debug_assertions) {
        // 开发模式：使用项目目录
        std::path::PathBuf::from("python/tracker.py")
    } else {
        // 生产模式：使用资源目录
        app_handle.path_resolver()
            .resolve_resource("python/tracker.py")
            .ok_or("找不到Python脚本")?
    };

    let mut child = Command::new("python")
        .arg(&script_path)
        .arg("--config")
        .arg(&config_json)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动Python失败: {}", e))?;

    let stdout = child.stdout.take()
        .ok_or("无法获取stdout")?;

    let mut reader = BufReader::new(stdout).lines();
    let mut result: Option<LeakerInfo> = None;

    while let Ok(Some(line)) = reader.next_line().await {
        if !RUNNING.load(Ordering::SeqCst) {
            break;
        }

        if line.starts_with("PROGRESS:") {
            if let Ok(progress) = serde_json::from_str::<SearchProgress>(&line[9..]) {
                let _ = app_handle.emit_all("search-progress", progress);
            }
        } else if line.starts_with("RESULT:") {
            if let Ok(leaker) = serde_json::from_str::<LeakerInfo>(&line[7..]) {
                result = Some(leaker);
            }
        }
    }

    RUNNING.store(false, Ordering::SeqCst);
    Ok(result)
}

#[tauri::command]
fn stop_search() -> Result<(), String> {
    RUNNING.store(false, Ordering::SeqCst);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            start_binary_search,
            stop_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
