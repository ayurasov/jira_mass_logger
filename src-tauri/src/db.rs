// Инициализация локальной SQLite БД (профили, шаблоны, кэш worklog, настройки).
// На Windows БД хранится в %APPDATA%/JiraTime (не в директории установки Program Files),
// путь берётся через tauri path API (app.path().app_data_dir()), а не хардкодится.
use std::fs;
use tauri::{AppHandle, Manager};

pub fn init_db(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?; // Windows: %APPDATA%\JiraTime
    fs::create_dir_all(&app_data_dir)?;

    let db_path = app_data_dir.join("jiratime.db");
    // Единый SQLite-файл (а не множество мелких файлов) снижает риск
    // ложных срабатываний эвристик Windows Defender/корпоративного AV.
    let conn = rusqlite::Connection::open(&db_path)?;

    // Схема:
    // jira_profiles(id, name, base_url, email, type, secret_ref)
    // exchange_profiles(id, name, ews_url, username, secret_ref)
    // templates(id, issue_key, description, hours, weekdays, period_start, period_end)
    // worklog_cache(id, issue_key, started, time_spent_seconds, comment, synced_at)
    // settings(key, value)
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS jira_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            email TEXT NOT NULL,
            type TEXT NOT NULL,
            secret_ref TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS exchange_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            ews_url TEXT,
            username TEXT NOT NULL,
            secret_ref TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_key TEXT NOT NULL,
            description TEXT,
            hours REAL NOT NULL,
            weekdays TEXT NOT NULL,
            period_start TEXT,
            period_end TEXT
        );
        CREATE TABLE IF NOT EXISTS worklog_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_key TEXT NOT NULL,
            started TEXT NOT NULL,
            time_spent_seconds INTEGER NOT NULL,
            comment TEXT,
            synced_at TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );",
    )?;

    Ok(())
}
