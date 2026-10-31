//! Просмотр worklog коллег: поиск пользователей Jira и выборка worklog
//! нескольких авторов за период (экран «Команда»).
//!
//! Алгоритм выборки: JQL `worklogAuthor in (...) AND worklogDate в периоде` →
//! задачи вместе с их worklog (поиск отдаёт до 20 записей на задачу) → отдельные
//! запросы только для задач с большой историей (параллельно, с ограничением, за
//! период) → фильтр по автору и дате начала.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use crate::jira_client::{
    adf_to_plain_text, apply_auth, embedded_worklogs, ensure_json_success, fetch_issue_worklogs,
    fetch_myself, fetch_worklogs_for_issues, init, search_issues, send_with_retry, url,
    JiraConnectionParams, JiraInstanceType,
};

/// Максимум задач, по которым собираем worklog за один запрос отчёта.
const MAX_ISSUES: usize = 1000;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JiraUserDto {
    /// Cloud — accountId, Server/DC — username (name). Используется в JQL worklogAuthor.
    pub id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub active: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamWorklogDto {
    pub id: String,
    pub author_id: String,
    pub author_name: String,
    pub issue_key: String,
    pub issue_summary: Option<String>,
    pub started: String,
    pub time_spent_seconds: i64,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamWorklogsResult {
    pub worklogs: Vec<TeamWorklogDto>,
    /// true — задач больше лимита, отчёт неполный.
    pub truncated: bool,
    /// Ошибки по отдельным задачам (не прерывают отчёт).
    pub errors: Vec<String>,
}

pub(crate) fn is_cloud(params: &JiraConnectionParams) -> bool {
    matches!(params.instance_type, JiraInstanceType::Cloud)
}

pub(crate) fn jql_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Идентификатор автора worklog в той же форме, что и `JiraUserDto::id`.
pub(crate) fn author_id(author: &Value, cloud: bool) -> Option<String> {
    if cloud {
        author.get("accountId").and_then(|v| v.as_str()).map(str::to_string)
    } else {
        author
            .get("name")
            .or_else(|| author.get("key"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_lowercase())
    }
}

#[tauri::command]
pub async fn search_jira_users(
    params: JiraConnectionParams,
    query: String,
) -> Result<Vec<JiraUserDto>, String> {
    let q = query.trim();
    if q.len() < 2 {
        return Ok(Vec::new());
    }
    let ctx = init(&params).map_err(String::from)?;
    let cloud = is_cloud(&params);
    let endpoint = url(&params, "user/search");
    let query_pairs: Vec<(&str, String)> = if cloud {
        vec![("query", q.to_string()), ("maxResults", "20".into())]
    } else {
        vec![("username", q.to_string()), ("maxResults", "20".into())]
    };
    let resp = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.get(&endpoint), &params, &ctx.token).query(&query_pairs)
    })
    .await
    .map_err(String::from)?;
    let body = ensure_json_success(resp).await?;
    let users = body.as_array().cloned().unwrap_or_default();
    Ok(users
        .iter()
        .filter(|u| {
            // Cloud: только живые пользователи (без приложений/ботов).
            !cloud || u.get("accountType").and_then(|v| v.as_str()).unwrap_or("atlassian") == "atlassian"
        })
        .filter_map(|u| {
            let id = if cloud {
                u.get("accountId")?.as_str()?.to_string()
            } else {
                u.get("name").or_else(|| u.get("key"))?.as_str()?.to_string()
            };
            Some(JiraUserDto {
                display_name: u
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&id)
                    .to_string(),
                email: u.get("emailAddress").and_then(|v| v.as_str()).map(str::to_string),
                active: u.get("active").and_then(|v| v.as_bool()).unwrap_or(true),
                id,
            })
        })
        .collect())
}

