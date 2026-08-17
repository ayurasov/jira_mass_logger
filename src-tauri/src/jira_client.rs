// Клиент для работы с Jira REST API (Cloud/Server) — аутентификация, worklog
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct JiraConnectionParams {
    pub base_url: String,
    pub email: String,
    pub secret_ref: String,
    pub is_cloud: bool,
}

#[derive(Serialize, Deserialize)]
pub struct WorklogEntry {
    pub issue_key: String,
    pub started: String,
    pub time_spent_seconds: u64,
    pub comment: Option<String>,
}

#[tauri::command]
pub async fn test_jira_connection(params: JiraConnectionParams) -> Result<bool, String> {
    // TODO: выполнить запрос к /rest/api/2/myself с токеном из keychain
    let _ = params;
    Ok(true)
}

#[tauri::command]
pub async fn submit_worklog(
    params: JiraConnectionParams,
    entry: WorklogEntry,
) -> Result<String, String> {
    // TODO: POST /rest/api/2/issue/{issueKey}/worklog
    let _ = (params, entry);
    Ok("ok".into())
}
