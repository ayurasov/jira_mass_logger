// Клиент для работы с Jira REST API v3 (Cloud) и v2 (Server/Data Center).
//
// Возможности:
//  - проверка подключения (`test_connection`)
//  - автокомплит проектов и задач (`get_projects`, `get_issues_by_jql`)
//  - получение существующих worklog по задаче/за период (`get_worklog`,
//    `get_worklogs_since`, использующий `worklog/updated` + `worklog/list`)
//  - CRUD по worklog (`add_worklog`, `update_worklog`, `delete_worklog`)
//  - массовая отправка (`bulk_add_worklogs`) с ограничением параллелизма,
//    учётом 429/Retry-After и retry с экспоненциальной задержкой
//  - конвертация комментария worklog в Atlassian Document Format (ADF) для Cloud
//  - HTTP-клиент на rustls (без native-tls/OpenSSL), с поддержкой
//    корпоративного прокси (переменные окружения + явные настройки из UI)
//    и доверенного корпоративного root CA (SSL-инспекция на прокси)
//  - формирование `started` с учётом IANA-таймзоны пользователя (chrono-tz)
//  - оптимистичная конкурентность по полю `updated`: перед PUT/DELETE можно
//    передать `expected_updated`, полученный при последнем чтении записи;
//    если в Jira запись изменилась параллельно (например, коллега/сам
//    пользователь правил worklog прямо в Jira), команда вернёт ошибку с
//    префиксом "CONFLICT:" и JSON актуальной версии записи, чтобы фронтенд
//    показал diff и дал выбрать, какую версию оставить.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::time::sleep;