/// Текущий пользователь Jira в форме `JiraUserDto` (кнопка «+ Я» на экране «Команда»).
#[tauri::command]
pub async fn get_current_jira_user(params: JiraConnectionParams) -> Result<JiraUserDto, String> {
    let ctx = init(&params).map_err(String::from)?;
    let me = fetch_myself(&ctx, &params).await.map_err(String::from)?;
    let id = if is_cloud(&params) { me.account_id.clone() } else { me.name.clone().or(me.key.clone()) }
        .ok_or("Jira не вернула идентификатор пользователя")?;
    Ok(JiraUserDto {
        display_name: me.display_name.clone().unwrap_or_else(|| id.clone()),
        email: me.email.clone(),
        active: true,
        id,
    })
}

/// Строки отчёта из worklog одной задачи: фильтр по авторам и датам.
/// Пустой `authors` — без фильтра по автору (все worklog задачи за период).
fn team_rows(
    worklogs: &[Value],
    cloud: bool,
    issue_key: &str,
    issue_summary: &Option<String>,
    authors: &HashSet<String>,
    date_from: &str,
    date_to: &str,
) -> Vec<TeamWorklogDto> {
    let mut out = Vec::new();
    for w in worklogs {
        let Some(author) = w.get("author") else { continue };
        let Some(aid) = author_id(author, cloud) else { continue };
        if !authors.is_empty() && !authors.contains(&aid) {
            continue;
        }
        let started = w.get("started").and_then(|v| v.as_str()).unwrap_or("");
        let day = started.get(..10).unwrap_or("");
        if day < date_from || day > date_to {
            continue;
        }
        out.push(TeamWorklogDto {
            id: w.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            author_id: aid,
            author_name: author
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            issue_key: issue_key.to_string(),
            issue_summary: issue_summary.clone(),
            started: started.to_string(),
            time_spent_seconds: w.get("timeSpentSeconds").and_then(|v| v.as_i64()).unwrap_or(0),
            comment: w.get("comment").map(adf_to_plain_text).filter(|c| !c.trim().is_empty()),
        });
    }
    out
}

/// Worklog одной задачи, отфильтрованные по авторам и датам (запрос — только за период).
/// Пустой `authors` — без фильтра по автору (все worklog задачи за период).
pub(crate) async fn issue_worklogs(
    params: &JiraConnectionParams,
    ctx: &crate::jira_client::AuthedClient,
    issue_key: &str,
    issue_summary: Option<String>,
    authors: &HashSet<String>,
    date_from: &str,
    date_to: &str,
) -> Result<Vec<TeamWorklogDto>, String> {
    let worklogs = fetch_issue_worklogs(ctx, params, issue_key, Some((date_from, date_to))).await?;
    Ok(team_rows(&worklogs, is_cloud(params), issue_key, &issue_summary, authors, date_from, date_to))
}

