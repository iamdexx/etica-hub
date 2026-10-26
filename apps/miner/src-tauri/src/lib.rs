mod engines;
mod hardware;

use engines::{Engine, EngineKind, MinerState};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

pub struct AppState {
    miners: Arc<Mutex<MinerState>>,
}

#[derive(Serialize)]
pub struct StartResult {
    cpu: bool,
    gpu: bool,
}

fn valid_wallet(w: &str) -> bool {
    w.len() == 42 && w.starts_with("0x") && w[2..].chars().all(|c| c.is_ascii_hexdigit())
}

#[tauri::command]
fn detect_hardware() -> hardware::Hardware {
    hardware::detect()
}

#[tauri::command]
async fn start_mining(
    app: AppHandle,
    state: State<'_, AppState>,
    wallet: String,
    cpu: bool,
    gpu: bool,
    cpu_percent: u8,
) -> Result<StartResult, String> {
    if !valid_wallet(&wallet) {
        return Err("That is not a valid 0x wallet address".into());
    }
    let hw = hardware::detect();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("engines");
    let mut st = state.miners.lock().await;
    st.stop_all();
    let mut started = StartResult {
        cpu: false,
        gpu: false,
    };
    if cpu {
        let eng = Engine::ensure(&app, &dir, EngineKind::Xmrig).await?;
        st.cpu = Some(eng.spawn_cpu(&wallet, hw.cpu_threads, cpu_percent)?);
        started.cpu = true;
    }
    if gpu {
        if !hw.gpu_supported {
            if !cpu {
                return Err("No supported GPU found for EGAZ; enable ETI on CPU instead".into());
            }
            let _ = app.emit(
                "log",
                "GPU mining skipped: no supported GPU on this machine",
            );
        } else {
            let eng = Engine::ensure(&app, &dir, EngineKind::LolMiner).await?;
            st.gpu = Some(eng.spawn_gpu(&wallet)?);
            started.gpu = true;
        }
    }
    let _ = app.emit("log", format!("Mining to {wallet}"));
    Ok(started)
}

#[tauri::command]
async fn stop_mining(state: State<'_, AppState>) -> Result<(), String> {
    state.miners.lock().await.stop_all();
    Ok(())
}

#[tauri::command]
async fn miner_status(state: State<'_, AppState>) -> Result<engines::Status, String> {
    let mut st = state.miners.lock().await;
    Ok(st.status().await)
}

#[tauri::command]
async fn fetch_json(url: String) -> Result<serde_json::Value, String> {
    if !(url.starts_with("https://pool.eticahub.com/")
        || url.starts_with("https://etipool.eticahub.com/"))
    {
        return Err("url not allowed".into());
    }
    let r = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status()));
    }
    r.json().await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            miners: Arc::new(Mutex::new(MinerState::default())),
        })
        .invoke_handler(tauri::generate_handler![
            detect_hardware,
            start_mining,
            stop_mining,
            miner_status,
            fetch_json
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(st) = window.try_state::<AppState>() {
                    if let Ok(mut m) = st.miners.try_lock() {
                        m.stop_all();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running EticaHub Miner");
}
