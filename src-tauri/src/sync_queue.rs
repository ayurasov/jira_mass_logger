// Очередь несинхронизированных изменений и локальный кэш worklog для экрана
// "Мой worklog". Когда update/delete/create не удались отправить в Jira (нет
// сети, ноутбук ушёл в сон, Jira недоступна), фронтенд кладёт операцию в
// `sync_queue`, применяет optimistic UI локально и повторяет отправку позже —
// в том числе по событию "пробуждение системы" (resume-from-suspend на Windows).
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

use crate::bulk_wizard::WizardDb;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncQueueItem {
    pub id: i64,
    pub row_key: String,
    pub operation: String,
    pub payload_json: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CachedWorklogRow {
    pub row_key: String,
    pub worklog_id: Option<String>,
    pub issue_key: String,
    pub issue_summary: Option<String>,
    pub project_key: Option<String>,
    pub started: String,
    pub time_spent_seconds: i64,
    pub comment: Option<String>,
    pub updated: Option<String>,
    pub synced_at: Option<String>,
}

fn lock(db: &State<'_, WizardDb>) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.0.lock().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn enqueue_sync_operation(
    db: State<'_, WizardDb>,
    row_key: String,
    operation: String,
    payload_json: String,
) -> Result<i64, String> {
    let conn = lock(&db)?;
    conn.execute(
        "INSERT INTO sync_queue (row_key, operation, payload_json) VALUES (?1, ?2, ?3)",
        params![row_key, operation, payload_json],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn list_sync_queue(db: State<'_, WizardDb>) -> Result<Vec<SyncQueueItem>, String> {
    let conn = lock(&db)?;
    let mut stmt = conn
        .prepare("SELECT id, row_key, operation, payload_json, attempts, last_error, created_at, updated_at FROM sync_queue ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SyncQueueItem {
                id: row.get(0)?,
                row_key: row.get(1)?,
                operation: row.get(2)?,
                payload_json: row.get(3)?,
                attempts: row.get(4)?,
                last_error: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_sync_attempt_failed(db: State<'_, WizardDb>, id: i64, error: String) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute(
        "UPDATE sync_queue SET attempts = attempts + 1, last_error = ?2, updated_at = datetime('now') WHERE id = ?1",
        params![id, error],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_sync_queue_item(db: State<'_, WizardDb>, id: i64) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute("DELETE FROM sync_queue WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_sync_queue(db: State<'_, WizardDb>) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute("DELETE FROM sync_queue", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn upsert_cached_worklog(db: State<'_, WizardDb>, row: CachedWorklogRow) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute(
        "INSERT INTO worklog_cache (row_key, worklog_id, issue_key, issue_summary, project_key, started, time_spent_seconds, comment, updated, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
         ON CONFLICT(row_key) DO UPDATE SET
            worklog_id = excluded.worklog_id,
            issue_key = excluded.issue_key,
            issue_summary = excluded.issue_summary,
            project_key = excluded.project_key,
            started = excluded.started,
            time_spent_seconds = excluded.time_spent_seconds,
            comment = excluded.comment,
            updated = excluded.updated,
            synced_at = datetime('now')",
        params![
            row.row_key,
            row.worklog_id,
            row.issue_key,
            row.issue_summary,
            row.project_key,
            row.started,
            row.time_spent_seconds,
            row.comment,
            row.updated,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_cached_worklog(db: State<'_, WizardDb>, row_key: String) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute("DELETE FROM worklog_cache WHERE row_key = ?1", params![row_key]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_cached_worklogs(
    db: State<'_, WizardDb>,
    from_date: String,
    to_date: String,
) -> Result<Vec<CachedWorklogRow>, String> {
    let conn = lock(&db)?;
    let mut stmt = conn
        .prepare(
            "SELECT row_key, worklog_id, issue_key, issue_summary, project_key, started, time_spent_seconds, comment, updated, synced_at
             FROM worklog_cache WHERE substr(started, 1, 10) BETWEEN ?1 AND ?2 ORDER BY started ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from_date, to_date], |row| {
            Ok(CachedWorklogRow {
                row_key: row.get(0)?,
                worklog_id: row.get(1)?,
                issue_key: row.get(2)?,
                issue_summary: row.get(3)?,
                project_key: row.get(4)?,
                started: row.get(5)?,
                time_spent_seconds: row.get(6)?,
                comment: row.get(7)?,
                updated: row.get(8)?,
                synced_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[allow(dead_code)]
fn _unused_mutex_type_hint(_: &Mutex<Connection>) {}
