//! Монитор сети и обработчик событий сна/пробуждения.
//!
//!  - Раз в минуту — лёгкий GET /serverInfo к активному Jira-профилю (параметры
//!    профиля передаёт UI через `set_monitor_connection`), плюс счётчики очереди.
//!    Результат уходит во фронтенд событием `sync-status-changed`.
//!  - Пробуждение системы: фронтенд (usePowerEvents, visibilitychange) вызывает
//!    `notify_system_resume` → событие "backend:resume" → wake-сигнал воркеру очереди.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Listener};

use crate::logger::{AppLogger, LogSink};
use crate::jira_client::JiraConnectionParams;
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
#[serde(rename_all = "camelCase")]
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
    status: Arc<Mutex<SyncIndicator>>,
    /// Параметры активного Jira-профиля — передаются из UI (set_monitor_connection).
    /// Пока профиль не задан, health-check не выполняется.
    connection: Arc<Mutex<Option<JiraConnectionParams>>>,
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
            connection: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_connection(&self, params: Option<JiraConnectionParams>) {
        *self.connection.lock().unwrap() = params;
    }

    fn connection(&self) -> Option<JiraConnectionParams> {
        self.connection.lock().unwrap().clone()
    }

    pub fn get_status(&self) -> SyncIndicator {
        self.status.lock().unwrap().clone()
    }

    pub fn set_online(&self) {
        let mut s = self.status.lock().unwrap();
        s.net_status = if s.failed_count > 0 { NetStatus::Error } else { NetStatus::Online };
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
        if failed > 0 && s.net_status == NetStatus::Online { s.net_status = NetStatus::Error; }
        if failed == 0 && s.net_status == NetStatus::Error { s.net_status = NetStatus::Online; }
    }
}

/// Счётчики очереди синхронизации для индикатора: (ожидают, исчерпали попытки, последняя ошибка).
fn queue_counts(db: &Mutex<rusqlite::Connection>) -> Option<(usize, usize, Option<String>)> {
    let conn = db.lock().ok()?;
    let (pending, failed): (i64, i64) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN status <> 'synced' AND attempts < ?1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status <> 'synced' AND attempts >= ?1 THEN 1 ELSE 0 END), 0)
             FROM sync_queue",
            rusqlite::params![crate::sync_queue::MAX_ATTEMPTS],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()?;
    let last_error: Option<String> = conn
        .query_row(
            "SELECT last_error FROM sync_queue WHERE last_error IS NOT NULL AND status <> 'synced'
             ORDER BY updated_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    Some((pending as usize, failed as usize, last_error))
}

// ──────────────────────────────────────────────────────
// Фоновый монитор: health-check активного профиля + эмит события Tauri
// ──────────────────────────────────────────────────────

/// Интервал health-check. Проверка — один лёгкий GET к Jira; процессов не порождает
/// (системный прокси читается из реестра напрямую, см. win_registry.rs).
const HEALTH_CHECK_SECS: u64 = 60;

/// Запустить периодический health-check и обработчик событий в Tauri.
pub fn start_network_monitor(
    monitor: Arc<NetworkMonitor>,
    wake:    WakeSignal,
    app:     AppHandle,
    logger:  Arc<AppLogger>,
    db:      Arc<Mutex<rusqlite::Connection>>,
) {
    let m2 = monitor.clone();
    let app2 = app.clone();
    let lg2 = logger.clone();
    let wake2 = wake.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Some(params) = m2.connection() {
                if crate::jira_client::ping(&params).await {
                    m2.set_online();
                    lg2.debug("network_monitor", "Jira reachable");
                    wake2.notify_one();
                } else {
                    m2.set_offline();
                    lg2.debug("network_monitor", "Jira unreachable");
                }
            }
            if let Some((pending, failed, last_err)) = queue_counts(&db) {
                m2.update_queue_counts(pending, failed, last_err);
            }
            let _ = app2.emit("sync-status-changed", m2.get_status());
            tokio::time::sleep(tokio::time::Duration::from_secs(HEALTH_CHECK_SECS)).await;
        }
    });

    // Пробуждение системы: фронтенд (usePowerEvents) вызывает notify_system_resume,
    // та эмитит "backend:resume" — будим воркер очереди.
    let m3 = monitor.clone();
    let lg3 = logger.clone();
    let wake3 = wake.clone();
    app.listen("backend:resume", move |_event| {
        lg3.info("network_monitor", "system resume event received");
        m3.set_online();
        wake3.notify_one();
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

/// UI сообщает параметры активного Jira-профиля для health-check индикатора сети.
#[tauri::command]
pub fn set_monitor_connection(
    monitor: tauri::State<'_, Arc<NetworkMonitor>>,
    params:  Option<JiraConnectionParams>,
) {
    monitor.set_connection(params);
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