// ---------------------------------------------------------------------------
// Конфигурация подключения
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JiraInstanceType {
    Cloud,
    Server,
    ServerBasic,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JiraConnectionParams {
    pub base_url: String,
    pub email: String,
    pub secret_ref: String,
    pub instance_type: JiraInstanceType,
    pub extra_root_ca_pem_path: Option<String>,
    pub proxy: Option<ProxyConfig>,
    pub user_timezone: Option<String>,
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum JiraError {
    #[error("{0}")]
    Http(String),
    #[error("Jira API error {status}: {body}")]
    Api { status: u16, body: String },
    #[error("Rate limited, retries exhausted")]
    RateLimited,
    #[error("Secret not found for ref {0}")]
    SecretNotFound(String),
    #[error("Invalid timezone: {0}")]
    InvalidTimezone(String),
    #[error("CONFLICT:{0}")]
    Conflict(String),
    #[error("Other: {0}")]
    Other(String),
}

impl From<reqwest::Error> for JiraError {
    fn from(e: reqwest::Error) -> Self {
        JiraError::Http(humanize_reqwest_error(&e))
    }
}

impl From<JiraError> for String {
    fn from(e: JiraError) -> String {
        e.to_string()
    }
}

fn humanize_reqwest_error(e: &reqwest::Error) -> String {
    let raw = e.to_string();
    let lower = raw.to_lowercase();

    log::debug!("[jira_client] reqwest error raw: {raw}");
    eprintln!("[jira_client][ERROR] reqwest raw: {raw}");
    eprintln!("[jira_client][ERROR] is_connect={} is_timeout={} is_builder={} is_redirect={} is_status={}",
        e.is_connect(), e.is_timeout(), e.is_builder(), e.is_redirect(), e.is_status());
    if let Some(status) = e.status() { eprintln!("[jira_client][ERROR] HTTP status: {status}"); }
    if let Some(url) = e.url() { eprintln!("[jira_client][ERROR] URL: {url}"); }

    if lower.contains("certificate") || lower.contains("tls") || lower.contains("ssl")
        || lower.contains("rustls") || lower.contains("invalid cert")
        || lower.contains("hostname") || lower.contains("handshake")
    {
        return format!(
            "Ошибка TLS/сертификата. \
             Если сервер использует самоподписанный или корпоративный сертификат, \
             включите опцию \"Не проверять TLS-сертификат\".\nСырая ошибка: {raw}"
        );
    }

    if e.is_timeout() {
        let url = e.url().map(|u| u.to_string()).unwrap_or_default();
        return format!(
            "Превышено время ожидания ответа от сервера ({url}).\nСырая ошибка: {raw}"
        );
    }

    if e.is_connect() {
        let url = e.url().map(|u| u.to_string()).unwrap_or_default();
        if lower.contains("refused") {
            return format!("Подключение отклонено сервером ({url}).\nСырая ошибка: {raw}");
        }
        if lower.contains("no route") || lower.contains("network unreachable") {
            return format!("Нет маршрута до сервера ({url}).\nСырая ошибка: {raw}");
        }
        if lower.contains("dns") || lower.contains("resolve") || lower.contains("lookup") {
            return format!("Не удалось разрешить DNS-имя сервера ({url}).\nСырая ошибка: {raw}");
        }
        return format!("Не удалось установить соединение с {url}.\nСырая ошибка: {raw}");
    }

    if e.is_builder() {
        return format!("Некорректный URL или параметры подключения.\nСырая ошибка: {raw}");
    }

    format!("Ошибка HTTP: {raw}")
}

// ---------------------------------------------------------------------------
// HTTP-клиент
// ---------------------------------------------------------------------------

fn build_http_client(params: &JiraConnectionParams) -> Result<reqwest::Client, JiraError> {
    eprintln!(
        "[jira_client] build_http_client: url={} instance_type={:?} accept_invalid_certs={}",
        params.base_url, params.instance_type, params.accept_invalid_certs
    );

    let mut builder = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(30));

    if params.accept_invalid_certs {
        eprintln!("[jira_client] TLS verification DISABLED (accept_invalid_certs=true)");
        builder = builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }

    if let Some(path) = &params.extra_root_ca_pem_path {
        let pem = std::fs::read(path)
            .map_err(|e| JiraError::Other(format!("cannot read root CA {path}: {e}")))?;
        let cert = reqwest::Certificate::from_pem(&pem)
            .map_err(|e| JiraError::Other(format!("invalid root CA pem: {e}")))?;
        builder = builder.add_root_certificate(cert);
    }

    // Приоритет: явный прокси из UI -> ENV -> системный WinINet
    let proxy_url = params
        .proxy
        .as_ref()
        .and_then(|p| p.url.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HTTPS_PROXY").ok())
        .or_else(|| std::env::var("https_proxy").ok())
        .or_else(|| std::env::var("HTTP_PROXY").ok())
        .or_else(|| std::env::var("http_proxy").ok())
        .or_else(read_windows_system_proxy);

    if let Some(ref url) = proxy_url {
        eprintln!("[jira_client] using proxy: {url}");
        let mut proxy = reqwest::Proxy::all(url)
            .map_err(|e| JiraError::Other(format!("invalid proxy url '{url}': {e}")))?;
        if let Some(cfg) = &params.proxy {
            if let (Some(user), Some(pass)) = (&cfg.username, &cfg.password) {
                proxy = proxy.basic_auth(user, pass);
            }
        }
        builder = builder.proxy(proxy);
    } else {
        eprintln!("[jira_client] no proxy configured");
        // Явно отключаем автоподхват прокси из окружения, чтобы не проходило через случайный прокси
        builder = builder.no_proxy();
    }

    let client = builder
        .build()
        .map_err(|e| JiraError::Other(format!("cannot build http client: {e}")));
    if client.is_ok() { eprintln!("[jira_client] http client built successfully"); }
    client
}

/// Читаем системный прокси Windows через WinINet/реестр.
///
/// Формат вывода `reg query`:
///     HKCU\...ИмяКлюча
///         ИмяЗначения    REG_SZ    Данные
///
/// Требуется брать часть после "REG_SZ", а не последнее слово строки
/// (иначе получаем "REG_SZ" вместо значения при пустом значении или если значение
/// совпадает с последним токеном строки).
///
/// Также проверяем ProxyEnable=1, чтобы не использовать прокси когда он отключён.
#[cfg(target_os = "windows")]
fn read_windows_system_proxy() -> Option<String> {
    use std::process::Command;

    // Проверяем, включён ли прокси (ProxyEnable = 1)
    let enable_output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v", "ProxyEnable",
        ])
        .output()
        .ok()?;
    let enable_text = String::from_utf8_lossy(&enable_output.stdout);
    let proxy_enabled = enable_text
        .lines()
        .find(|l| l.contains("ProxyEnable"))
        .and_then(|line| parse_reg_value(line))
        .map(|v| v.trim() == "0x1")
        .unwrap_or(false);

    if !proxy_enabled {
        eprintln!("[jira_client] Windows system proxy: ProxyEnable=0, skipping");
        return None;
    }

    // Читаем ProxyServer
    let server_output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v", "ProxyServer",
        ])
        .output()
        .ok()?;
    if !server_output.status.success() {
        return None;
    }
    let server_text = String::from_utf8_lossy(&server_output.stdout);
    let value = server_text
        .lines()
        .find(|l| l.contains("ProxyServer"))
        .and_then(|line| parse_reg_value(line))?;

    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    eprintln!("[jira_client] Windows system proxy value: '{value}'");
    if value.starts_with("http://") || value.starts_with("https://") {
        Some(value.to_string())
    } else {
        Some(format!("http://{value}"))
    }
}

