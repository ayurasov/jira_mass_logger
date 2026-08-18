//! Фоновый планировщик.
//!
//! Функции:
//!   1. `start_scheduler`  — запускает фоновый tokio-цикл, который каждые N минут:
//!      - проверяет, надо ли отправить напоминание (если включено);
//!      - если включена автосинхронизация, шлёт событие `sync_tick` во Vue.
//!   2. Tauri-команды `get_scheduler_settings`, `save_scheduler_settings` —
//!      CRUD настроек в SQLite.
//!   3. Tauri-команда `trigger_sync_now` — принудительный тиксинхронизации.

use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::sleep;

use crate::bulk_wizard::WizardDb;

// ─────────────────────────────────────────────────────────────────
// Типы данных
// ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerSettings {
    /// Автосинхронизация включена
    pub auto_sync_enabled: bool,
    /// Интервал автосинхронизации в минутах
    pub sync_interval_minutes: i64,
    /// Напоминания о незаполненном worklog включены
    pub reminder_enabled: bool,
    /// Время напоминания в формате "HH:MM" (24ч)
    pub reminder_time: String,
    /// Напоминать только в рабочие дни (Пн–Пт)
    pub reminder_workdays_only: bool,
    /// Норма часов в день (для вычисления недостачности)
    pub daily_hours_norm: f64,
}

impl Default for SchedulerSettings {
    fn default() -> Self {
        Self {
            auto_sync_enabled: true,
            sync_interval_minutes: 15,
            reminder_enabled: true,
            reminder_time: "17:30".into(),
            reminder_workdays_only: true,
            daily_hours_norm: 8.0,
        }
    }
}

/// Состояние планировщика, доступное через `State`
pub struct SchedulerState(pub Arc<Mutex<SchedulerInner>>);

pub struct SchedulerInner {
    pub settings: SchedulerSettings,
    /// Последнее время отправки напоминания (Unix timestamp сек)
    pub last_reminder_sent_ts: i64,
    /// Последнее время автосинхронизации (Unix timestamp сек)
    pub last_sync_ts: i64,
}

// ─────────────────────────────────────────────────────────────────
// SQLite CRUD
// ─────────────────────────────────────────────────────────────────

fn load_settings_from_db(db: &WizardDb) -> SchedulerSettings {
    let Ok(conn) = db.0.lock() else { return SchedulerSettings::default() };
    conn.query_row(
        "SELECT auto_sync_enabled, sync_interval_minutes, reminder_enabled,
                reminder_time, reminder_workdays_only, daily_hours_norm
         FROM scheduler_settings WHERE id = 1",
        [],
        |row| {
            Ok(SchedulerSettings {
                auto_sync_enabled:      row.get::<_, i64>(0).map(|v| v != 0).unwrap_or(true),
                sync_interval_minutes:  row.get(1).unwrap_or(15),
                reminder_enabled:       row.get::<_, i64>(2).map(|v| v != 0).unwrap_or(true),
                reminder_time:          row.get(3).unwrap_or_else(|_| "17:30".into()),
                reminder_workdays_only: row.get::<_, i64>(4).map(|v| v != 0).unwrap_or(true),
                daily_hours_norm:       row.get(5).unwrap_or(8.0),
            })
        },
    )
    .unwrap_or_default()
}

fn persist_settings(db: &WizardDb, s: &SchedulerSettings) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO scheduler_settings
           (id, auto_sync_enabled, sync_interval_minutes, reminder_enabled,
            reminder_time, reminder_workdays_only, daily_hours_norm)
         VALUES (1,?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET
           auto_sync_enabled      = excluded.auto_sync_enabled,
           sync_interval_minutes  = excluded.sync_interval_minutes,
           reminder_enabled       = excluded.reminder_enabled,
           reminder_time          = excluded.reminder_time,
           reminder_workdays_only = excluded.reminder_workdays_only,
           daily_hours_norm       = excluded.daily_hours_norm",
        params![
            s.auto_sync_enabled as i64,
            s.sync_interval_minutes,
            s.reminder_enabled as i64,
            s.reminder_time,
            s.reminder_workdays_only as i64,
            s.daily_hours_norm,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────
// Фоновый цикл
// ─────────────────────────────────────────────────────────────────

fn now_ts() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Возвращает (hour, minute) от строки формата "HH:MM"
fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.splitn(2, ':');
    let h: u32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    Some((h, m))
}

/// Проверяет, настало ли время напоминания (с точностью до 1 минуты).
fn should_remind(settings: &SchedulerSettings, last_sent_ts: i64) -> bool {
    if !settings.reminder_enabled {
        return false;
    }
    let Some((rh, rm)) = parse_hhmm(&settings.reminder_time) else {
        return false;
    };

    use chrono::{Datelike, Local, Timelike, Weekday};
    let now = Local::now();
    if settings.reminder_workdays_only {
        match now.weekday() {
            Weekday::Sat | Weekday::Sun => return false,
            _ => {}
        }
    }

    let target_h = rh;
    let target_m = rm;
    let cur_h = now.hour();
    let cur_m = now.minute();

    // Попадаем в окно ± 1 минута
    let matches = cur_h == target_h && cur_m == target_m;
    if !matches {
        return false;
    }

    // Не слать напоминание дважды в одну минуту
    let ts_now = now_ts();
    ts_now - last_sent_ts > 60
}

/// Проверяет по SQLite, есть ли незаполненные часы сегодня
fn has_unfilled_hours(db: &WizardDb, norm_hours: f64) -> bool {
    let Ok(conn) = db.0.lock() else { return false };
    use chrono::Local;
    let today = Local::now().format("%Y-%m-%d").to_string();
    // Сумма всех worklog-записей на сегодня из кэша
    let total_seconds: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(time_spent_seconds), 0)
             FROM worklog_cache
             WHERE date(started_at) = ?1 AND deleted = 0",
            params![today],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let total_hours = total_seconds as f64 / 3600.0;
    total_hours < norm_hours
}

