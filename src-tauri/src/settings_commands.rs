// Промпт 7: команды настроек для единого экрана Settings.
//
// Хранение: таблица app_settings (key/value) в SQLite.
// Для удобства JSON-экспорт/импорт используются tauri-plugin-dialog.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::bulk_wizard::WizardDb;

fn db(db: &State<'_, WizardDb>) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.0.lock().map_err(|e| e.to_string())
}

// ───────────────── App settings ───────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub work_hours_per_day: f64,
    pub work_days: Vec<u8>,       // 1=Mon..7=Sun (ISO)
    pub timezone: String,
    /// Включить напоминания в конце рабочего дня
    pub notify_end_of_day: bool,
    /// HH:MM, например "17:30"
    pub notify_end_of_day_time: String,
    /// Включить напоминания в конце недели (пятница)
    pub notify_end_of_week: bool,
    pub notify_end_of_week_time: String,
    /// Свернуть в трей при нажатии крестика (не завершать процесс)
    pub close_to_tray: bool,
    /// Автостарт при входе в Windows
    pub autostart: bool,
    /// Страна для автоимпорта праздников
    pub holiday_country: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            work_hours_per_day: 8.0,
            work_days: vec![1, 2, 3, 4, 5],
            timezone: "Europe/Moscow".to_string(),
            notify_end_of_day: true,
            notify_end_of_day_time: "17:45".to_string(),
            notify_end_of_week: true,
            notify_end_of_week_time: "17:00".to_string(),
            close_to_tray: true,
            autostart: false,
            holiday_country: "RU".to_string(),
        }
    }
}

#[tauri::command]
pub fn get_app_settings(db: State<'_, WizardDb>) -> Result<AppSettings, String> {
    let conn = db(db)?;
    let mut map: HashMap<String, String> = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT key, value FROM app_settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        map.insert(k, v);
    }

    let def = AppSettings::default();
    Ok(AppSettings {
        work_hours_per_day: map.get("work_hours_per_day")
            .and_then(|v| v.parse().ok()).unwrap_or(def.work_hours_per_day),
        work_days: map.get("work_days")
            .and_then(|v| serde_json::from_str(v).ok()).unwrap_or(def.work_days),
        timezone: map.get("timezone").cloned().unwrap_or(def.timezone),
        notify_end_of_day: map.get("notify_end_of_day")
            .map(|v| v == "true").unwrap_or(def.notify_end_of_day),
        notify_end_of_day_time: map.get("notify_end_of_day_time")
            .cloned().unwrap_or(def.notify_end_of_day_time),
        notify_end_of_week: map.get("notify_end_of_week")
            .map(|v| v == "true").unwrap_or(def.notify_end_of_week),
        notify_end_of_week_time: map.get("notify_end_of_week_time")
            .cloned().unwrap_or(def.notify_end_of_week_time),
        close_to_tray: map.get("close_to_tray")
            .map(|v| v == "true").unwrap_or(def.close_to_tray),
        autostart: map.get("autostart")
            .map(|v| v == "true").unwrap_or(def.autostart),
        holiday_country: map.get("holiday_country")
            .cloned().unwrap_or(def.holiday_country),
    })
}

#[tauri::command]
pub fn set_app_settings(
    app: AppHandle,
    db: State<'_, WizardDb>,
    settings: AppSettings,
) -> Result<(), String> {
    let conn = db(db)?;
    let pairs: Vec<(&str, String)> = vec![
        ("work_hours_per_day", settings.work_hours_per_day.to_string()),
        ("work_days", serde_json::to_string(&settings.work_days).unwrap_or_default()),
        ("timezone", settings.timezone.clone()),
        ("notify_end_of_day", settings.notify_end_of_day.to_string()),
        ("notify_end_of_day_time", settings.notify_end_of_day_time.clone()),
        ("notify_end_of_week", settings.notify_end_of_week.to_string()),
        ("notify_end_of_week_time", settings.notify_end_of_week_time.clone()),
        ("close_to_tray", settings.close_to_tray.to_string()),
        ("autostart", settings.autostart.to_string()),
        ("holiday_country", settings.holiday_country.clone()),
    ];
    for (k, v) in pairs {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![k, v],
        ).map_err(|e| e.to_string())?;
    }

    // Автостарт: переключаем через tauri-plugin-autostart
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let mgr = app.autolaunch();
        if settings.autostart {
            let _ = mgr.enable();
        } else {
            let _ = mgr.disable();
        }
    }

    // Сигнализируем планировщик и фронтенд об изменении
    let _ = app.emit("settings:changed", &settings);
    Ok(())
}

