//! Дайджест активности в Jira по проекту(ам) или составу команды.
//!
//! За период собираем:
//!  * задачи, изменённые с даты `since`, с историей изменений (changelog) за период;
//!  * «застывшие» открытые задачи — без изменений дольше заданного срока;
//!  * worklog за период (по задачам скоупа или по авторам-участникам).
//!
//! Аналитика (переходы статусов, люди без активности, задачи «в работе» без
//! списаний) считается на фронтенде.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Semaphore;

use crate::jira_client::{apply_auth, ensure_json_success, init, send_with_retry, url, AuthedClient, JiraConnectionParams};
use crate::team_worklogs::{author_id, is_cloud, issue_worklogs, jql_quote, TeamWorklogDto};

/// Лимит по умолчанию для тяжёлых запросов (задачи с историей, задачи с worklog).
const DEFAULT_LIMIT: usize = 300;
/// Пользовательский лимит зажимается в эти рамки.
const LIMIT_RANGE: (usize, usize) = (20, 2000);
/// «Без движения», «просрочено», «без исполнителя» грузятся целиком (лёгкие поля, без истории);
/// это лишь страховка от бесконечной выборки — точное число всё равно берём из Jira.
const MAX_LIST: usize = 5000;
const CONCURRENCY: usize = 6;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DigestScope {
    /// Ключи проектов (скоуп «проект»).
    #[serde(default)]
    pub project_keys: Vec<String>,
    /// Участники (Cloud — accountId, Server — username) для скоупа «команда».
    #[serde(default)]
    pub user_ids: Vec<String>,
    /// Произвольный JQL-фильтр (эпик, компонент, метка…) — скоуп «свой JQL».
    #[serde(default)]
    pub jql: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DigestChange {
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub created: String,
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DigestIssue {
    pub key: String,
    pub summary: String,
    pub status: String,
    /// "new" | "indeterminate" | "done"
    pub status_category: String,
    pub issue_type: Option<String>,
    pub priority: Option<String>,
    pub assignee_id: Option<String>,
    pub assignee_name: Option<String>,
    pub created: String,
    pub updated: String,
    /// Срок (YYYY-MM-DD), если задан.
    pub due_date: Option<String>,
    pub project_key: Option<String>,
    pub changes: Vec<DigestChange>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DigestResult {
    pub updated: Vec<DigestIssue>,
    pub stale: Vec<DigestIssue>,
    /// Открытые задачи с истёкшим сроком.
    pub overdue: Vec<DigestIssue>,
    /// Открытые задачи без исполнителя.
    pub unassigned: Vec<DigestIssue>,
    pub worklogs: Vec<TeamWorklogDto>,
    /// Точное число задач в Jira по каждому списку (может быть больше загруженного).
    pub stale_total: usize,
    pub overdue_total: usize,
    pub unassigned_total: usize,
    /// Применённый лимит для изменённых задач и задач с worklog.
    pub limit: usize,
    pub truncated: bool,
    pub errors: Vec<String>,
}

/// Условие скоупа для JQL.
fn scope_clause(scope: &DigestScope, worklog_too: bool) -> Result<String, String> {
    if let Some(jql) = scope.jql.as_deref().map(str::trim).filter(|j| !j.is_empty()) {
        // ORDER BY из пользовательского JQL мешает добавлять условия — отрезаем.
        let lower = jql.to_ascii_lowercase(); // ASCII — индексы байт совпадают с исходной строкой
        let body = match lower.find("order by") { Some(i) => jql[..i].trim(), None => jql };
        return Ok(format!("({body})"));
    }
    if !scope.project_keys.is_empty() {
        let keys = scope.project_keys.iter().map(|k| jql_quote(k)).collect::<Vec<_>>().join(", ");
        return Ok(format!("project in ({keys})"));
    }
    if !scope.user_ids.is_empty() {
        let users = scope.user_ids.iter().map(|u| jql_quote(u)).collect::<Vec<_>>().join(", ");
        return Ok(if worklog_too {
            format!("(assignee in ({users}) OR reporter in ({users}) OR worklogAuthor in ({users}))")
        } else {
            format!("assignee in ({users})")
        });
    }
    Err("Выберите проект или команду".into())
}

/// Результат постраничного поиска: задачи, «есть ещё» и точное число совпадений (если известно).
struct SearchPage {
    issues: Vec<Value>,
    more: bool,
    total: Option<usize>,
}

/// Поиск задач с полями/expand; лимит `limit`.
async fn search_raw(
    params: &JiraConnectionParams,
    ctx: &AuthedClient,
    jql: &str,
    fields: &[&str],
    expand_changelog: bool,
    limit: usize,
) -> Result<SearchPage, String> {
    let cloud = is_cloud(params);
    let mut out: Vec<Value> = Vec::new();
    let mut total: Option<usize> = None;
    // Без changelog страницы можно брать крупнее: Jira сама урежет до своего максимума,
    // а цикл ниже опирается на фактическую длину страницы.
    let max_page = if expand_changelog { 100 } else { 500 };
    let mut start_at: i64 = 0;
    let mut next_token: Option<String> = None;
    loop {
        let page_size = (limit - out.len()).min(max_page);
        let (endpoint, body) = if cloud {
            let mut b = json!({ "jql": jql, "fields": fields, "maxResults": page_size });
            if expand_changelog { b["expand"] = json!("changelog"); }
            if let Some(t) = &next_token { b["nextPageToken"] = json!(t); }
            (url(params, "search/jql"), b)
        } else {
            let mut b = json!({ "jql": jql, "fields": fields, "startAt": start_at, "maxResults": page_size });
            if expand_changelog { b["expand"] = json!(["changelog"]); }
            (url(params, "search"), b)
        };
        let resp = send_with_retry(&ctx.client, || {
            apply_auth(ctx.client.post(&endpoint), params, &ctx.token).json(&body)
        })
        .await
        .map_err(String::from)?;
        let page = ensure_json_success(resp).await?;
        let issues = page.get("issues").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let page_len = issues.len();
        out.extend(issues);
        let more = if cloud {
            next_token = page.get("nextPageToken").and_then(|v| v.as_str()).map(str::to_string);
            !page.get("isLast").and_then(|v| v.as_bool()).unwrap_or(next_token.is_none()) && next_token.is_some()
        } else {
            let t = page.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
            total = Some(t.max(0) as usize);
            start_at += page_len as i64;
            start_at < t
        };
        if out.len() >= limit {
            return Ok(SearchPage { issues: out, more, total });
        }
        if !more || page_len == 0 {
            let total = Some(total.unwrap_or(0).max(out.len()));
            return Ok(SearchPage { issues: out, more: false, total });
        }
    }
}

/// Точное число задач по JQL. Server/DC отдаёт `total` в поиске; в Cloud у `search/jql`
/// его нет — спрашиваем `search/approximate-count` (для небольших выборок он точный).
async fn count_jql(params: &JiraConnectionParams, ctx: &AuthedClient, jql: &str) -> Option<usize> {
    let (endpoint, body) = if is_cloud(params) {
        (url(params, "search/approximate-count"), json!({ "jql": jql }))
    } else {
        (url(params, "search"), json!({ "jql": jql, "maxResults": 0, "fields": ["key"] }))
    };
    let resp = send_with_retry(&ctx.client, || apply_auth(ctx.client.post(&endpoint), params, &ctx.token).json(&body))
        .await
        .ok()?;
    let v = ensure_json_success(resp).await.ok()?;
    v.get("count").or_else(|| v.get("total")).and_then(|c| c.as_u64()).map(|c| c as usize)
}

/// Полный список (до MAX_LIST) и точное число совпадений.
async fn full_list(
    params: &JiraConnectionParams,
    ctx: &AuthedClient,
    jql: &str,
    cloud: bool,
    since: &str,
) -> Result<(Vec<DigestIssue>, usize), String> {
    let page = search_raw(params, ctx, jql, FIELDS, false, MAX_LIST).await?;
    let issues: Vec<DigestIssue> = page.issues.iter().filter_map(|v| parse_issue(v, cloud, since)).collect();
    let total = match page.total {
        Some(t) if !page.more || t > issues.len() => t,
        _ if page.more => count_jql(params, ctx, jql).await.unwrap_or(issues.len()),
        _ => issues.len(),
    };
    let total = total.max(issues.len());
    Ok((issues, total))
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_str()
}

/// Значение поля changelog в читаемом виде.
fn change_value(item: &Value, key_str: &str, key_raw: &str) -> Option<String> {
    item.get(key_str)
        .and_then(|v| v.as_str())
        .or_else(|| item.get(key_raw).and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_issue(v: &Value, cloud: bool, since: &str) -> Option<DigestIssue> {
    let key = v.get("key")?.as_str()?.to_string();
    let f = v.get("fields")?;
    let assignee = f.get("assignee").filter(|a| !a.is_null());
    let mut changes = Vec::new();
    if let Some(histories) = v.get("changelog").and_then(|c| c.get("histories")).and_then(|h| h.as_array()) {
        for h in histories {
            let created = h.get("created").and_then(|c| c.as_str()).unwrap_or("").to_string();
            if created.get(..10).unwrap_or("") < since {
                continue;
            }
            let author = h.get("author");
            for item in h.get("items").and_then(|i| i.as_array()).into_iter().flatten() {
                changes.push(DigestChange {
                    author_id: author.and_then(|a| author_id(a, cloud)),
                    author_name: author.and_then(|a| str_at(a, &["displayName"])).map(str::to_string),
                    created: created.clone(),
                    field: item.get("field").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    from: change_value(item, "fromString", "from"),
                    to: change_value(item, "toString", "to"),
                });
            }
        }
    }
    changes.sort_by(|a, b| b.created.cmp(&a.created));
    Some(DigestIssue {
        key,
        summary: str_at(f, &["summary"]).unwrap_or("").to_string(),
        status: str_at(f, &["status", "name"]).unwrap_or("").to_string(),
        status_category: str_at(f, &["status", "statusCategory", "key"]).unwrap_or("").to_string(),
        issue_type: str_at(f, &["issuetype", "name"]).map(str::to_string),
        priority: str_at(f, &["priority", "name"]).map(str::to_string),
        assignee_id: assignee.and_then(|a| author_id(a, cloud)),
        assignee_name: assignee.and_then(|a| str_at(a, &["displayName"])).map(str::to_string),
        created: str_at(f, &["created"]).unwrap_or("").to_string(),
        updated: str_at(f, &["updated"]).unwrap_or("").to_string(),
        due_date: str_at(f, &["duedate"]).map(str::to_string),
        project_key: str_at(f, &["project", "key"]).map(str::to_string)
            .or_else(|| key_project(v)),
        changes,
    })
}

const FIELDS: &[&str] = &["summary", "status", "assignee", "updated", "created", "priority", "issuetype", "duedate", "project"];

fn key_project(v: &Value) -> Option<String> {
    v.get("key")?.as_str()?.split('-').next().map(str::to_string)
}

/// Дайджест: `since` — начало периода (YYYY-MM-DD), `until` — конец (обычно сегодня),
/// `stale_before` — «застывшие» задачи: не обновлялись раньше этой даты.
/// `limit` — сколько максимум задач грузить для изменённых и для worklog (самые тяжёлые запросы).
#[tauri::command]
pub async fn get_jira_digest(
    params: JiraConnectionParams,
    scope: DigestScope,
    since: String,
    until: String,
    stale_before: String,
    limit: Option<usize>,
) -> Result<DigestResult, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(LIMIT_RANGE.0, LIMIT_RANGE.1);
    let cloud = is_cloud(&params);
    let ctx = Arc::new(init(&params).map_err(String::from)?);
    let params = Arc::new(params);
    let mut errors = Vec::new();

    // 1) Изменённые задачи с историей.
    let updated_jql = format!(
        "{} AND updated >= {} ORDER BY updated DESC",
        scope_clause(&scope, true)?,
        jql_quote(&since)
    );
    let updated_page = search_raw(&params, &ctx, &updated_jql, FIELDS, true, limit).await?;
    let truncated_updated = updated_page.more;
    let updated: Vec<DigestIssue> = updated_page.issues.iter().filter_map(|v| parse_issue(v, cloud, &since)).collect();

    // 2) Застывшие открытые задачи (без expand — история не нужна).
    let stale_jql = format!(
        "{} AND statusCategory != Done AND updated < {} ORDER BY updated ASC",
        scope_clause(&scope, false)?,
        jql_quote(&stale_before)
    );
    let (stale, stale_total) = match full_list(&params, &ctx, &stale_jql, cloud, &since).await {
        Ok(r) => r,
        Err(e) => { errors.push(format!("застывшие задачи: {e}")); (Vec::new(), 0) }
    };

    // 3) Просроченные и без исполнителя (открытые задачи скоупа).
    let open_scope = scope_clause(&scope, false)?;
    let overdue_jql = format!(
        "{open_scope} AND statusCategory != Done AND duedate < {} ORDER BY duedate ASC",
        jql_quote(&until)
    );
    let (overdue, overdue_total) = match full_list(&params, &ctx, &overdue_jql, cloud, &since).await {
        Ok(r) => r,
        Err(e) => { errors.push(format!("просроченные: {e}")); (Vec::new(), 0) }
    };
    // Для команды «без исполнителя» по assignee теряет смысл — только для проектов/JQL.
    let (unassigned, unassigned_total) = if scope.user_ids.is_empty() || scope.jql.as_deref().is_some_and(|j| !j.trim().is_empty()) {
        let jql = format!("{open_scope} AND statusCategory != Done AND assignee is EMPTY ORDER BY created ASC");
        match full_list(&params, &ctx, &jql, cloud, &since).await {
            Ok(r) => r,
            Err(e) => { errors.push(format!("без исполнителя: {e}")); (Vec::new(), 0) }
        }
    } else {
        (Vec::new(), 0)
    };

    // 4) Worklog за период.
    let wl_scope = if !scope.project_keys.is_empty() || scope.jql.as_deref().is_some_and(|j| !j.trim().is_empty()) {
        scope_clause(&scope, false)?
    } else {
        let users = scope.user_ids.iter().map(|u| jql_quote(u)).collect::<Vec<_>>().join(", ");
        format!("worklogAuthor in ({users})")
    };
    let wl_jql = format!(
        "{wl_scope} AND worklogDate >= {} AND worklogDate <= {} ORDER BY key",
        jql_quote(&since),
        jql_quote(&until)
    );
    let mut truncated = truncated_updated;
    let mut worklogs = Vec::new();
    match search_raw(&params, &ctx, &wl_jql, &["summary"], false, limit).await {
        Ok(SearchPage { issues, more, .. }) => {
            truncated |= more;
            let authors: Arc<HashSet<String>> = Arc::new(
                scope.user_ids.iter().map(|u| if cloud { u.clone() } else { u.to_lowercase() }).collect(),
            );
            let sem = Arc::new(Semaphore::new(CONCURRENCY));
            let mut handles = Vec::new();
            for i in issues {
                let Some(key) = i.get("key").and_then(|k| k.as_str()).map(str::to_string) else { continue };
                let summary = str_at(&i, &["fields", "summary"]).map(str::to_string);
                let (ctx, params, authors, sem) = (ctx.clone(), params.clone(), authors.clone(), sem.clone());
                let (from, to) = (since.clone(), until.clone());
                handles.push(tokio::spawn(async move {
                    let _p = sem.acquire().await;
                    let r = issue_worklogs(&params, &ctx, &key, summary, &authors, &from, &to).await;
                    (key, r)
                }));
            }
            for h in handles {
                match h.await {
                    Ok((_, Ok(mut list))) => worklogs.append(&mut list),
                    Ok((key, Err(e))) => errors.push(format!("{key}: {e}")),
                    Err(e) => errors.push(e.to_string()),
                }
            }
        }
        Err(e) => errors.push(format!("worklog: {e}")),
    }
    worklogs.sort_by(|a, b| b.started.cmp(&a.started));

    Ok(DigestResult {
        updated, stale, overdue, unassigned, worklogs,
        stale_total, overdue_total, unassigned_total, limit, truncated, errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn digest_server_flow() {
        use wiremock::matchers::{body_string_contains, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        std::env::set_var("JIRATIME_TEST_SECRET_DIGEST_SECRET", "dummy");
        let server = MockServer::start().await;
        let issue = |key: &str, cat: &str, updated: &str| json!({
            "key": key, "fields": { "summary": key, "status": { "name": "S", "statusCategory": { "key": cat } },
            "updated": updated, "created": "2026-09-01T00:00:00.000+0300" }
        });
        Mock::given(method("POST")).and(path("/rest/api/2/search")).and(body_string_contains("updated >="))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "total": 1, "issues": [issue("SRM-1", "indeterminate", "2026-10-23T10:00:00.000+0300")] })))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/rest/api/2/search")).and(body_string_contains("statusCategory != Done"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "total": 1, "issues": [issue("SRM-9", "new", "2026-08-01T10:00:00.000+0300")] })))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/rest/api/2/search")).and(body_string_contains("worklogDate"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "total": 1, "issues": [{ "key": "SRM-1", "fields": { "summary": "SRM-1" } }] })))
            .mount(&server).await;
        Mock::given(method("GET")).and(path("/rest/api/2/issue/SRM-1/worklog"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "total": 1, "worklogs": [
                { "id": "7", "author": { "name": "ivan" }, "started": "2026-10-22T09:00:00.000+0300", "timeSpentSeconds": 3600 }
            ] })))
            .mount(&server).await;
        let params = JiraConnectionParams {
            base_url: server.uri(), email: "u".into(), secret_ref: "digest-secret".into(),
            instance_type: crate::jira_client::JiraInstanceType::Server, extra_root_ca_pem_path: None,
            proxy: None, user_timezone: None, accept_invalid_certs: false,
        };
        let r = get_jira_digest(params, DigestScope { project_keys: vec!["SRM".into()], user_ids: vec![], jql: None },
            "2026-10-17".into(), "2026-10-24".into(), "2026-10-10".into(), None).await.unwrap();
        assert_eq!(r.updated.len(), 1);
        assert_eq!(r.stale[0].key, "SRM-9");
        assert_eq!(r.stale_total, 1);
        assert_eq!(r.limit, DEFAULT_LIMIT);
        assert_eq!(r.worklogs.len(), 1, "скоуп проекта — worklog всех авторов");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
    }

    #[test]
    fn scope_clause_project_and_team() {
        let p = DigestScope { project_keys: vec!["SRM".into(), "OPS".into()], user_ids: vec![], jql: None };
        assert_eq!(scope_clause(&p, true).unwrap(), r#"project in ("SRM", "OPS")"#);
        let t = DigestScope { project_keys: vec![], user_ids: vec!["ivan".into()], jql: None };
        assert_eq!(scope_clause(&t, false).unwrap(), r#"assignee in ("ivan")"#);
        assert!(scope_clause(&t, true).unwrap().contains("worklogAuthor"));
        assert!(scope_clause(&DigestScope::default(), true).is_err());
        let j = DigestScope { jql: Some("\"Epic Link\" = SRM-1 ORDER BY rank".into()), ..Default::default() };
        assert_eq!(scope_clause(&j, true).unwrap(), "(\"Epic Link\" = SRM-1)");
    }

    #[test]
    fn parse_issue_keeps_only_changes_in_period() {
        let v = json!({
            "key": "SRM-1",
            "fields": {
                "summary": "Задача", "status": { "name": "В работе", "statusCategory": { "key": "indeterminate" } },
                "assignee": { "name": "Ivan", "displayName": "Иван" },
                "updated": "2026-10-23T10:00:00.000+0300", "created": "2026-10-01T10:00:00.000+0300"
            },
            "changelog": { "histories": [
                { "created": "2026-10-22T09:00:00.000+0300", "author": { "name": "maria", "displayName": "Мария" },
                  "items": [{ "field": "status", "fromString": "Открыта", "toString": "В работе" }] },
                { "created": "2026-10-02T09:00:00.000+0300", "author": { "name": "maria" },
                  "items": [{ "field": "assignee", "fromString": null, "toString": "Иван" }] }
            ] }
        });
        let i = parse_issue(&v, false, "2026-10-20").unwrap();
        assert_eq!(i.assignee_id.as_deref(), Some("ivan"));
        assert_eq!(i.status_category, "indeterminate");
        assert_eq!(i.changes.len(), 1);
        assert_eq!(i.changes[0].to.as_deref(), Some("В работе"));
        assert_eq!(i.changes[0].author_id.as_deref(), Some("maria"));
    }
}
