// Безопасное хранение секретов (API-токены Jira/Exchange) через OS keychain
use keyring::Entry;

#[tauri::command]
pub fn save_secret(secret_ref: String, value: String) -> Result<(), String> {
    let entry = Entry::new("jiratime", &secret_ref).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_secret(secret_ref: String) -> Result<(), String> {
    let entry = Entry::new("jiratime", &secret_ref).map_err(|e| e.to_string())?;
    entry.delete_password().map_err(|e| e.to_string())
}
