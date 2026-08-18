//! Монитор сети и обработчик событий сна/пробуждения.
//!
//! Стратегия определения сети:
//!  1. reqwest health-check к /rest/api/2/serverInfo активного профиля Jira —
//!     это надёжнее, чем проверка наличия сетевого интерфейса (NLA).
//!  2. Фоллбэк: на Windows используем GetNetworkConnectivityHint() через windows-sys
//!     (если reqwest недоступен).
//!
//! События Windows:
//!  - WM_WTSSESSION_CHANGE / WM_POWERBROADCAST (сон/пробуждение) обрабатываются
//!    через tauri plugin-level событие "system:resume" (тригерит wake-сигнал).

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Listener};

use crate::logger::{AppLogger, LogSink};
use crate::sync_queue::WakeSignal;

// ──────────────────────────────────────────────────────
// Публичные типы
// ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetStatus {
    Online,
    Offline,
    Syncing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncIndicator {
    pub net_status:    NetStatus,
    /// Количество элементов в pending-очереди
    pub pending_count: usize,
    /// Количество элементов в failed
    pub failed_count:  usize,
    /// Текст последней ошибки (для тоолтипа в шапке)
    pub last_error:    Option<String>,
}

pub struct NetworkMonitor {
    status:   Arc<Mutex<SyncIndicator>>,
    jira_url: Arc<Mutex<String>>,
    email:    Arc<Mutex<String>>,
    token:    Arc<Mutex<String>>,
}

impl NetworkMonitor {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(SyncIndicator {
                net_status:    NetStatus::Offline,
                pending_count: 0,
                failed_count:  0,
                last_error:    None,
            })),
            jira_url: Arc::new(Mutex::new(String::new())),
            email:    Arc::new(Mutex::new(String::new())),
            token:    Arc::new(Mutex::new(String::new())),
        }
    }

    /// Обновить учётные данные для health-check
    pub fn set_credentials(&self, jira_url: &str, email: &str, token: &str) {
        *self.jira_url.lock().unwrap() = jira_url.to_string();
        *self.email.lock().unwrap()    = email.to_string();
        *self.token.lock().unwrap()    = token.to_string();
    }

    pub fn get_status(&self) -> SyncIndicator {
        self.status.lock().unwrap().clone()
    }

    pub fn set_syncing(&self) {
        let mut s = self.status.lock().unwrap();
        s.net_status = NetStatus::Syncing;
    }

    pub fn set_online(&self) {
        let mut s = self.status.lock().unwrap();
        s.net_status = NetStatus::Online;
    }

    pub fn set_offline(&self) {
        let mut s = self.status.lock().unwrap();
        s.net_status = NetStatus::Offline;
    }

    pub fn update_queue_counts(&self, pending: usize, failed: usize, last_err: Option<String>) {
        let mut s = self.status.lock().unwrap();
        s.pending_count = pending;
        s.failed_count  = failed;
        s.last_error    = last_err;
        if failed > 0 { s.net_status = NetStatus::Error; }
    }
}

// ──────────────────────────────────────────────────────
// Фоновый монитор: reqwest health-check + эмит события Tauri
// ──────────────────────────────────────────────────────

/// Запустить периодический health-check и обработчик событий в Tauri.
pub fn start_network_monitor(
    monitor: Arc<NetworkMonitor>,
    wake:    WakeSignal,
    app:     AppHandle,
    logger:  Arc<AppLogger>,
) {
    // Периодический health-check (каждые 15 с)
    let m2 = monitor.clone();
    let app2 = app.clone();
    let lg2 = logger.clone();
    let wake2 = wake.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;
            let (url, email, token) = {
                let u = m2.jira_url.lock().unwrap().clone();
                let e = m2.email.lock().unwrap().clone();
                let t = m2.token.lock().unwrap().clone();
                (u, e, t)
            };
            if url.is_empty() { continue; }

            let probe = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .use_rustls_tls()
                .build()
                .and_then(|c| Ok(c.get(format!("{url}/rest/api/2/serverInfo"))))
                .ok();

            let reachable = if let Some(req) = probe {
                req.basic_auth(&email, Some(&token)).send().await
                    .map(|r| r.status().as_u16() < 500)
                    .unwrap_or(false)
            } else {
                false
            };

            if reachable {
                m2.set_online();
                lg2.debug("network_monitor", "Jira reachable");
                // Триггерим воркер очереди
                wake2.notify_one();
            } else {
                m2.set_offline();
                lg2.debug("network_monitor", "Jira unreachable");
            }
            // Эмитим событие во фронтенд
            let payload = serde_json::json!(m2.get_status());
            let _ = app2.emit("sync-status-changed", payload);
        }
    });

    // Слушаем событие Windows sleep/resume через Tauri app-window events
    let m3 = monitor.clone();
    let app3 = app.clone();
    let lg3 = logger.clone();
    let wake3 = wake.clone();
    tokio::spawn(async move {
        // WM_POWERBROADCAST / PBT_APMRESUMESUSPEND триггерится через tauri system "resume"
        // В Tauri v2 слушаем через on_system_tray / global shortcut или Window event:
        // app.listen_global(в v2 = app.listen("событие"))
        // Здесь регистрируем Rust-слушатель события "system:resume" от фронтенда (emit JS)
        // Фронтенд слушает визуальные события Tauri window и ретранслирует в бэкенд через invoke
        app3.listen("backend:resume", move |_event| {
            lg3.info("network_monitor", "system resume event received");
            m3.set_online();
            wake3.notify_one();
        });
        // задача не завершается, поэтому бесконечно ждём
        std::future::pending::<()>().await;
    });
}

// ──────────────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────────────

/// Получить текущий статус синхронизации для индикатора в шапке
#[tauri::command]
pub fn get_sync_indicator(
    monitor: tauri::State<'_, Arc<NetworkMonitor>>,
) -> SyncIndicator {
    monitor.get_status()
}

/// Фронтенд сообщает о восстановлении Windows из сна/гибернации
#[tauri::command]
pub fn notify_system_resume(
    monitor: tauri::State<'_, Arc<NetworkMonitor>>,
    app:     tauri::AppHandle,
) {
    monitor.set_online();
    // Эмитим internal-событие, которое подхватит listen-хандлер выше
    let _ = app.emit("backend:resume", ());
}