/// Извлекает значение из строки вывода `reg query`:
///   "    Имя    REG_SZ    Значение"
/// Возвращает текст после типа данных (REG_SZ, REG_DWORD, ...).
/// Если значения нет (тип последний токен) — возвращает None.
#[cfg(target_os = "windows")]
fn parse_reg_value(line: &str) -> Option<String> {
    // Строка: "    ProxyServer    REG_SZ    proxy.corp.local:8080"
    // Ищем REG_* тип и берём всё что после него.
    // Типы: REG_SZ, REG_DWORD, REG_EXPAND_SZ, REG_BINARY...
    let types = ["REG_SZ", "REG_DWORD", "REG_EXPAND_SZ", "REG_BINARY", "REG_MULTI_SZ", "REG_QWORD"];
    for t in &types {
        if let Some(pos) = line.find(t) {
            let after = &line[pos + t.len()..];
            let value = after.trim();
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn read_windows_system_proxy() -> Option<String> {
    None
}

fn get_secret(secret_ref: &str) -> Result<String, JiraError> {
    let entry = keyring::Entry::new("jiratime", secret_ref)
        .map_err(|e| JiraError::Other(e.to_string()))?;
    entry
        .get_password()
        .map_err(|_| JiraError::SecretNotFound(secret_ref.to_string()))
}

fn api_base(params: &JiraConnectionParams) -> &'static str {
    match params.instance_type {
        JiraInstanceType::Cloud => "rest/api/3",
        JiraInstanceType::Server | JiraInstanceType::ServerBasic => "rest/api/2",
    }
}

fn apply_auth(
    req: reqwest::RequestBuilder,
    params: &JiraConnectionParams,
    token: &str,
) -> reqwest::RequestBuilder {
    match params.instance_type {
        JiraInstanceType::Cloud => req.basic_auth(&params.email, Some(token)),
        JiraInstanceType::Server => req.bearer_auth(token),
        JiraInstanceType::ServerBasic => req.basic_auth(&params.email, Some(token)),
    }
}

fn url(params: &JiraConnectionParams, path: &str) -> String {
    format!(
        "{}/{}/{}",
        params.base_url.trim_end_matches('/'),
        api_base(params),
        path.trim_start_matches('/')
    )
}

// ---------------------------------------------------------------------------
// ADF
// ---------------------------------------------------------------------------

pub fn text_to_adf(text: &str) -> Value {
    let paragraphs: Vec<Value> = text
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .map(|line| json!({ "type": "paragraph", "content": [{ "type": "text", "text": line }] }))
        .collect();
    let content = if paragraphs.is_empty() {
        vec![json!({ "type": "paragraph", "content": [] })]
    } else {
        paragraphs
    };
    json!({ "type": "doc", "version": 1, "content": content })
}

pub fn adf_to_plain_text(value: &Value) -> String {
    fn walk(node: &Value, out: &mut String) {
        if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
            out.push_str(text);
        }
        if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
            for child in content { walk(child, out); }
            if node.get("type").and_then(|t| t.as_str()) == Some("paragraph") {
                out.push('\n');
            }
        }
    }
    match value {
        Value::String(s) => s.clone(),
        Value::Object(_) => {
            let mut out = String::new();
            walk(value, &mut out);
            out.trim_end().to_string()
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn comment_payload(instance_type: JiraInstanceType, comment: Option<&str>) -> Option<Value> {
    let comment = comment?;
    if comment.trim().is_empty() { return None; }
    Some(match instance_type {
        JiraInstanceType::Cloud => text_to_adf(comment),
        JiraInstanceType::Server | JiraInstanceType::ServerBasic => Value::String(comment.to_string()),
    })
}

// ---------------------------------------------------------------------------
// Таймзона
// ---------------------------------------------------------------------------

pub fn format_started(instant_utc: DateTime<Utc>, timezone: &str) -> Result<String, JiraError> {
    let tz: Tz = timezone
        .parse()
        .map_err(|_| JiraError::InvalidTimezone(timezone.to_string()))?;
    let local = instant_utc.with_timezone(&tz);
    Ok(local.format("%Y-%m-%dT%H:%M:%S%.3f%z").to_string())
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectDto {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IssueDto {
    pub id: String,
    pub key: String,
    pub summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorklogDto {
    pub id: String,
    pub issue_key: Option<String>,
    pub started: String,
    pub time_spent_seconds: i64,
    pub comment: Option<String>,
    pub author: Option<String>,
    pub updated: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NewWorklogEntry {
    pub issue_key: String,
    pub started_at: DateTime<Utc>,
    pub time_spent_seconds: i64,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BulkResultItem {
    pub issue_key: String,
    pub success: bool,
    pub worklog_id: Option<String>,
    pub error: Option<String>,
    pub attempts: u32,
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

const MAX_RETRIES: u32 = 5;
const BASE_BACKOFF_MS: u64 = 500;

async fn send_with_retry(
    #[allow(unused_variables)]
    client: &reqwest::Client,
    mut build_request: impl FnMut() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, JiraError> {
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let response = build_request().send().await;
        match response {
            Ok(resp) => {
                let status = resp.status();
                if status.as_u16() == 429 {
                    if attempt >= MAX_RETRIES { return Err(JiraError::RateLimited); }
                    let retry_after_secs = resp
                        .headers().get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok());
                    let delay_ms = retry_after_secs
                        .map(|s| s * 1000)
                        .unwrap_or_else(|| BASE_BACKOFF_MS * 2u64.pow(attempt - 1));
                    sleep(Duration::from_millis(delay_ms)).await;
                    continue;
                }
                if status.is_server_error() {
                    if attempt >= MAX_RETRIES {
                        let body = resp.text().await.unwrap_or_default();
                        return Err(JiraError::Api { status: status.as_u16(), body });
                    }
                    sleep(Duration::from_millis(BASE_BACKOFF_MS * 2u64.pow(attempt - 1))).await;
                    continue;
                }
                if !status.is_success() {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(JiraError::Api { status: status.as_u16(), body });
                }
                return Ok(resp);
            }
            Err(e) => {
                let raw = e.to_string();
                let lower = raw.to_lowercase();
                let is_tls = lower.contains("certificate") || lower.contains("tls")
                    || lower.contains("ssl") || lower.contains("rustls")
                    || lower.contains("hostname") || lower.contains("handshake");
                // Ретраем только таймауты; TLS и connect-ошибки не поможет retry
                let no_retry = is_tls || e.is_connect() || !e.is_timeout();
                if attempt >= MAX_RETRIES || no_retry {
                    return Err(JiraError::from(e));
                }
                sleep(Duration::from_millis(BASE_BACKOFF_MS * 2u64.pow(attempt - 1))).await;
            }
        }
    }
}

struct AuthedClient {
    client: reqwest::Client,
    token: String,
}

fn init(params: &JiraConnectionParams) -> Result<AuthedClient, JiraError> {
    let client = build_http_client(params)?;
    let token = get_secret(&params.secret_ref)?;
    Ok(AuthedClient { client, token })
}

// ---------------------------------------------------------------------------
// Tauri-команды
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn test_connection(params: JiraConnectionParams) -> Result<bool, String> {
    eprintln!(
        "[jira_client] test_connection START: url={} instance_type={:?} accept_invalid_certs={}",
        params.base_url, params.instance_type, params.accept_invalid_certs
    );
    let ctx = init(&params).map_err(|e| {
        eprintln!("[jira_client] test_connection init error: {e}");
        String::from(e)
    })?;
    let endpoint = url(&params, "myself");
    eprintln!("[jira_client] test_connection endpoint: {endpoint}");
    let result = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.get(&endpoint), &params, &ctx.token)
    }).await;
    match result {
        Ok(resp) => {
            eprintln!("[jira_client] test_connection OK, HTTP status: {}", resp.status());
            Ok(resp.status().is_success())
        }
        Err(e) => {
            eprintln!("[jira_client] test_connection FAILED: {e}");
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn get_projects(params: JiraConnectionParams) -> Result<Vec<ProjectDto>, String> {
    let ctx = init(&params).map_err(String::from)?;
    let endpoint = url(&params, "project/search");
    let resp = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.get(&endpoint), &params, &ctx.token)
            .query(&[("maxResults", "200")])
    }).await.map_err(String::from)?;
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let values = body.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(values.into_iter().filter_map(|v| Some(ProjectDto {
        id: v.get("id")?.as_str()?.to_string(),
        key: v.get("key")?.as_str()?.to_string(),
        name: v.get("name")?.as_str().unwrap_or_default().to_string(),
    })).collect())
}

#[tauri::command]
pub async fn get_issues_by_jql(
    params: JiraConnectionParams,
    jql: String,
) -> Result<Vec<IssueDto>, String> {
    let ctx = init(&params).map_err(String::from)?;
    let (endpoint, body) = match params.instance_type {
        JiraInstanceType::Cloud => (
            url(&params, "search/jql"),
            json!({ "jql": jql, "maxResults": 50, "fields": ["summary"] }),
        ),
        JiraInstanceType::Server | JiraInstanceType::ServerBasic => (
            url(&params, "search"),
            json!({ "jql": jql, "maxResults": 50, "fields": ["summary"] }),
        ),
    };
    let resp = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.post(&endpoint), &params, &ctx.token).json(&body)
    }).await.map_err(String::from)?;
    let payload: Value = resp.json().await.map_err(|e| e.to_string())?;
    let issues = payload.get("issues").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(issues.into_iter().filter_map(|v| Some(IssueDto {
        id: v.get("id")?.as_str()?.to_string(),
        key: v.get("key")?.as_str()?.to_string(),
        summary: v.get("fields").and_then(|f| f.get("summary")).and_then(|s| s.as_str()).map(|s| s.to_string()),
    })).collect())
}

#[tauri::command]
pub async fn get_worklog(
    params: JiraConnectionParams,
    issue_key: String,
) -> Result<Vec<WorklogDto>, String> {
    let ctx = init(&params).map_err(String::from)?;
    let endpoint = url(&params, &format!("issue/{issue_key}/worklog"));
    let resp = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.get(&endpoint), &params, &ctx.token)
    }).await.map_err(String::from)?;
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let worklogs = body.get("worklogs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(parse_worklogs(worklogs, Some(&issue_key)))
}

