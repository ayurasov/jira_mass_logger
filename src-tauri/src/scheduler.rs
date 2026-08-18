// Планировщик фоновых задач: напоминания о незаполненном worklog в конце дня/недели.
//
// Отправляет Toast-уведомления через tauri-plugin-notification.
// На Windows 10/11 это нативные Toast в Action Center.
//
// Логика:
//   - цикл \u043aаждые 60 секунд
//   - если текущее локальное время >= notify_end_of_day_time и ещё не зафиксировали сегодня — файр
//   - если пятница и время >= notify_end_of_week_time — файр недельное

use tauri::AppHandle;

pub fn start(app: AppHandle) {
    tokio::spawn(async move {
        run_loop(app).await;
    });
}

async fn run_loop(app: AppHandle) {
    let mut last_day_notified: Option<String> = None;
    let mut last_week_notified: Option<String> = None;

    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
        let settings = load_settings(&app);
        let now_local = chrono::Local::now();
        let today_str = now_local.format("%Y-%m-%d").to_string();
        let weekday = now_local.weekday(); // chrono::Weekday
        let current_hhmm = now_local.format("%H:%M").to_string();

        // Напоминание конец дня
        if settings.notify_end_of_day
            && current_hhmm >= settings.notify_end_of_day_time
            && last_day_notified.as_deref() != Some(&today_str)
        {
            // Проверяем, что сегодня рабочий день
            let iso_weekday = iso_weekday_num(weekday);
            if settings.work_days.contains(&iso_weekday) {
                let hours_logged = fetch_today_hours(&app, &today_str);
                if hours_logged < settings.work_hours_per_day - 0.1 {
                    send_notification(
                        &app,
                        "⏰ Не забывайте заполнить worklog!",
                        &format!(
                            "Залогировано {:.1}ч из {:.0}ч. Нажмите для быстрого заполнения.",
                            hours_logged,
                            settings.work_hours_per_day
                        ),
                        "navigate:/my-worklog",
                    );
                }
            }
            last_day_notified = Some(today_str.clone());
        }

        // Напоминание конец недели (пятница)
        if settings.notify_end_of_week
            && weekday == chrono::Weekday::Fri
            && current_hhmm >= settings.notify_end_of_week_time
            && last_week_notified.as_deref() != Some(&today_str)
        {
            let week_hours = fetch_week_hours(&app, &now_local);
            let norm = settings.work_hours_per_day * settings.work_days.len() as f64;
            if week_hours < norm - 0.1 {
                send_notification(
                    &app,
                    "🗓️ Неделя заканчивается!",
                    &format!(
                        "За неделю залогировано {:.1}ч из {:.0}ч.",
                        week_hours, norm
                    ),
                    "navigate:/my-worklog",
                );
            }
            last_week_notified = Some(today_str);
        }
    }
}

fn send_notification(app: &AppHandle, title: &str, body: &str, action_id: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .action(action_id, "Открыть")
        .show();
}

fn load_settings(app: &AppHandle) -> crate::settings_commands::AppSettings {
    use tauri::Manager;
    use crate::bulk_wizard::WizardDb;
    app.try_state::<WizardDb>()
        .and_then(|db| {
            let conn = db.0.lock().ok()?;
            let mut map = std::collections::HashMap::new();
            if let Ok(mut stmt) = conn.prepare("SELECT key, value FROM app_settings") {
                if let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
                    for row in rows.flatten() { map.insert(row.0, row.1); }
                }
            }
            let def = crate::settings_commands::AppSettings::default();
            Some(crate::settings_commands::AppSettings {
                work_hours_per_day: map.get("work_hours_per_day").and_then(|v| v.parse().ok()).unwrap_or(def.work_hours_per_day),
                work_days: map.get("work_days").and_then(|v| serde_json::from_str(v).ok()).unwrap_or(def.work_days),
                timezone: map.get("timezone").cloned().unwrap_or(def.timezone),
                notify_end_of_day: map.get("notify_end_of_day").map(|v| v == "true").unwrap_or(def.notify_end_of_day),
                notify_end_of_day_time: map.get("notify_end_of_day_time").cloned().unwrap_or(def.notify_end_of_day_time),
                notify_end_of_week: map.get("notify_end_of_week").map(|v| v == "true").unwrap_or(def.notify_end_of_week),
                notify_end_of_week_time: map.get("notify_end_of_week_time").cloned().unwrap_or(def.notify_end_of_week_time),
                close_to_tray: map.get("close_to_tray").map(|v| v == "true").unwrap_or(def.close_to_tray),
                autostart: map.get("autostart").map(|v| v == "true").unwrap_or(def.autostart),
                holiday_country: map.get("holiday_country").cloned().unwrap_or(def.holiday_country),
            })
        })
        .unwrap_or_default()
}

fn fetch_today_hours(app: &AppHandle, today: &str) -> f64 {
    use tauri::Manager;
    use crate::bulk_wizard::WizardDb;
    app.try_state::<WizardDb>()
        .and_then(|db| {
            let conn = db.0.lock().ok()?;
            let secs: i64 = conn.query_row(
                "SELECT COALESCE(SUM(time_spent_seconds), 0) FROM cached_worklogs WHERE started LIKE ?1",
                rusqlite::params![format!("{today}%")],
                |r| r.get(0),
            ).unwrap_or(0);
            Some(secs as f64 / 3600.0)
        })
        .unwrap_or(0.0)
}

fn fetch_week_hours(app: &AppHandle, now: &chrono::DateTime<chrono::Local>) -> f64 {
    use chrono::{Datelike, Duration};
    let days_since_mon = now.weekday().num_days_from_monday() as i64;
    let week_start = (*now - Duration::days(days_since_mon)).format("%Y-%m-%d").to_string();
    let week_end = now.format("%Y-%m-%d").to_string();
    use tauri::Manager;
    use crate::bulk_wizard::WizardDb;
    app.try_state::<WizardDb>()
        .and_then(|db| {
            let conn = db.0.lock().ok()?;
            let secs: i64 = conn.query_row(
                "SELECT COALESCE(SUM(time_spent_seconds), 0) FROM cached_worklogs WHERE started >= ?1 AND started <= ?2",
                rusqlite::params![format!("{week_start}T00:00:00"), format!("{week_end}T23:59:59")],
                |r| r.get(0),
            ).unwrap_or(0);
            Some(secs as f64 / 3600.0)
        })
        .unwrap_or(0.0)
}

fn iso_weekday_num(wd: chrono::Weekday) -> u8 {
    match wd {
        chrono::Weekday::Mon => 1, chrono::Weekday::Tue => 2, chrono::Weekday::Wed => 3,
        chrono::Weekday::Thu => 4, chrono::Weekday::Fri => 5, chrono::Weekday::Sat => 6, chrono::Weekday::Sun => 7,
    }
}
