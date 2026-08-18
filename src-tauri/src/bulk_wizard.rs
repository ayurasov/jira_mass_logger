// Хранилище шаблонов "Массовой фиксации времени" (Bulk Log Wizard) и
// вспомогательные команды: экспорт лога операции на диск, статический
// fallback-список праздников РФ (если пользователь не импортировал свой
// производственный календарь).
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub struct WizardDb(pub Arc<Mutex<Connection>>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WizardTemplate {
    pub id: Option<i64>,
    pub name: String,
    pub config_json: String,
    pub created_at: Option<String>,
}

// ────────────────────────────────────────────────────────────────
// Шаблоны мастера
// ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_wizard_template(db: State<'_, WizardDb>, name: String, config_json: String) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO wizard_templates (name, config_json) VALUES (?1, ?2)
         ON CONFLICT(name) DO UPDATE SET config_json = excluded.config_json, created_at = CURRENT_TIMESTAMP",
        params![name, config_json],
    ).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn list_wizard_templates(db: State<'_, WizardDb>) -> Result<Vec<WizardTemplate>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, name, config_json, created_at FROM wizard_templates ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(WizardTemplate {
        id: row.get(0)?,
        name: row.get(1)?,
        config_json: row.get(2)?,
        created_at: row.get(3)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_wizard_template(db: State<'_, WizardDb>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM wizard_templates WHERE id = ?1", params![id])
        .map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn touch_recent_issue(db: State<'_, WizardDb>, issue_key: String, summary: Option<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO recent_issues (issue_key, summary) VALUES (?1, ?2)
         ON CONFLICT(issue_key) DO UPDATE SET last_used_at = CURRENT_TIMESTAMP, summary = COALESCE(?2, summary)",
        params![issue_key, summary],
    ).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_issue_favorite(db: State<'_, WizardDb>, issue_key: String, is_favorite: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE recent_issues SET is_favorite = ?1 WHERE issue_key = ?2",
        params![is_favorite as i64, issue_key],
    ).map(|_| ()).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecentIssue { pub issue_key: String, pub summary: Option<String>, pub is_favorite: bool, pub last_used_at: String }

#[tauri::command]
pub fn get_recent_issues(db: State<'_, WizardDb>) -> Result<Vec<RecentIssue>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT issue_key, summary, is_favorite, last_used_at FROM recent_issues ORDER BY is_favorite DESC, last_used_at DESC LIMIT 50"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(RecentIssue {
        issue_key: row.get(0)?,
        summary: row.get(1)?,
        is_favorite: row.get::<_, i64>(2)? != 0,
        last_used_at: row.get(3)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ────────────────────────────────────────────────────────────────
// Экспорт лога (JSON) на диск
// ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn export_wizard_log(path: String, entries: Vec<Value>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ────────────────────────────────────────────────────────────────
// Статический список праздников РФ (fallback)
// ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_ru_holidays() -> Vec<String> {
    vec![
        // 2024
        "2024-01-01","2024-01-02","2024-01-03","2024-01-04","2024-01-05",
        "2024-01-06","2024-01-07","2024-01-08","2024-02-23","2024-03-08",
        "2024-04-29","2024-04-30","2024-05-01","2024-05-09","2024-05-10",
        "2024-06-12","2024-11-04",
        // 2025
        "2025-01-01","2025-01-02","2025-01-03","2025-01-06","2025-01-07",
        "2025-01-08","2025-02-24","2025-03-10","2025-04-30","2025-05-01",
        "2025-05-02","2025-05-08","2025-05-09","2025-06-12","2025-06-13",
        "2025-11-03","2025-11-04","2025-12-31",
        // 2026
        "2026-01-01","2026-01-02","2026-01-07","2026-01-08","2026-01-09",
        "2026-02-23","2026-03-09","2026-05-01","2026-05-04","2026-05-08",
        "2026-05-11","2026-06-12","2026-11-04",
    ].into_iter().map(String::from).collect()
}


// ────────────────────────────────────────────────────────────────
// Пользовательские праздники (custom holidays, хранятся в SQLite)
// ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_custom_holidays(db: State<'_, WizardDb>) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Таблица создаётся лениво при первом вызове import_holidays
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='custom_holidays'",
        [],
        |row| row.get::<_, i64>(0),
    ).map(|n| n > 0).unwrap_or(false);
    if !exists { return Ok(vec![]); }
    let mut stmt = conn.prepare("SELECT date FROM custom_holidays ORDER BY date")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_holidays(db: State<'_, WizardDb>, dates: Vec<String>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS custom_holidays (
            date TEXT PRIMARY KEY
        );"
    ).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM custom_holidays", []).map_err(|e| e.to_string())?;
    let mut count = 0usize;
    for date in &dates {
        conn.execute("INSERT OR IGNORE INTO custom_holidays (date) VALUES (?1)", params![date])
            .map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}

// ────────────────────────────────────────────────────────────────
// Запись файлов (экспорт CSV/XLSX с учётом кодировки)
// ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn write_export_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_export_file_utf8_bom(path: String, content: String) -> Result<(), String> {
    // UTF-8 BOM нужен для корректного открытия CSV в Excel (Windows)
    let bom: &[u8] = &[0xEF, 0xBB, 0xBF];
    let mut bytes = bom.to_vec();
    bytes.extend_from_slice(content.as_bytes());
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

// ────────────────────────────────────────────────────────────────
// Setup: открыть / создать SQLite, применить схему, зарегистрировать
// ────────────────────────────────────────────────────────────────

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_data_dir)?;
    let db_path = app_data_dir.join("jiratime.db");
    let conn = Connection::open(&db_path)?;
    conn.execute_batch("
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS wizard_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            config_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS recent_issues (
            issue_key TEXT PRIMARY KEY,
            summary TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    ")?;
    app.manage(WizardDb(Arc::new(Mutex::new(conn))));
    Ok(())
}