#[tauri::command]
pub async fn get_worklog_by_id(
    params: JiraConnectionParams,
    issue_key: String,
    worklog_id: String,
) -> Result<WorklogDto, String> {
    let ctx = init(&params).map_err(String::from)?;
    let endpoint = url(&params, &format!("issue/{issue_key}/worklog/{worklog_id}"));
    let resp = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.get(&endpoint), &params, &ctx.token)
    }).await.map_err(String::from)?;
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    parse_worklogs(vec![body], Some(&issue_key))
        .into_iter().next()
        .ok_or_else(|| "worklog payload could not be parsed".to_string())
}

#[tauri::command]
pub async fn get_worklogs_since(
    params: JiraConnectionParams,
    since_epoch_millis: i64,
    issue_keys_for_fallback: Option<Vec<String>>,
) -> Result<Vec<WorklogDto>, String> {
    let ctx = init(&params).map_err(String::from)?;
    if matches!(params.instance_type, JiraInstanceType::Server | JiraInstanceType::ServerBasic) {
        let mut all = Vec::new();
        for key in issue_keys_for_fallback.unwrap_or_default() {
            let endpoint = url(&params, &format!("issue/{key}/worklog"));
            let resp = send_with_retry(&ctx.client, || {
                apply_auth(ctx.client.get(&endpoint), &params, &ctx.token)
            }).await.map_err(String::from)?;
            let body: Value = resp.json().await.map_err(|e| e.to_string())?;
            let worklogs = body.get("worklogs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            all.extend(parse_worklogs(worklogs, Some(&key)));
        }
        return Ok(all);
    }
    let mut all_ids: Vec<i64> = Vec::new();
    let mut since = since_epoch_millis;
    loop {
        let endpoint = url(&params, "worklog/updated");
        let resp = send_with_retry(&ctx.client, || {
            apply_auth(ctx.client.get(&endpoint), &params, &ctx.token)
                .query(&[("since", since.to_string())])
        }).await.map_err(String::from)?;
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        let values = body.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for v in &values {
            if let Some(id) = v.get("worklogId").and_then(|x| x.as_i64()) { all_ids.push(id); }
        }
        let last_page = body.get("lastPage").and_then(|v| v.as_bool()).unwrap_or(true);
        if last_page || values.is_empty() { break; }
        since = body.get("until").and_then(|v| v.as_i64()).unwrap_or(since);
    }
    if all_ids.is_empty() { return Ok(Vec::new()); }
    let mut all = Vec::new();
    for chunk in all_ids.chunks(1000) {
        let endpoint = url(&params, "worklog/list");
        let ids_body = json!({ "ids": chunk });
        let resp = send_with_retry(&ctx.client, || {
            apply_auth(ctx.client.post(&endpoint), &params, &ctx.token).json(&ids_body)
        }).await.map_err(String::from)?;
        let arr: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
        all.extend(parse_worklogs(arr, None));
    }
    Ok(all)
}

fn parse_worklogs(values: Vec<Value>, fallback_issue_key: Option<&str>) -> Vec<WorklogDto> {
    values.into_iter().filter_map(|v| {
        let id = v.get("id")?.as_str()?.to_string();
        let started = v.get("started")?.as_str()?.to_string();
        let time_spent_seconds = v.get("timeSpentSeconds").and_then(|x| x.as_i64()).unwrap_or(0);
        let comment = v.get("comment").map(adf_to_plain_text);
        let author = v.get("author").and_then(|a| a.get("displayName")).and_then(|d| d.as_str()).map(|s| s.to_string());
        let updated = v.get("updated").and_then(|x| x.as_str()).map(|s| s.to_string());
        let issue_key = v.get("issueId").and_then(|x| x.as_str()).map(|s| s.to_string())
            .or_else(|| fallback_issue_key.map(|s| s.to_string()));
        Some(WorklogDto { id, issue_key, started, time_spent_seconds, comment, author, updated })
    }).collect()
}

#[tauri::command]
pub async fn add_worklog(
    params: JiraConnectionParams,
    issue_key: String,
    started_at: DateTime<Utc>,
    time_spent_seconds: i64,
    comment: Option<String>,
) -> Result<String, String> {
    let ctx = init(&params).map_err(String::from)?;
    let tz = params.user_timezone.clone().unwrap_or_else(|| "UTC".to_string());
    let started = format_started(started_at, &tz).map_err(String::from)?;
    let mut body = json!({ "started": started, "timeSpentSeconds": time_spent_seconds });
    if let Some(c) = comment_payload(params.instance_type, comment.as_deref()) { body["comment"] = c; }
    let endpoint = url(&params, &format!("issue/{issue_key}/worklog"));
    let resp = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.post(&endpoint), &params, &ctx.token).json(&body)
    }).await.map_err(String::from)?;
    let payload: Value = resp.json().await.map_err(|e| e.to_string())?;
    payload.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
        .ok_or_else(|| "worklog id missing in response".to_string())
}