/// Главный фоновый цикл. Запускается один раз из `setup` Tauri через `tauri::async_runtime::spawn`.
pub async fn scheduler_loop(app: AppHandle) {
    // Опросной цикл каждую минуту
    let tick_duration = Duration::from_secs(60);

    loop {
        sleep(tick_duration).await;

        let db = match app.try_state::<WizardDb>() {
            Some(s) => s,
            None => continue,
        };
        let sched_state = match app.try_state::<SchedulerState>() {
            Some(s) => s,
            None => continue,
        };

        // Читаем актуальные настройки из DB (учитывает реалтайм-изменения в UI)
        let settings = load_settings_from_db(&db);

        // ── Ремайндер ──────────────────────────────────────────
        let (last_reminder_ts, last_sync_ts) = {
            let inner = sched_state.0.lock().unwrap();
            (inner.last_reminder_sent_ts, inner.last_sync_ts)
        };

        if should_remind(&settings, last_reminder_ts)
            && has_unfilled_hours(&db, settings.daily_hours_norm)
        {
            let norm = settings.daily_hours_norm;
            let _ = app.emit(
                "reminder",
                serde_json::json!({
                    "title": "Не забудь зафиксировать время!",
                    "body":  format!("Сегодня ещё не залогировано {norm} часов."),
                }),
            );
            sched_state.0.lock().unwrap().last_reminder_sent_ts = now_ts();
        }

        // ── Автосинхронизация ────────────────────────────────
        if settings.auto_sync_enabled {
            let interval_secs = settings.sync_interval_minutes * 60;
            let elapsed = now_ts() - last_sync_ts;
            if elapsed >= interval_secs {
                // Шлём событие во Vue — фронтенд выполняет реальную синхронизацию
                let _ = app.emit("sync_tick", serde_json::json!({ "ts": now_ts() }));
                sched_state.0.lock().unwrap().last_sync_ts = now_ts();
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_scheduler_settings(db: State<'_, WizardDb>) -> SchedulerSettings {
    load_settings_from_db(&db)
}

#[tauri::command]
pub fn save_scheduler_settings(
    db: State<'_, WizardDb>,
    sched: State<'_, SchedulerState>,
    settings: SchedulerSettings,
) -> Result<(), String> {
    persist_settings(&db, &settings)?;
    // Обновляем в памяти
    sched.0.lock().map_err(|e| e.to_string())?.settings = settings;
    Ok(())
}

#[tauri::command]
pub fn trigger_sync_now(app: AppHandle, sched: State<'_, SchedulerState>) -> Result<(), String> {
    app.emit("sync_tick", serde_json::json!({ "ts": now_ts(), "manual": true }))
        .map_err(|e| e.to_string())?;
    sched
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .last_sync_ts = now_ts();
    Ok(())
}

/// Инициализация: вызывается из `main.rs` перед `tauri::Builder::build()`.
pub fn init_scheduler(app: &AppHandle, db: &WizardDb) -> SchedulerState {
    let settings = load_settings_from_db(db);
    let state = SchedulerState(Arc::new(Mutex::new(SchedulerInner {
        settings,
        last_reminder_sent_ts: 0,
        last_sync_ts: 0,
    })));
    // Запускаем цикл в фоновом tokio-runtime Tauri
    let app_handle = app.clone();
    tauri::async_runtime::spawn(scheduler_loop(app_handle));
    state
}
