//! Битрикс24 — необязательная интеграция через входящий вебхук.
//!
//! Вебхук вида `https://<портал>/rest/<id пользователя>/<код>/` хранится только в системном
//! хранилище секретов (keyring), фронтенд передаёт лишь ссылку на секрет. Через него:
//!  * список своих задач (ответственный / наблюдатель / соисполнитель / постановщик), поиск;
//!  * карточка задачи с описанием, комментариями и результатами;
//!  * добавление комментария и отметка его как результата задачи.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

use crate::jira_client::get_secret;

/// Задач на странице у `tasks.task.list` — фиксировано Битрикс24.
const PAGE: u32 = 50;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BitrixUser {
    pub id: String,
    pub name: String,
    /// Адрес портала (без пути вебхука) — для ссылок на задачи.
    pub portal: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BitrixTask {
    pub id: String,
    pub title: String,
    /// Код статуса Битрикс24: 1 новая, 2 ждёт выполнения, 3 выполняется, 4 ждёт контроля,
    /// 5 завершена, 6 отложена, 7 отклонена.
    pub status: String,
    pub deadline: Option<String>,
    pub changed: Option<String>,
    pub created: Option<String>,
    pub priority: Option<String>,
    pub responsible_id: Option<String>,
    pub responsible_name: Option<String>,
    pub creator_id: Option<String>,
    pub creator_name: Option<String>,
    pub group_name: Option<String>,
    pub auditors: Vec<String>,
    pub accomplices: Vec<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BitrixTaskPage {
    pub tasks: Vec<BitrixTask>,
    pub total: u32,
    /// Смещение следующей страницы, если она есть.
    pub next: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BitrixComment {
    pub id: String,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub text: String,
    pub created: Option<String>,
    /// Комментарий отмечен как результат задачи.
    pub is_result: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BitrixTaskDetail {
    pub task: BitrixTask,
    pub comments: Vec<BitrixComment>,
    /// Не удалось прочитать комментарии/результаты (например, новая карточка задач с чатом) —
    /// задача показывается, а причина видна пользователю.
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BitrixCommentResult {
    pub comment_id: String,
    pub result_added: bool,
    /// Комментарий добавлен, но отметить результатом не удалось — почему.
    pub result_error: Option<String>,
}

/// Вебхук без лишнего: `https://host/rest/<id>/<code>/` (метод, `.json` и query отрезаются).
/// Возвращает (база вебхука со слешем, id пользователя, адрес портала).
fn parse_webhook(raw: &str) -> Result<(String, String, String), String> {
    let s = raw.trim();
    let bad = || "Неверный адрес вебхука. Ожидается вид https://портал.bitrix24.ru/rest/1/код/ (Битрикс24 → Разработчикам → Входящий вебхук).".to_string();
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).ok_or_else(bad)?;
    let scheme = &s[..s.len() - rest.len()];
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let host = parts.next().ok_or_else(bad)?;
    if parts.next() != Some("rest") {
        return Err(bad());
    }
    let user = parts.next().filter(|u| u.chars().all(|c| c.is_ascii_digit())).ok_or_else(bad)?;
    let code = parts.next().filter(|c| !c.is_empty() && !c.contains('.')).ok_or_else(bad)?;
    Ok((format!("{scheme}{host}/rest/{user}/{code}/"), user.to_string(), format!("{scheme}{host}")))
}

struct Bitrix {
    client: reqwest::Client,
    base: String,
    user_id: String,
    portal: String,
}

fn connect(secret_ref: &str) -> Result<Bitrix, String> {
    let raw = get_secret(secret_ref).map_err(|_| "Вебхук Битрикс24 не сохранён — укажите его в «Настройках».".to_string())?;
    let (base, user_id, portal) = parse_webhook(&raw)?;
    let mut builder = reqwest::Client::builder()
        .use_rustls_tls()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60));
    // Корпоративный прокси Windows — как для Jira (переменные окружения reqwest читает сам).
    if let Some(proxy) = crate::jira_client::read_windows_system_proxy().and_then(|p| reqwest::Proxy::all(p).ok()) {
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    Ok(Bitrix { client, base, user_id, portal })
}

/// Понятное сообщение по ошибке REST Битрикс24.
fn describe_error(status: u16, body: &Value) -> String {
    let code = body.get("error").and_then(|v| v.as_str()).unwrap_or("");
    let desc = body.get("error_description").and_then(|v| v.as_str()).unwrap_or("");
    let hint = match code.to_ascii_lowercase().as_str() {
        "insufficient_scope" => "у вебхука нет прав «Задачи» (task) — добавьте их в настройках вебхука",
        "invalid_credentials" | "no_auth_found" | "invalid_token" | "expired_token" => "вебхук недействителен или удалён — создайте новый",
        "query_limit_exceeded" => "слишком много запросов — повторите через минуту",
        "error_method_not_found" | "error_method" => "метод недоступен на этом портале",
        _ => "",
    };
    let detail = [hint, desc, code].into_iter().find(|s| !s.is_empty()).unwrap_or("");
    if detail.is_empty() {
        format!("Битрикс24: ошибка HTTP {status}")
    } else {
        format!("Битрикс24: {detail}")
    }
}

impl Bitrix {
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let url = format!("{}{}.json", self.base, method);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let resp = self.client.post(&url).json(&params).send().await.map_err(|e| {
                if e.is_timeout() { "Битрикс24 не отвечает (таймаут)".to_string() } else { format!("Нет связи с Битрикс24: {e}") }
            })?;
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            // Лимит запросов портала — короткая пауза и повтор.
            let limited = status == 503 || body.get("error").and_then(|v| v.as_str()) == Some("QUERY_LIMIT_EXCEEDED");
            if limited && attempt < 3 {
                tokio::time::sleep(Duration::from_millis(700 * attempt)).await;
                continue;
            }
            if !(200..300).contains(&status) || body.get("error").is_some() {
                return Err(describe_error(status, &body));
            }
            return Ok(body);
        }
    }
}

fn s_at(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        match v.get(*k) {
            Some(Value::String(s)) if !s.is_empty() => return Some(s.clone()),
            Some(Value::Number(n)) => return Some(n.to_string()),
            _ => {}
        }
    }
    None
}