#[tauri::command]
pub async fn update_worklog(
    params: JiraConnectionParams,
    issue_key: String,
    worklog_id: String,
    started_at: Option<DateTime<Utc>>,
    time_spent_seconds: Option<i64>,
    comment: Option<String>,
    expected_updated: Option<String>,
) -> Result<(), String> {
    let ctx = init(&params).map_err(String::from)?;
    if let Some(expected) = &expected_updated {
        let current = get_worklog_by_id(params.clone(), issue_key.clone(), worklog_id.clone()).await?;
        if current.updated.as_deref() != Some(expected.as_str()) {
            let snapshot = serde_json::to_string(&current).unwrap_or_default();
            return Err(JiraError::Conflict(snapshot).into());
        }
    }
    let mut body = json!({});
    if let Some(started_at) = started_at {
        let tz = params.user_timezone.clone().unwrap_or_else(|| "UTC".to_string());
        body["started"] = json!(format_started(started_at, &tz).map_err(String::from)?);
    }
    if let Some(secs) = time_spent_seconds { body["timeSpentSeconds"] = json!(secs); }
    if let Some(c) = comment_payload(params.instance_type, comment.as_deref()) { body["comment"] = c; }
    let endpoint = url(&params, &format!("issue/{issue_key}/worklog/{worklog_id}"));
    send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.put(&endpoint), &params, &ctx.token).json(&body)
    }).await.map_err(String::from)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_worklog(
    params: JiraConnectionParams,
    issue_key: String,
    worklog_id: String,
    expected_updated: Option<String>,
) -> Result<(), String> {
    let ctx = init(&params).map_err(String::from)?;
    if let Some(expected) = &expected_updated {
        let current = get_worklog_by_id(params.clone(), issue_key.clone(), worklog_id.clone()).await?;
        if current.updated.as_deref() != Some(expected.as_str()) {
            let snapshot = serde_json::to_string(&current).unwrap_or_default();
            return Err(JiraError::Conflict(snapshot).into());
        }
    }
    let endpoint = url(&params, &format!("issue/{issue_key}/worklog/{worklog_id}"));
    send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.delete(&endpoint), &params, &ctx.token)
    }).await.map_err(String::from)?;
    Ok(())
}

