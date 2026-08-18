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

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS jira_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            email TEXT NOT NULL,
            type TEXT NOT NULL,
            secret_ref TEXT NOT NULL
        );
        -- Интеграция с календарём: 'graph' (Microsoft Graph, OAuth2 PKCE) или
        -- 'ews' (Exchange Web Services, Basic/NTLM для on-premise). refresh_token хранится
        -- в OS keychain по refresh_token_secret_ref, сюда кладётся только ссылка.
        CREATE TABLE IF NOT EXISTS exchange_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            auth_mode TEXT NOT NULL DEFAULT 'graph', -- 'graph' | 'ews'
            ews_url TEXT,
            ews_auth_type TEXT NOT NULL DEFAULT 'basic', -- 'basic' | 'ntlm'
            username TEXT NOT NULL,
            secret_ref TEXT NOT NULL,
            tenant_id TEXT,
            client_id TEXT,
            refresh_token_secret_ref TEXT,
            min_event_minutes INTEGER NOT NULL DEFAULT 0,
            exclude_free_busy INTEGER NOT NULL DEFAULT 1,
            exclude_declined INTEGER NOT NULL DEFAULT 1,
            is_active INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            row_key TEXT UNIQUE,
            worklog_id TEXT,
            issue_key TEXT NOT NULL,
            issue_summary TEXT,
            project_key TEXT,
            started TEXT NOT NULL,
            time_spent_seconds INTEGER NOT NULL,
            comment TEXT,
            updated TEXT,
            synced_at TEXT
        );
        -- Кэш встреч из Exchange/Outlook на день — обновляется ручным refresh или
        -- автоматически при смене сутки (см. exchange_client::get_calendar_events).
        CREATE TABLE IF NOT EXISTS calendar_events_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT UNIQUE,
            subject TEXT,
            start_at TEXT NOT NULL,
            end_at TEXT NOT NULL,
            attendees TEXT,
            category TEXT,
            online_meeting_url TEXT,
            response_status TEXT,
            show_as TEXT,
            cached_date TEXT NOT NULL,
            cached_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS wizard_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            config_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS custom_holidays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL UNIQUE,
            label TEXT
        );
        CREATE TABLE IF NOT EXISTS recent_issues (
            issue_key TEXT PRIMARY KEY,
            summary TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        -- Очередь несинхронизированных изменений экрана "Мой worklog":
        -- при потере сети/сне Windows сюда кладётся update/delete-операция,
        -- а после пробуждения/восстановления сети очередь выгребается повторно.
        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            row_key TEXT NOT NULL,
            operation TEXT NOT NULL, -- 'update' | 'delete' | 'create' | 'duplicate'
            payload_json TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    // Главная миграция для dev-баз без ews_auth_type/is_active/created_at/updated_at,
    // созданных до того, как в exchange_profiles были добавлены эти колонки.
    // ALTER TABLE ... ADD COLUMN безопасен при повторном вызове — SQLite вернёт ошибку
    // "duplicate column name", которую мы просто игнорируем.
    for stmt in [
        "ALTER TABLE exchange_profiles ADD COLUMN ews_auth_type TEXT NOT NULL DEFAULT 'basic'",
        "ALTER TABLE exchange_profiles ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE exchange_profiles ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        "ALTER TABLE exchange_profiles ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
    ] {
        let _ = conn.execute(stmt, []);
    }

    Ok(())
}
