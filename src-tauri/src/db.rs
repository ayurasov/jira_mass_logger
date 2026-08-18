// Инициализация локальной SQLite БД.
use std::fs;
use tauri::{AppHandle, Manager};

pub fn init_db(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;
    let db_path = app_data_dir.join("jiratime.db");
    let conn = rusqlite::Connection::open(&db_path)?;

    conn.execute_batch(
        "PRAGMA journal_mode=WAL;

        CREATE TABLE IF NOT EXISTS jira_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            email TEXT NOT NULL,
            type TEXT NOT NULL,
            secret_ref TEXT NOT NULL,
            instance_type TEXT NOT NULL DEFAULT 'cloud',
            extra_root_ca_pem_path TEXT,
            proxy_url TEXT,
            proxy_username TEXT,
            proxy_secret_ref TEXT,
            user_timezone TEXT,
            is_active INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS exchange_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            auth_mode TEXT NOT NULL DEFAULT 'ews',
            ews_url TEXT,
            ews_auth_type TEXT,
            username TEXT NOT NULL,
            secret_ref TEXT NOT NULL,
            tenant_id TEXT,
            client_id TEXT,
            refresh_token_secret_ref TEXT,
            min_event_minutes INTEGER,
            exclude_free_busy INTEGER,
            exclude_declined INTEGER,
            is_active INTEGER NOT NULL DEFAULT 0
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
        );

        CREATE TABLE IF NOT EXISTS wizard_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            config_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS recent_issues (
            issue_key TEXT PRIMARY KEY,
            summary TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS custom_holidays (
            date TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS calendar_events_cache (
            id TEXT NOT NULL,
            profile_id INTEGER NOT NULL,
            subject TEXT NOT NULL,
            start_at TEXT NOT NULL,
            end_at TEXT NOT NULL,
            duration_minutes INTEGER NOT NULL,
            attendees_json TEXT NOT NULL DEFAULT '[]',
            category TEXT,
            color TEXT,
            online_meeting_url TEXT,
            response_status TEXT,
            show_as TEXT,
            series_master_id TEXT,
            cached_date TEXT NOT NULL,
            PRIMARY KEY (id, profile_id)
        );

        CREATE TABLE IF NOT EXISTS cached_worklogs (
            row_key TEXT PRIMARY KEY,
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

        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            row_key TEXT NOT NULL,
            operation TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS meeting_match_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            pattern TEXT NOT NULL,
            issue_key TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS meeting_issue_history (
            series_key TEXT PRIMARY KEY,
            issue_key TEXT NOT NULL,
            issue_summary TEXT,
            last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
            use_count INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS description_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            body TEXT NOT NULL,
            use_count INTEGER NOT NULL DEFAULT 0
        );",
    )?;

    // Migrations: safe to run repeatedly, ignore duplicate-column errors
    let migrations: &[&str] = &[
        "ALTER TABLE jira_profiles ADD COLUMN instance_type TEXT NOT NULL DEFAULT 'cloud'",
        "ALTER TABLE jira_profiles ADD COLUMN extra_root_ca_pem_path TEXT",
        "ALTER TABLE jira_profiles ADD COLUMN proxy_url TEXT",
        "ALTER TABLE jira_profiles ADD COLUMN proxy_username TEXT",
        "ALTER TABLE jira_profiles ADD COLUMN proxy_secret_ref TEXT",
        "ALTER TABLE jira_profiles ADD COLUMN user_timezone TEXT",
        "ALTER TABLE jira_profiles ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE exchange_profiles ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'ews'",
        "ALTER TABLE exchange_profiles ADD COLUMN ews_auth_type TEXT",
        "ALTER TABLE exchange_profiles ADD COLUMN tenant_id TEXT",
        "ALTER TABLE exchange_profiles ADD COLUMN client_id TEXT",
        "ALTER TABLE exchange_profiles ADD COLUMN refresh_token_secret_ref TEXT",
        "ALTER TABLE exchange_profiles ADD COLUMN min_event_minutes INTEGER",
        "ALTER TABLE exchange_profiles ADD COLUMN exclude_free_busy INTEGER",
        "ALTER TABLE exchange_profiles ADD COLUMN exclude_declined INTEGER",
        "ALTER TABLE exchange_profiles ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE calendar_events_cache ADD COLUMN series_master_id TEXT",
        "ALTER TABLE description_templates ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0",
    ];
    for migration in migrations {
        let _ = conn.execute_batch(migration);
    }

    Ok(())
}