const BULK_CONCURRENCY: usize = 4;

#[tauri::command]
pub async fn bulk_add_worklogs(
    params: JiraConnectionParams,
    entries: Vec<NewWorklogEntry>,
) -> Result<Vec<BulkResultItem>, String> {
    let ctx = Arc::new(init(&params).map_err(String::from)?);
    let params = Arc::new(params);
    let semaphore = Arc::new(Semaphore::new(BULK_CONCURRENCY));
    let mut handles = Vec::with_capacity(entries.len());
    for entry in entries {
        let ctx = ctx.clone();
        let params = params.clone();
        let semaphore = semaphore.clone();
        handles.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await.expect("semaphore closed");
            add_single_with_attempts(&ctx.client, &ctx.token, &params, &entry).await
        }));
    }
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        results.push(handle.await.unwrap_or_else(|e| BulkResultItem {
            issue_key: "unknown".to_string(),
            success: false,
            worklog_id: None,
            error: Some(format!("task panicked: {e}")),
            attempts: 0,
        }));
    }
    Ok(results)
}

async fn add_single_with_attempts(
    #[allow(unused_variables)]
    client: &reqwest::Client,
    token: &str,
    params: &JiraConnectionParams,
    entry: &NewWorklogEntry,
) -> BulkResultItem {
    let tz = params.user_timezone.clone().unwrap_or_else(|| "UTC".to_string());
    let started = match format_started(entry.started_at, &tz) {
        Ok(s) => s,
        Err(e) => return BulkResultItem {
            issue_key: entry.issue_key.clone(), success: false,
            worklog_id: None, error: Some(e.to_string()), attempts: 0,
        },
    };
    let mut body = json!({ "started": started, "timeSpentSeconds": entry.time_spent_seconds });
    if let Some(c) = comment_payload(params.instance_type, entry.comment.as_deref()) { body["comment"] = c; }
    let endpoint = url(params, &format!("issue/{}/worklog", entry.issue_key));
    let mut attempts = 0u32;
    let result = send_with_retry(client, || {
        attempts += 1;
        apply_auth(client.post(&endpoint), params, token).json(&body)
    }).await;
    match result {
        Ok(resp) => match resp.json::<Value>().await {
            Ok(payload) => {
                let id = payload.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
                BulkResultItem { issue_key: entry.issue_key.clone(), success: id.is_some(), worklog_id: id, error: None, attempts }
            }
            Err(e) => BulkResultItem { issue_key: entry.issue_key.clone(), success: false, worklog_id: None, error: Some(format!("invalid response json: {e}")), attempts },
        },
        Err(e) => BulkResultItem { issue_key: entry.issue_key.clone(), success: false, worklog_id: None, error: Some(e.to_string()), attempts },
    }
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn text_to_adf_wraps_single_line_as_paragraph() {
        let adf = text_to_adf("Fixed the bug");
        assert_eq!(adf["type"], "doc");
        assert_eq!(adf["content"][0]["type"], "paragraph");
        assert_eq!(adf["content"][0]["content"][0]["text"], "Fixed the bug");
    }

    #[test]
    fn text_to_adf_splits_multiline_into_paragraphs() {
        let adf = text_to_adf("line one\nline two\n\nline three");
        let content = adf["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[1]["content"][0]["text"], "line two");
    }

    #[test]
    fn text_to_adf_empty_string_produces_empty_paragraph() {
        let adf = text_to_adf("");
        assert_eq!(adf["content"][0]["type"], "paragraph");
        assert_eq!(adf["content"][0]["content"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn adf_to_plain_text_extracts_text_nodes() {
        let adf = json!({
            "type": "doc", "version": 1,
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "hello" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "world" }] }
            ]
        });
        assert_eq!(adf_to_plain_text(&adf), "hello\nworld");
    }

    #[test]
    fn adf_to_plain_text_passthrough_for_plain_string() {
        assert_eq!(adf_to_plain_text(&Value::String("plain comment".to_string())), "plain comment");
    }

    #[test]
    fn format_started_respects_timezone_offset() {
        let instant = DateTime::parse_from_rfc3339("2026-01-15T10:00:00Z").unwrap().with_timezone(&Utc);
        assert!(format_started(instant, "Europe/Moscow").unwrap().starts_with("2026-01-15T13:00:00.000+0300"));
    }

    #[test]
    fn format_started_rejects_invalid_timezone() {
        assert!(format_started(Utc::now(), "Not/AZone").is_err());
    }

    #[test]
    fn humanize_reqwest_error_tls_message_is_actionable() {
        let msg = "error sending request for url (https://jira.corp.local:8443/rest/api/2/myself): \
                   error trying to connect: invalid certificate: UnknownIssuer";
        assert!(msg.to_lowercase().contains("certificate"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_reg_value_extracts_after_reg_sz() {
        let line = "    ProxyServer    REG_SZ    proxy.corp.local:8080";
        assert_eq!(super::parse_reg_value(line), Some("proxy.corp.local:8080".to_string()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_reg_value_empty_value_returns_empty_string() {
        let line = "    ProxyServer    REG_SZ    ";
        assert_eq!(super::parse_reg_value(line), Some("".to_string()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_reg_value_dword() {
        let line = "    ProxyEnable    REG_DWORD    0x1";
        assert_eq!(super::parse_reg_value(line), Some("0x1".to_string()));
    }

    fn test_params(base_url: String, instance_type: JiraInstanceType) -> JiraConnectionParams {
        JiraConnectionParams {
            base_url, email: "user@example.com".to_string(),
            secret_ref: "test-secret-ref".to_string(), instance_type,
            extra_root_ca_pem_path: None, proxy: None,
            user_timezone: Some("UTC".to_string()), accept_invalid_certs: false,
        }
    }

    #[test]
    fn apply_auth_server_basic_uses_basic_auth_not_bearer() {
        let params = test_params("http://jira.corp.local".to_string(), JiraInstanceType::ServerBasic);
        assert_eq!(params.instance_type, JiraInstanceType::ServerBasic);
    }

    #[tokio::test]
    async fn send_with_retry_retries_on_429_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/rest/api/3/myself"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .up_to_n_times(1).expect(1).mount(&server).await;
        Mock::given(method("GET")).and(path("/rest/api/3/myself"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"accountId": "abc"})))
            .expect(1).mount(&server).await;
        let client = reqwest::Client::builder().use_rustls_tls().build().unwrap();
        let params = test_params(server.uri(), JiraInstanceType::Cloud);
        let endpoint = url(&params, "myself");
        let resp = send_with_retry(&client, || client.get(&endpoint)).await.unwrap();
        assert!(resp.status().is_success());
    }

    #[tokio::test]
    async fn send_with_retry_gives_up_after_max_retries_on_persistent_429() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/rest/api/3/myself"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .mount(&server).await;
        let client = reqwest::Client::builder().use_rustls_tls().build().unwrap();
        let params = test_params(server.uri(), JiraInstanceType::Cloud);
        let endpoint = url(&params, "myself");
        let result = send_with_retry(&client, || client.get(&endpoint)).await;
        assert!(matches!(result, Err(JiraError::RateLimited)));
    }

    #[tokio::test]
    async fn send_with_retry_propagates_client_error_without_retry() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/rest/api/3/myself"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .expect(1).mount(&server).await;
        let client = reqwest::Client::builder().use_rustls_tls().build().unwrap();
        let params = test_params(server.uri(), JiraInstanceType::Cloud);
        let endpoint = url(&params, "myself");
        let result = send_with_retry(&client, || client.get(&endpoint)).await;
        match result {
            Err(JiraError::Api { status, .. }) => assert_eq!(status, 401),
            other => panic!("expected Api(401), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_connection_server_basic_uses_rest_api_v2() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/rest/api/2/myself"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"name": "ayurasov"})))
            .expect(1).mount(&server).await;
        let params = JiraConnectionParams {
            base_url: server.uri(), email: "ayurasov".to_string(),
            secret_ref: "test-basic-ref".to_string(),
            instance_type: JiraInstanceType::ServerBasic,
            extra_root_ca_pem_path: None, proxy: None,
            user_timezone: Some("Europe/Moscow".to_string()), accept_invalid_certs: false,
        };
        assert_eq!(url(&params, "myself"), format!("{}/rest/api/2/myself", server.uri()));
    }
}