fn ids(v: &Value, keys: &[&str]) -> Vec<String> {
    for k in keys {
        if let Some(arr) = v.get(*k).and_then(|a| a.as_array()) {
            return arr.iter().filter_map(|x| x.as_str().map(str::to_string).or_else(|| x.as_i64().map(|n| n.to_string()))).collect();
        }
    }
    Vec::new()
}

/// Задача из ответа `tasks.task.list/get` (ключи в camelCase, у старых порталов — в UPPER_CASE).
fn parse_task(t: &Value) -> Option<BitrixTask> {
    Some(BitrixTask {
        id: s_at(t, &["id", "ID"])?,
        title: s_at(t, &["title", "TITLE"]).unwrap_or_default(),
        status: s_at(t, &["status", "STATUS", "realStatus", "REAL_STATUS"]).unwrap_or_default(),
        deadline: s_at(t, &["deadline", "DEADLINE"]),
        changed: s_at(t, &["changedDate", "CHANGED_DATE"]),
        created: s_at(t, &["createdDate", "CREATED_DATE"]),
        priority: s_at(t, &["priority", "PRIORITY"]),
        responsible_id: s_at(t, &["responsibleId", "RESPONSIBLE_ID"]),
        responsible_name: t.get("responsible").and_then(|r| s_at(r, &["name"])),
        creator_id: s_at(t, &["createdBy", "CREATED_BY"]),
        creator_name: t.get("creator").and_then(|r| s_at(r, &["name"])),
        group_name: t.get("group").and_then(|g| s_at(g, &["name"])),
        auditors: ids(t, &["auditors", "AUDITORS"]),
        accomplices: ids(t, &["accomplices", "ACCOMPLICES"]),
        description: s_at(t, &["description", "DESCRIPTION"]),
    })
}

