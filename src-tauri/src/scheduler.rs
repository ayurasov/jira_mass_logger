//! Фоновый планировщик.
//!
//! Функции:
//!   1. `start`  — запускает фоновый tokio-цикл, который каждые N минут:
//!      - проверяет, надо ли отправить напоминание (если включено);
//!      - если включена автосинхронизация, шлёт событие `sync_tick` во Vue.
//!   2. Tauri-команды `get_scheduler_settings`, `save_scheduler_settings`.
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
    pub auto_sync_enabled: bool,
    pub sync_interval_minutes: i64,
    pub reminder_enabled: bool,
    pub reminder_time: String,
    pub reminder_workdays_only: bool,
    pub daily_hours_norm: f64,
}

impl Default for SchedulerSettings {
    fn default() -> Self {
        Self {
            auto_sync_enabled: true,
            sync_interval_minutes: 15,
            // Напоминание включается пользователем в «Настройках».
            reminder_enabled: false,
            reminder_time: "17:30".into(),
            reminder_workdays_only: true,
            daily_hours_norm: 8.0,
        }
    }
}

pub struct SchedulerState(pub Arc<Mutex<SchedulerInner>>);

pub struct SchedulerInner {
    pub settings: SchedulerSettings,
    /// Дата (YYYY-MM-DD), за которую напоминание уже обработано.
    pub last_reminder_date: String,
    pub last_sync_ts: i64,
}

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
                reminder_enabled:       row.get::<_, i64>(2).map(|v| v != 0).unwrap_or(false),
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
fn now_ts() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.splitn(2, ':');
    let h: u32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    Some((h, m))
}

/// Пора ли напоминать: включено, сегодня (по желанию) рабочий день, время уже
/// наступило и сегодня напоминание ещё не отправлялось. Раньше требовалось точное
/// совпадение минуты — при дрейфе 60-секундного цикла минута могла пропуститься.
fn should_remind(settings: &SchedulerSettings, last_sent_date: &str, now: chrono::NaiveDateTime) -> bool {
    use chrono::{Datelike, Timelike, Weekday};
    if !settings.reminder_enabled {
        return false;
    }
    let Some((rh, rm)) = parse_hhmm(&settings.reminder_time) else {
        return false;
    };
    if settings.reminder_workdays_only && matches!(now.weekday(), Weekday::Sat | Weekday::Sun) {
        return false;
    }
    let today = now.format("%Y-%m-%d").to_string();
    (now.hour(), now.minute()) >= (rh, rm) && last_sent_date != today
}

/// Сколько часов уже залогировано сегодня по локальному кэшу worklog.
fn logged_hours_today(db: &WizardDb, today: &str) -> f64 {
    let Ok(conn) = db.0.lock() else { return 0.0 };
    let total_seconds: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(time_spent_seconds), 0) FROM cached_worklogs
             WHERE substr(started, 1, 10) = ?1",
            params![today],
            |r| r.get(0),
        )
        .unwrap_or(0);
    total_seconds as f64 / 3600.0
}

pub async fn scheduler_loop(app: AppHandle) {
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

        let settings = load_settings_from_db(&db);
        let (last_reminder_date, last_sync_ts) = {
            let inner = sched_state.0.lock().unwrap();
            (inner.last_reminder_date.clone(), inner.last_sync_ts)
        };

        let now = chrono::Local::now().naive_local();
        if should_remind(&settings, &last_reminder_date, now) {
            let today = now.format("%Y-%m-%d").to_string();
            let logged = logged_hours_today(&db, &today);
            if logged + 0.01 < settings.daily_hours_norm {
                use tauri_plugin_notification::NotificationExt;
                let left = settings.daily_hours_norm - logged;
                let _ = app
                    .notification()
                    .builder()
                    .title("JiraTime: не забудьте списать время")
                    .body(format!(
                        "Сегодня залогировано {:.1} ч из {:.1} ч — осталось {:.1} ч.",
                        logged, settings.daily_hours_norm, left
                    ))
                    .show();
            }
            // Помечаем день обработанным, даже если норма выполнена — не проверяем повторно.
            sched_state.0.lock().unwrap().last_reminder_date = today;
        }

        if settings.auto_sync_enabled {
            let interval_secs = settings.sync_interval_minutes * 60;
            if now_ts() - last_sync_ts >= interval_secs {
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
    sched.0.lock().map_err(|e| e.to_string())?.settings = settings;
    Ok(())
}

#[tauri::command]
pub fn trigger_sync_now(app: AppHandle, sched: State<'_, SchedulerState>) -> Result<(), String> {
    app.emit("sync_tick", serde_json::json!({ "ts": now_ts(), "manual": true }))
        .map_err(|e| e.to_string())?;
    sched.0.lock().map_err(|e| e.to_string())?.last_sync_ts = now_ts();
    Ok(())
}

/// Инициализация: вызывается из `main.rs` setup().
pub fn init_scheduler(app: &AppHandle, db: &WizardDb) -> SchedulerState {
    let settings = load_settings_from_db(db);
    let state = SchedulerState(Arc::new(Mutex::new(SchedulerInner {
        settings,
        last_reminder_date: String::new(),
        last_sync_ts: 0,
    })));
    let app_handle = app.clone();
    tauri::async_runtime::spawn(scheduler_loop(app_handle));
    state
}

/// Удобный публичный helper — оставлен для обратной совместимости.
pub fn start(app: AppHandle) {
    let db = app
        .state::<WizardDb>();
    let state = init_scheduler(&app, &db);
    app.manage(state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(d: (i32, u32, u32), h: u32, m: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(d.0, d.1, d.2).unwrap().and_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn remind_once_after_time_on_workdays() {
        let s = SchedulerSettings { reminder_enabled: true, ..SchedulerSettings::default() };
        // 2026-10-23 — пятница
        assert!(!should_remind(&s, "", at((2026, 10, 23), 17, 29)));
        assert!(should_remind(&s, "", at((2026, 10, 23), 17, 31)), "пропущенная минута не теряет напоминание");
        assert!(!should_remind(&s, "2026-10-23", at((2026, 10, 23), 18, 0)), "второй раз за день не напоминаем");
        assert!(!should_remind(&s, "", at((2026, 10, 24), 18, 0)), "суббота");
        let off = SchedulerSettings::default();
        assert!(!should_remind(&off, "", at((2026, 10, 23), 18, 0)), "по умолчанию выключено");
    }
}
