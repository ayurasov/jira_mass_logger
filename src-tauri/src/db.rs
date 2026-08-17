// Инициализация локальной SQLite БД (профили, шаблоны, кэш worklog, настройки)
use tauri::AppHandle;

pub fn init_db(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Схема (создаётся через tauri-plugin-sql миграции или rusqlite):
    // jira_profiles(id, name, base_url, email, type, secret_ref)
    // exchange_profiles(id, name, ews_url, username, secret_ref)
    // templates(id, issue_key, description, hours, weekdays, period_start, period_end)
    // worklog_cache(id, issue_key, started, time_spent_seconds, comment, synced_at)
    // settings(key, value)
    Ok(())
}