const SELECT: &[&str] = &[
    "ID", "TITLE", "STATUS", "DEADLINE", "CHANGED_DATE", "CREATED_DATE", "PRIORITY",
    "RESPONSIBLE_ID", "CREATED_BY", "GROUP_ID", "AUDITORS", "ACCOMPLICES",
];

/// Фильтр `tasks.task.list` по роли, статусу и поиску.
fn task_filter(user_id: &str, role: &str, status: &str, search: Option<&str>) -> Value {
    let mut f = serde_json::Map::new();
    let key = match role {
        "responsible" => "RESPONSIBLE_ID",
        "auditor" => "AUDITOR",
        "accomplice" => "ACCOMPLICE",
        "originator" => "CREATED_BY",
        _ => "MEMBER",
    };
    f.insert(key.into(), json!(user_id));
    match status {
        "active" => { f.insert("REAL_STATUS".into(), json!([1, 2, 3, 4, 6])); }
        "done" => { f.insert("REAL_STATUS".into(), json!([5])); }
        _ => {}
    }
    if let Some(q) = search.map(str::trim).filter(|q| !q.is_empty()) {
        let num = q.trim_start_matches('#');
        if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
            f.insert("ID".into(), json!(num));
        } else {
            f.insert("%TITLE".into(), json!(q));
        }
    }
    Value::Object(f)
}

/// Проверка вебхука: кто подключён и к какому порталу.
#[tauri::command]
pub async fn bitrix_test(secret_ref: String) -> Result<BitrixUser, String> {
    let b = connect(&secret_ref)?;
    let me = b.call("user.current", json!({})).await?;
    let u = me.get("result").cloned().unwrap_or(Value::Null);
    let name = [s_at(&u, &["NAME"]), s_at(&u, &["LAST_NAME"])].into_iter().flatten().collect::<Vec<_>>().join(" ");
    Ok(BitrixUser { id: s_at(&u, &["ID"]).unwrap_or(b.user_id.clone()), name, portal: b.portal })
}

/// Задачи пользователя вебхука. `role`: all | responsible | auditor | accomplice | originator;
/// `status`: active | done | all; `start` — смещение (по 50 задач).
#[tauri::command]
pub async fn bitrix_list_tasks(
    secret_ref: String,
    role: String,
    status: String,
    search: Option<String>,
    start: Option<u32>,
) -> Result<BitrixTaskPage, String> {
    let b = connect(&secret_ref)?;
    let params = json!({
        "filter": task_filter(&b.user_id, &role, &status, search.as_deref()),
        "select": SELECT,
        "order": { "CHANGED_DATE": "desc" },
        "start": start.unwrap_or(0),
    });
    let body = b.call("tasks.task.list", params).await?;
    let list = body.get("result").and_then(|r| r.get("tasks")).and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let tasks: Vec<BitrixTask> = list.iter().filter_map(parse_task).collect();
    let total = body.get("total").and_then(|v| v.as_u64()).unwrap_or(tasks.len() as u64) as u32;
    let next = body.get("next").and_then(|v| v.as_u64()).map(|n| n as u32).filter(|n| *n < total.max(PAGE * 1000));
    Ok(BitrixTaskPage { tasks, total, next })
}