// ───────────────── Open data folder ────────────────────────────────────────

#[tauri::command]
pub fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // Windows: explorer.exe; macOS: open; Linux: xdg-open
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ───────────────── Export / Import settings JSON ───────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct SettingsExport {
    pub version: u32,
    pub app: AppSettings,
    pub description_templates: Vec<DescriptionTemplate>,
    pub meeting_rules: Vec<crate::meeting_rules::MeetingMatchRule>,
    pub custom_holidays: Vec<String>,
}

#[tauri::command]
pub async fn export_settings_dialog(app: AppHandle, db: State<'_, WizardDb>) -> Result<bool, String> {
    let payload = build_export(&app, &db)?;
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;

    let path = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name("jiratime-settings.json")
        .blocking_save_file();

    match path {
        Some(p) => {
            std::fs::write(p.as_path().unwrap(), json.as_bytes()).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn import_settings_dialog(app: AppHandle, db: State<'_, WizardDb>) -> Result<bool, String> {
    let path = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();

    match path {
        Some(p) => {
            let content = std::fs::read_to_string(p.as_path().unwrap()).map_err(|e| e.to_string())?;
            let payload: SettingsExport = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            apply_import(&app, &db, payload)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

fn build_export(app: &AppHandle, db: &State<'_, WizardDb>) -> Result<SettingsExport, String> {
    // get_app_settings и другие команды вызываются внутренно
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let app_s = get_settings_from_conn(&conn)?;
    let templates = list_templates_from_conn(&conn)?;
    let rules = list_rules_from_conn(&conn)?;
    let holidays = list_holidays_from_conn(&conn)?;
    let _ = app;
    Ok(SettingsExport { version: 1, app: app_s, description_templates: templates, meeting_rules: rules, custom_holidays: holidays })
}

fn apply_import(app: &AppHandle, db: &State<'_, WizardDb>, payload: SettingsExport) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    save_settings_to_conn(&conn, &payload.app)?;
    // templates
    conn.execute("DELETE FROM description_templates", []).map_err(|e| e.to_string())?;
    for t in &payload.description_templates {
        conn.execute(
            "INSERT INTO description_templates (name, body, use_count) VALUES (?1, ?2, ?3)",
            params![t.name, t.body, t.use_count],
        ).map_err(|e| e.to_string())?;
    }
    // rules
    conn.execute("DELETE FROM meeting_match_rules", []).map_err(|e| e.to_string())?;
    for r in &payload.meeting_rules {
        conn.execute(
            "INSERT INTO meeting_match_rules (name,kind,pattern,issue_key,priority,is_active) VALUES (?1,?2,?3,?4,?5,?6)",
            params![r.name, r.kind, r.pattern, r.issue_key, r.priority, r.is_active as i64],
        ).map_err(|e| e.to_string())?;
    }
    // holidays
    conn.execute("DELETE FROM custom_holidays", []).map_err(|e| e.to_string())?;
    for d in &payload.custom_holidays {
        conn.execute("INSERT OR IGNORE INTO custom_holidays (date) VALUES (?1)", params![d]).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("settings:changed", ());
    Ok(())
}

fn get_settings_from_conn(conn: &Connection) -> Result<AppSettings, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let mut stmt = conn.prepare("SELECT key, value FROM app_settings").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    for row in rows { let (k, v) = row.map_err(|e| e.to_string())?; map.insert(k, v); }
    let def = AppSettings::default();
    Ok(AppSettings {
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
}

fn save_settings_to_conn(conn: &Connection, s: &AppSettings) -> Result<(), String> {
    let pairs: Vec<(&str, String)> = vec![
        ("work_hours_per_day", s.work_hours_per_day.to_string()),
        ("work_days", serde_json::to_string(&s.work_days).unwrap_or_default()),
        ("timezone", s.timezone.clone()),
        ("notify_end_of_day", s.notify_end_of_day.to_string()),
        ("notify_end_of_day_time", s.notify_end_of_day_time.clone()),
        ("notify_end_of_week", s.notify_end_of_week.to_string()),
        ("notify_end_of_week_time", s.notify_end_of_week_time.clone()),
        ("close_to_tray", s.close_to_tray.to_string()),
        ("autostart", s.autostart.to_string()),
        ("holiday_country", s.holiday_country.clone()),
    ];
    for (k, v) in pairs {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![k, v],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn list_templates_from_conn(conn: &Connection) -> Result<Vec<DescriptionTemplate>, String> {
    let mut stmt = conn.prepare("SELECT id, name, body, use_count FROM description_templates ORDER BY use_count DESC, id ASC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(DescriptionTemplate { id: Some(row.get(0)?), name: row.get(1)?, body: row.get(2)?, use_count: row.get(3)? })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn list_rules_from_conn(conn: &Connection) -> Result<Vec<crate::meeting_rules::MeetingMatchRule>, String> {
    let mut stmt = conn.prepare("SELECT id, name, kind, pattern, issue_key, priority, is_active FROM meeting_match_rules ORDER BY priority DESC, id ASC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(crate::meeting_rules::MeetingMatchRule {
        id: Some(row.get(0)?), name: row.get(1)?, kind: row.get(2)?, pattern: row.get(3)?,
        issue_key: row.get(4)?, priority: row.get(5)?, is_active: row.get::<_, i64>(6)? != 0,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn list_holidays_from_conn(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare("SELECT date FROM custom_holidays ORDER BY date").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ───────────────── Description templates ─────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DescriptionTemplate {
    pub id: Option<i64>,
    pub name: String,
    /// Текст шаблона с переменными: {date}, {issue}, {week_number}, {meeting_title}
    pub body: String,
    pub use_count: i64,
}

#[tauri::command]
pub fn list_description_templates(db: State<'_, WizardDb>) -> Result<Vec<DescriptionTemplate>, String> {
    let conn = db(db)?;
    list_templates_from_conn(&conn)
}

#[tauri::command]
pub fn save_description_template(db: State<'_, WizardDb>, template: DescriptionTemplate) -> Result<i64, String> {
    let conn = db(db)?;
    if let Some(id) = template.id {
        conn.execute(
            "UPDATE description_templates SET name=?1, body=?2 WHERE id=?3",
            params![template.name, template.body, id],
        ).map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO description_templates (name, body, use_count) VALUES (?1, ?2, 0)",
            params![template.name, template.body],
        ).map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }
}

#[tauri::command]
pub fn delete_description_template(db: State<'_, WizardDb>, id: i64) -> Result<(), String> {
    let conn = db(db)?;
    conn.execute("DELETE FROM description_templates WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Увеличивает счётчик использования шаблона (для сортировки по частоте)
#[tauri::command]
pub fn use_description_template(db: State<'_, WizardDb>, id: i64) -> Result<String, String> {
    let conn = db(db)?;
    conn.execute(
        "UPDATE description_templates SET use_count = use_count + 1 WHERE id = ?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    let body: String = conn
        .query_row("SELECT body FROM description_templates WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(body)
}

/// Заменяет переменные в шаблоне.
/// Переменные: {date}, {issue}, {week_number}, {meeting_title}
#[tauri::command]
pub fn render_description_template(
    body: String,
    date: Option<String>,
    issue: Option<String>,
    meeting_title: Option<String>,
) -> String {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let week = chrono::Local::now().iso_week().week().to_string();
    body.replace("{date}", &date.unwrap_or_else(|| today.clone()))
        .replace("{issue}", &issue.unwrap_or_default())
        .replace("{week_number}", &week)
        .replace("{meeting_title}", &meeting_title.unwrap_or_default())
}

// ───────────────── Favorite issues (reuses recent_issues) ────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FavoriteIssue {
    pub issue_key: String,
    pub summary: Option<String>,
    pub last_used_at: String,
}

#[tauri::command]
pub fn list_favorite_issues(db: State<'_, WizardDb>) -> Result<Vec<FavoriteIssue>, String> {
    let conn = db(db)?;
    let mut stmt = conn
        .prepare("SELECT issue_key, summary, last_used_at FROM recent_issues WHERE is_favorite = 1 ORDER BY last_used_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(FavoriteIssue {
        issue_key: row.get(0)?,
        summary: row.get(1)?,
        last_used_at: row.get(2)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