#[tauri::command]
pub async fn get_team_worklogs(
    params: JiraConnectionParams,
    user_ids: Vec<String>,
    date_from: String,
    date_to: String,
) -> Result<TeamWorklogsResult, String> {
    if user_ids.is_empty() {
        return Ok(TeamWorklogsResult { worklogs: Vec::new(), truncated: false, errors: Vec::new() });
    }
    let cloud = is_cloud(&params);
    let ctx = init(&params).map_err(String::from)?;

    let authors_jql = user_ids.iter().map(|u| jql_quote(u)).collect::<Vec<_>>().join(", ");
    let jql = format!(
        "worklogAuthor in ({authors_jql}) AND worklogDate >= {} AND worklogDate <= {} ORDER BY key",
        jql_quote(&date_from),
        jql_quote(&date_to)
    );
    // Задачи сразу с их worklog: большинству задач отдельный запрос не нужен.
    let (issues, truncated) = search_issues(&ctx, &params, &jql, &["summary", "worklog"], MAX_ISSUES).await?;

    let authors: HashSet<String> = user_ids
        .iter()
        .map(|u| if cloud { u.clone() } else { u.to_lowercase() })
        .collect();
    let mut worklogs = Vec::new();
    let mut summaries = std::collections::HashMap::new();
    let mut to_fetch = Vec::new();
    for issue in &issues {
        let Some(key) = issue.get("key").and_then(|k| k.as_str()) else { continue };
        let summary = issue
            .get("fields")
            .and_then(|f| f.get("summary"))
            .and_then(|s| s.as_str())
            .map(str::to_string);
        match embedded_worklogs(issue) {
            Some(list) => worklogs.extend(team_rows(&list, cloud, key, &summary, &authors, &date_from, &date_to)),
            None => {
                summaries.insert(key.to_string(), summary);
                to_fetch.push(key.to_string());
            }
        }
    }

    let mut errors = Vec::new();
    let period = Some((date_from.clone(), date_to.clone()));
    for (key, res) in fetch_worklogs_for_issues(&ctx, &params, to_fetch, period).await {
        match res {
            Ok(list) => {
                let summary = summaries.get(&key).cloned().flatten();
                worklogs.extend(team_rows(&list, cloud, &key, &summary, &authors, &date_from, &date_to));
            }
            Err(e) => errors.push(format!("{key}: {e}")),
        }
    }
    worklogs.sort_by(|a, b| a.started.cmp(&b.started));
    Ok(TeamWorklogsResult { worklogs, truncated, errors })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jql_quote_escapes() {
        assert_eq!(jql_quote(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    fn server_params(base_url: String) -> JiraConnectionParams {
        std::env::set_var("JIRATIME_TEST_SECRET_TEAM_SECRET", "dummy");
        JiraConnectionParams {
            base_url, email: "lead".into(), secret_ref: "team-secret".into(),
            instance_type: JiraInstanceType::Server, extra_root_ca_pem_path: None,
            proxy: None, user_timezone: Some("UTC".into()), accept_invalid_certs: false,
        }
    }

    #[tokio::test]
    async fn team_worklogs_filters_by_author_and_period() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/rest/api/2/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "total": 1, "issues": [{ "key": "SRM-1", "fields": { "summary": "Задача" } }]
            })))
            .mount(&server).await;
        Mock::given(method("GET")).and(path("/rest/api/2/issue/SRM-1/worklog"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "total": 4, "worklogs": [
                    { "id": "1", "author": { "name": "Ivan", "displayName": "Иван" }, "started": "2026-10-20T09:00:00.000+0300", "timeSpentSeconds": 3600, "comment": "ok" },
                    { "id": "2", "author": { "name": "other" }, "started": "2026-10-20T09:00:00.000+0300", "timeSpentSeconds": 3600 },
                    { "id": "3", "author": { "name": "ivan" }, "started": "2026-09-01T09:00:00.000+0300", "timeSpentSeconds": 3600 },
                    { "id": "4", "author": { "name": "maria" }, "started": "2026-10-21T10:00:00.000+0300", "timeSpentSeconds": 7200, "comment": "  " }
                ]
            })))
            .mount(&server).await;
        let res = get_team_worklogs(
            server_params(server.uri()),
            vec!["ivan".into(), "Maria".into()],
            "2026-10-19".into(), "2026-10-25".into(),
        ).await.unwrap();
        let ids: Vec<&str> = res.worklogs.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["1", "4"]);
        assert_eq!(res.worklogs[0].issue_summary.as_deref(), Some("Задача"));
        assert_eq!(res.worklogs[1].comment, None, "пустой комментарий → None");
        assert!(!res.truncated && res.errors.is_empty());
    }

    #[test]
    fn author_id_cloud_and_server() {
        let a = json!({ "accountId": "557058:abc", "name": "IVAN", "displayName": "Иван" });
        assert_eq!(author_id(&a, true).as_deref(), Some("557058:abc"));
        assert_eq!(author_id(&a, false).as_deref(), Some("ivan"));
        let k = json!({ "key": "JIRAUSER1" });
        assert_eq!(author_id(&k, false).as_deref(), Some("jirauser1"));
    }
}