/// Карточка задачи: поля с описанием, комментарии (новые сверху) и отметка «результат».
#[tauri::command]
pub async fn bitrix_get_task(secret_ref: String, task_id: String) -> Result<BitrixTaskDetail, String> {
    let b = connect(&secret_ref)?;
    let mut select: Vec<&str> = SELECT.to_vec();
    select.push("DESCRIPTION");
    let body = b.call("tasks.task.get", json!({ "taskId": task_id, "select": select })).await?;
    let task = body.get("result").and_then(|r| r.get("task")).and_then(parse_task)
        .ok_or_else(|| "Битрикс24: задача не найдена или нет доступа".to_string())?;

    let mut warnings = Vec::new();
    let mut comments: Vec<BitrixComment> = match b.call("task.commentitem.getlist", json!({ "TASKID": task_id, "ORDER": { "ID": "desc" } })).await {
        Ok(v) => v.get("result").and_then(|r| r.as_array()).cloned().unwrap_or_default().iter().filter_map(|c| {
            Some(BitrixComment {
                id: s_at(c, &["ID", "id"])?,
                author_id: s_at(c, &["AUTHOR_ID", "authorId"]),
                author_name: s_at(c, &["AUTHOR_NAME", "authorName"]),
                text: s_at(c, &["POST_MESSAGE", "postMessage"]).unwrap_or_default(),
                created: s_at(c, &["POST_DATE", "postDate"]),
                is_result: false,
            })
        }).collect(),
        Err(e) => { warnings.push(format!("комментарии: {e}")); Vec::new() }
    };
    // Результаты задачи — это комментарии с отметкой; помечаем их в ленте.
    match b.call("tasks.task.result.list", json!({ "taskId": task_id })).await {
        Ok(v) => {
            let result_ids: Vec<String> = v.get("result").and_then(|r| r.as_array()).cloned().unwrap_or_default()
                .iter().filter_map(|r| s_at(r, &["commentId", "COMMENT_ID"])).collect();
            for c in comments.iter_mut() {
                c.is_result = result_ids.contains(&c.id);
            }
        }
        Err(e) => warnings.push(format!("результаты: {e}")),
    }
    Ok(BitrixTaskDetail { task, comments, warnings })
}

