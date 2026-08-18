// Хранилище шаблонов "Массовой фиксации времени" (Bulk Log Wizard) и
// вспомогательные команды: экспорт лога операции на диск, статический
// fallback-список праздников РФ (если пользователь не импортировал свой
// производственный календарь).
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct WizardDb(pub Mutex<Connection>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WizardTemplate {
    pub id: Option<i64>,
    pub name: String,
    pub config_json: String,
    pub created_at: Option<String>,
}

#[tauri::command]
pub fn save_wizard_template(db: State<'_, WizardDb>, name: String, config_json: String) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO wizard_templates (name, config_json) VALUES (?1, ?2)", params![name, config_json]).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn list_wizard_templates(db: State<'_, WizardDb>) -> Result<Vec<WizardTemplate>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, config_json, created_at FROM wizard_templates ORDER BY created_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(WizardTemplate { id: Some(row.get(0)?), name: row.get(1)?, config_json: row.get(2)?, created_at: Some(row.get(3)?), })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_wizard_template(db: State<'_, WizardDb>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM wizard_templates WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn touch_recent_issue(db: State<'_, WizardDb>, issue_key: String, summary: Option<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO recent_issues (issue_key, summary, last_used_at)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(issue_key) DO UPDATE SET summary = excluded.summary, last_used_at = excluded.last_used_at",
        params![issue_key, summary],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_issue_favorite(db: State<'_, WizardDb>, issue_key: String, is_favorite: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE recent_issues SET is_favorite = ?2 WHERE issue_key = ?1", params![issue_key, is_favorite as i64]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecentIssue { pub issue_key: String, pub summary: Option<String>, pub is_favorite: bool, pub last_used_at: String }

#[tauri::command]
pub fn get_recent_issues(db: State<'_, WizardDb>) -> Result<Vec<RecentIssue>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT issue_key, summary, is_favorite, last_used_at FROM recent_issues ORDER BY is_favorite DESC, last_used_at DESC LIMIT 50").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(RecentIssue { issue_key: row.get(0)?, summary: row.get(1)?, is_favorite: row.get::<_, i64>(2)? != 0, last_used_at: row.get(3)?, })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_custom_holidays(db: State<'_, WizardDb>) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT date FROM custom_holidays ORDER BY date").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_holidays(db: State<'_, WizardDb>, json: String) -> Result<usize, String> {
    let value: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let items = value.as_array().ok_or("expected a JSON array")?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM custom_holidays", []).map_err(|e| e.to_string())?;
    let mut count = 0usize;
    for item in items {
        let (date, label) = match item {
            Value::String(s) => (s.clone(), None),
            Value::Object(_) => {
                let date = item.get("date").and_then(|v| v.as_str()).ok_or("missing 'date' field")?.to_string();
                let label = item.get("label").and_then(|v| v.as_str()).map(|s| s.to_string());
                (date, label)
            }
            _ => continue,
        };
        tx.execute("INSERT OR REPLACE INTO custom_holidays (date, label) VALUES (?1, ?2)", params![date, label]).map_err(|e| e.to_string())?;
        count += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn write_export_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("cannot write {path}: {e}"))
}

/// Для CSV-экспорта таблицы worklog: добавляет UTF-8 BOM (EF BB BF) в начало
/// файла, чтобы Excel на Windows автоматически распознавал UTF-8 и корректно
/// отображал кириллицу без ручного выбора кодировки при импорте.
#[tauri::command]
pub fn write_export_file_utf8_bom(path: String, content: String) -> Result<(), String> {
    const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
    let mut bytes = Vec::with_capacity(BOM.len() + content.len());
    bytes.extend_from_slice(&BOM);
    bytes.extend_from_slice(content.as_bytes());
    fs::write(&path, bytes).map_err(|e| format!("cannot write {path}: {e}"))
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_data_dir)?;
    let db_path = app_data_dir.join("jiratime.db");
    let conn = Connection::open(&db_path)?;
    app.manage(WizardDb(Mutex::new(conn)));
    Ok(())
}
