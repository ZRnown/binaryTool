#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::PathBuf;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// 获取tracker可执行文件路径，处理Windows长路径前缀
fn get_tracker_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        // 开发模式：使用Python脚本
        Ok(PathBuf::from("../python/tracker.py"))
    } else {
        // 生产模式：尝试多种路径
        // 方式1: 使用 resolve_resource
        if let Some(path) = app_handle.path_resolver().resolve_resource("tracker.exe") {
            let path_str = path.to_string_lossy().to_string();
            let clean_path = if path_str.starts_with("\\\\?\\") {
                PathBuf::from(&path_str[4..])
            } else {
                path
            };
            if clean_path.exists() {
                return Ok(clean_path);
            }
        }

        // 方式2: 使用 resource_dir
        if let Some(resource_dir) = app_handle.path_resolver().resource_dir() {
            let path = resource_dir.join("tracker.exe");
            let path_str = path.to_string_lossy().to_string();
            let clean_path = if path_str.starts_with("\\\\?\\") {
                PathBuf::from(&path_str[4..])
            } else {
                path
            };
            if clean_path.exists() {
                return Ok(clean_path);
            }
        }

        // 方式3: 使用 exe 所在目录
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                // 尝试 exe_dir/resources/tracker.exe
                let path = exe_dir.join("resources").join("tracker.exe");
                if path.exists() {
                    return Ok(path);
                }
                // 尝试 exe_dir/tracker.exe
                let path = exe_dir.join("tracker.exe");
                if path.exists() {
                    return Ok(path);
                }
            }
        }

        Err("找不到tracker.exe，请确保程序完整安装".to_string())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Config {
    token: String,
    #[serde(default)]
    listener_token: String,
    server_id: String,
    role_ids: Vec<String>,
    target_channel_id: String,
    test_message: String,
    timeout: u32,
    #[serde(default)]
    webhook_url: String,
    #[serde(default)]
    send_channel_id: String,
    #[serde(default)]
    proxy_enabled: bool,
    #[serde(default = "default_proxy_host")]
    proxy_host: String,
    #[serde(default = "default_proxy_port")]
    proxy_port: u16,
}

fn default_proxy_host() -> String {
    "127.0.0.1".to_string()
}

fn default_proxy_port() -> u16 {
    7897
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct LeakerInfo {
    id: String,
    username: String,
    display_name: String,
    avatar: String,
    roles: Vec<String>,
    #[serde(default)]
    confirmed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SearchProgress {
    step: u32,
    total: u32,
    remaining: u32,
    message: String,
    #[serde(default)]
    names: Vec<String>,
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

    let tracker_path = get_tracker_path(&app_handle)?;

    // 根据模式选择命令
    let mut child = if cfg!(debug_assertions) {
        // 开发模式：使用 python 运行脚本
        Command::new("python")
            .arg(&tracker_path)
            .arg("--config")
            .arg(&config_json)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动Python失败: {}", e))?
    } else {
        // 生产模式：直接运行 exe
        Command::new(&tracker_path)
            .arg("--config")
            .arg(&config_json)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动tracker失败: {}", e))?
    };

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

#[tauri::command]
async fn test_connection(
    token: String,
    proxyEnabled: bool,
    proxyHost: String,
    proxyPort: u16,
    app_handle: tauri::AppHandle
) -> Result<String, String> {
    let tracker_path = get_tracker_path(&app_handle)?;

    // 根据模式选择命令
    let output = if cfg!(debug_assertions) {
        // 开发模式：使用 python 运行脚本
        let mut cmd = Command::new("python");
        cmd.arg(&tracker_path)
            .arg("--test-connection")
            .arg(&token);

        if proxyEnabled {
            cmd.arg("--proxy")
                .arg(format!("{}:{}", proxyHost, proxyPort));
        }

        cmd.output()
            .await
            .map_err(|e| format!("启动Python失败: {}", e))?
    } else {
        // 生产模式：直接运行 exe
        let mut cmd = Command::new(&tracker_path);
        cmd.arg("--test-connection")
            .arg(&token);

        if proxyEnabled {
            cmd.arg("--proxy")
                .arg(format!("{}:{}", proxyHost, proxyPort));
        }

        cmd.output()
            .await
            .map_err(|e| format!("启动tracker失败: {}", e))?
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    // 查找包含 CONNECTED: 的行
    for line in stdout.lines() {
        if line.starts_with("CONNECTED:") {
            return Ok(line[10..].trim().to_string());
        }
    }

    // 没找到 CONNECTED，返回错误
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.is_empty() {
        Err(format!("连接失败，stdout: {}", stdout))
    } else {
        Err(stderr.to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            start_binary_search,
            stop_search,
            test_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