/// Комментарий к задаче; `as_result` — сразу отметить его результатом задачи.
#[tauri::command]
pub async fn bitrix_add_comment(secret_ref: String, task_id: String, text: String, as_result: bool) -> Result<BitrixCommentResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Текст комментария пуст".into());
    }
    let b = connect(&secret_ref)?;
    let body = b.call("task.commentitem.add", json!({ "TASKID": task_id, "FIELDS": { "POST_MESSAGE": text } })).await?;
    let comment_id = s_at(&body, &["result"]).ok_or_else(|| "Битрикс24 не вернул номер комментария".to_string())?;
    let (result_added, result_error) = if as_result {
        match b.call("tasks.task.result.addFromComment", json!({ "commentId": comment_id })).await {
            Ok(_) => (true, None),
            Err(e) => (false, Some(e)),
        }
    } else {
        (false, None)
    };
    Ok(BitrixCommentResult { comment_id, result_added, result_error })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn webhook_is_normalized() {
        let (base, user, portal) = parse_webhook(" https://corp.bitrix24.ru/rest/17/abc123def/profile.json?x=1 ").unwrap();
        assert_eq!(base, "https://corp.bitrix24.ru/rest/17/abc123def/");
        assert_eq!(user, "17");
        assert_eq!(portal, "https://corp.bitrix24.ru");
        assert!(parse_webhook("https://corp.bitrix24.ru/rest/17/").is_err());
        assert!(parse_webhook("corp.bitrix24.ru/rest/17/abc/").is_err());
        assert!(parse_webhook("https://corp.bitrix24.ru/api/17/abc/").is_err());
    }

    #[test]
    fn filter_by_role_status_and_search() {
        let f = task_filter("17", "auditor", "active", Some("Отчёт"));
        assert_eq!(f["AUDITOR"], json!("17"));
        assert_eq!(f["REAL_STATUS"], json!([1, 2, 3, 4, 6]));
        assert_eq!(f["%TITLE"], json!("Отчёт"));
        let f = task_filter("17", "all", "all", Some("#1234"));
        assert_eq!(f["MEMBER"], json!("17"));
        assert_eq!(f["ID"], json!("1234"));
        assert!(f.get("REAL_STATUS").is_none());
    }

    #[test]
    fn errors_are_readable() {
        assert!(describe_error(401, &json!({ "error": "insufficient_scope" })).contains("прав «Задачи»"));
        assert!(describe_error(401, &json!({ "error": "NO_AUTH_FOUND", "error_description": "Wrong authorization data" })).contains("недействителен"));
        assert_eq!(describe_error(500, &Value::Null), "Битрикс24: ошибка HTTP 500");
    }

    fn with_secret(uri: &str, name: &str) -> String {
        std::env::set_var(format!("JIRATIME_TEST_SECRET_{}", name.to_uppercase().replace('-', "_")), format!("{uri}/rest/17/hookcode/"));
        name.to_string()
    }

    #[tokio::test]
    async fn list_tasks_and_comment_as_result() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/rest/17/hookcode/tasks.task.list.json")).and(body_string_contains("\"AUDITOR\":\"17\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "result": { "tasks": [
                    { "id": "101", "title": "Подготовить отчёт", "status": "3", "deadline": "2026-10-30T18:00:00+03:00",
                      "responsibleId": "5", "responsible": { "id": "5", "name": "Мария Смирнова" }, "createdBy": "17",
                      "creator": { "name": "Иван Петров" }, "group": { "name": "Бэкенд" }, "auditors": ["17"], "changedDate": "2026-10-27T10:00:00+03:00" }
                ] },
                "total": 51, "next": 50
            })))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/rest/17/hookcode/task.commentitem.add.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "result": 555 })))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/rest/17/hookcode/tasks.task.result.addFromComment.json")).and(body_string_contains("555"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "result": { "id": 9 } })))
            .mount(&server).await;

        let secret = with_secret(&server.uri(), "bitrix-test-1");
        let page = bitrix_list_tasks(secret.clone(), "auditor".into(), "active".into(), None, None).await.unwrap();
        assert_eq!(page.tasks.len(), 1);
        assert_eq!(page.tasks[0].responsible_name.as_deref(), Some("Мария Смирнова"));
        assert_eq!(page.tasks[0].group_name.as_deref(), Some("Бэкенд"));
        assert_eq!((page.total, page.next), (51, Some(50)));

        let r = bitrix_add_comment(secret, "101".into(), "Готово, отчёт приложен".into(), true).await.unwrap();
        assert_eq!(r.comment_id, "555");
        assert!(r.result_added && r.result_error.is_none());
    }

    #[tokio::test]
    async fn task_detail_marks_results_and_survives_missing_comments() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/rest/17/hookcode/tasks.task.get.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "result": { "task": { "id": "101", "title": "Отчёт", "status": "3", "description": "Собрать данные" } } })))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/rest/17/hookcode/task.commentitem.getlist.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "result": [
                { "ID": "7", "AUTHOR_ID": "17", "AUTHOR_NAME": "Иван", "POST_MESSAGE": "Сделано", "POST_DATE": "2026-10-27T11:00:00+03:00" },
                { "ID": "6", "AUTHOR_ID": "5", "AUTHOR_NAME": "Мария", "POST_MESSAGE": "Когда будет?", "POST_DATE": "2026-10-26T11:00:00+03:00" }
            ] })))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/rest/17/hookcode/tasks.task.result.list.json"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({ "error": "ERROR_METHOD_NOT_FOUND" })))
            .mount(&server).await;
        let d = bitrix_get_task(with_secret(&server.uri(), "bitrix-test-2"), "101".into()).await.unwrap();
        assert_eq!(d.task.description.as_deref(), Some("Собрать данные"));
        assert_eq!(d.comments.len(), 2);
        assert_eq!(d.warnings.len(), 1, "нет метода результатов — предупреждение, а не ошибка");
    }
}
