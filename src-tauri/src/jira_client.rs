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

/// Безопасно обрезает строку до max_chars символов по char-boundary
/// (избегает panic при срезе многобайтовых UTF-8 последовательностей).
pub(crate) fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
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
    // Test-only escape-hatch: в sandbox-среде без keyring интеграционные тесты могут
    // подставить секрет через переменную окружения. Компилируется ТОЛЬКО в test-сборке
    // (#[cfg(test)]) — в production-бинарнике этот код вообще отсутствует, поэтому нельзя
    // подменить реальный keyring через env у пользователя.
    #[cfg(test)]
    {
        let env_key = format!("JIRATIME_TEST_SECRET_{}", secret_ref.to_uppercase().replace('-', "_"));
        if let Ok(tok) = std::env::var(&env_key) {
            return Ok(tok);
        }
    }
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

/// Диапазон дат для JQL-fallback (когда bulk worklog/updated возвращает пусто).
/// Позволяет искать задачи через `worklogAuthor = currentUser() AND worklogDate >= ... AND <= ...`
/// и потом забирать worklog по каждой задаче отдельно. Фронтенд передаёт
/// выбранный пользователем период из фильтров таблицы.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorklogDateRange {
    pub date_from: String, // YYYY-MM-DD
    pub date_to: String,   // YYYY-MM-DD
    pub issue_filter: Option<String>, // проект-ключ или ключ задачи (SRM, SRM-123)
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

/// Минимальный набор идентификаторов текущего пользователя из `/myself`.
/// Cloud отдаёт `accountId`; Server/DC отдаёт `key`/`name`+`displayName`+`emailAddress` (нет accountId).
struct MyselfInfo {
    account_id: Option<String>,
    key: Option<String>,
    name: Option<String>,
    display_name: Option<String>,
    email: Option<String>,
}

async fn fetch_myself(ctx: &AuthedClient, params: &JiraConnectionParams) -> Result<MyselfInfo, JiraError> {
    let ep = url(params, "myself");
    let resp = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.get(&ep), params, &ctx.token)
    }).await?;
    let v: Value = resp.json().await.map_err(JiraError::from)?;
    Ok(MyselfInfo {
        account_id: v.get("accountId").and_then(|x| x.as_str()).map(|s| s.to_string()),
        key: v.get("key").and_then(|x| x.as_str()).map(|s| s.to_string()),
        name: v.get("name").and_then(|x| x.as_str()).map(|s| s.to_string()),
        display_name: v.get("displayName").and_then(|x| x.as_str()).map(|s| s.to_string()),
        email: v.get("emailAddress").and_then(|x| x.as_str()).map(|s| s.to_string()),
    })
}

/// Cloud: worklog считается моим только при точном совпадении author.accountId.
/// Вынесена в функцию, чтобы production-код и тесты проверяли одну и ту же логику.
fn cloud_author_matches(v: &Value, my_account_id: &str) -> bool {
    v.get("author")
        .and_then(|a| a.get("accountId"))
        .and_then(|x| x.as_str())
        .map(|id| id == my_account_id)
        .unwrap_or(false)
}

/// Server/ServerBasic: собирает кандидаты для сопоставления автора worklog с текущим
/// пользователем. Берём ВСЕ идентификаторы из /myself (key/name/displayName/emailAddress/
/// accountId) плюс логин профиля (params.email — на самом деле логин для server_basic).
/// Пустые/пробельные строки отсеиваем после trim и дедуплицируем.
fn server_author_candidates(myself: &MyselfInfo, params_email: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![
        myself.key.clone(),
        myself.name.clone(),
        myself.display_name.clone(),
        myself.email.clone(),
        myself.account_id.clone(),
        Some(params_email.to_string()),
    ].into_iter().flatten()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Server/ServerBasic: сравнивает author.{key,name,displayName,emailAddress,accountId}
/// с кандидатами (без учёта регистра). Jira Server в worklog-объекте автора кладёт в
/// разные поля в зависимости от версии — проверяем все.
fn server_author_matches(v: &Value, candidates: &[String]) -> bool {
    let author = match v.get("author") { Some(a) => a, None => return false };
    for field in ["key", "name", "displayName", "emailAddress", "accountId"] {
        if let Some(val) = author.get(field).and_then(|x| x.as_str()) {
            let lv = val.to_lowercase();
            if candidates.iter().any(|c| c == &lv) { return true; }
        }
    }
    false
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
    date_range: Option<WorklogDateRange>,
) -> Result<Vec<WorklogDto>, String> {
    let ctx = init(&params).map_err(String::from)?;

    // Шаг 0. Обязательно определяем текущего пользователя через /myself.
    // worklog/updated + worklog/list возвращают worklog ВСЕХ пользователей —
    // без жёсткой фильтрации таблица «Мой worklog» показала бы чужие записи.
    // Cloud фильтрует по author.accountId, Server/DC — по key/name/displayName/emailAddress.
    let myself = fetch_myself(&ctx, &params).await
        .map_err(|e| format!("Не удалось получить текущего пользователя Jira (/myself): {e}"))?;

    let is_cloud = matches!(params.instance_type, JiraInstanceType::Cloud);
    let my_account_id = if is_cloud {
        Some(myself.account_id.clone().ok_or_else(|| {
            "Jira /myself не вернул accountId — невозможно отфильтровать только ваши worklog".to_string()
        })?)
    } else {
        None
    };
    let candidates = if is_cloud {
        Vec::new()
    } else {
        let c = server_author_candidates(&myself, &params.email);
        if c.is_empty() {
            return Err("Не удалось определить идентификатор пользователя (нет key/name/email в /myself и нет логина в профиле) — невозможно отфильтровать только ваши worklog".to_string());
        }
        c
    };

    // Шаг 1. Bulk-путь: worklog/updated → worklog/list.
    // Поддерживается и Cloud, и Jira Server/DC 7.6.1+ (раньше здесь был ошибочный
    // комментарий, что у Server нет этого эндпоинта — это приводило к тому, что при
    // пустом кэше задач таблица навсегда оставалась пустой).
    let bulk_result = fetch_bulk_worklogs(&ctx, &params, since_epoch_millis).await;

    let (raw_worklogs, used_fallback) = match bulk_result {
        Ok(v) => (v, false),
        Err(e) => {
            // Только 404/405 на bulk-эндпоинте означают старый Jira Server (<7.6) без
            // worklog/updated — тогда переключаемся на fallback по списку issue keys.
            // Другие ошибки (401/403 — auth, 500 — сервер) показываем как есть, иначе
            // пользователь снова увидит пустую таблицу вместо реальной причины.
            let is_endpoint_absent = e.contains("HTTP 404") || e.contains("HTTP 405");
            if !is_endpoint_absent {
                return Err(format!("Не удалось получить worklog из Jira: {e}. Проверьте логин/пароль и права на чтение worklog."));
            }
            // Старые Jira Server (<7.6) или отключённый эндпоинт — fallback на перебор
            // известных issue keys из кэша фронта. Этот путь хуже (только известные
            // задачи), но не оставляет пользователя без данных.
            let keys = issue_keys_for_fallback.unwrap_or_default();
            if keys.is_empty() {
                // Ни bulk, ни fallback не сработали — возвращаем исходную ошибку,
                // чтобы пользователь увидел причину, а не пустую таблицу.
                return Err(format!("Не удалось получить worklog (bulk worklog/updated недоступен: {e}), и список задач для fallback пуст — откройте задачу в Bulk Wizard или обновите Jira до 7.6+"));
            }
            let v = fetch_worklogs_by_issue_keys(&ctx, &params, &keys).await
                .map_err(|e| format!("Fallback по списку задач тоже не удался: {e}"))?;
            (v, true)
        }
    };

    // Шаг 1.5. JQL-fallback: bulk worklog/updated часто возвращает пусто на Jira
    // Server 8.x, даже когда записи существуют. Если bulk пуст и указан период —
    // ищем задачи через JQL по worklogAuthor=currentUser() и забираем worklog по
    // каждой задаче. Важно: это ДО раннего return Ok(empty) ниже.
    if raw_worklogs.is_empty() && date_range.is_some() {
        match fetch_worklogs_by_jql(&ctx, &params, &myself, date_range.as_ref().unwrap()).await {
            Ok(jql_worklogs) if !jql_worklogs.is_empty() => return Ok(jql_worklogs),
            Ok(_) => {
                let dr = date_range.as_ref().unwrap();
                return Err(format!(
                    "Jira вернула 0 worklog за период {}..{}. Bulk worklog/updated пуст, JQL-fallback тоже ничего не нашёл. Проверьте: есть ли записи в этом периоде, правильный ли пользователь ({}), есть ли права на чтение worklog.",
                    dr.date_from, dr.date_to, params.email
                ));
            }
            Err(e) => {
                // JQL-запрос завершился ошибкой (нет прав, 500, таймаут) — не прячем.
                return Err(format!("Bulk worklog/updated пуст, JQL-fallback не удался: {e}"));
            }
        }
    }

    if raw_worklogs.is_empty() {
        return Ok(Vec::new());
    }

    // Шаг 2. Жёсткая фильтрация «только мои».
    let my_worklogs: Vec<Value> = if is_cloud {
        let aid = my_account_id.as_deref().unwrap_or("");
        raw_worklogs.into_iter().filter(|v| cloud_author_matches(v, aid)).collect()
    } else {
        raw_worklogs.into_iter().filter(|v| server_author_matches(v, &candidates)).collect()
    };

    // Шаг 3. Резолюция numeric issueId → человекочитаемый issueKey.
    // bulk-путь (worklog/list) возвращает только числовой issueId — нужен /issue/{id}.
    // При fallback-пути ключ уже известен из issue_keys, parse_one_worklog его подставит.
    let mut issue_map: std::collections::HashMap<String, (String, Option<String>)> =
        std::collections::HashMap::new();
    if !used_fallback {
        let unique_issue_ids: Vec<String> = {
            let mut seen = std::collections::HashSet::new();
            my_worklogs.iter()
                .filter_map(|v| v.get("issueId").and_then(|x| x.as_str()).map(|s| s.to_string()))
                .filter(|id| seen.insert(id.clone()))
                .collect()
        };
        for issue_id in &unique_issue_ids {
            let ep = url(&params, &format!("issue/{}?fields=summary", issue_id));
            if let Ok(resp) = send_with_retry(&ctx.client, || {
                apply_auth(ctx.client.get(&ep), &params, &ctx.token)
            }).await {
                if let Ok(v) = resp.json::<Value>().await {
                    if let (Some(key), summary) = (
                        v.get("key").and_then(|k| k.as_str()).map(|s| s.to_string()),
                        v.get("fields").and_then(|f| f.get("summary")).and_then(|s| s.as_str()).map(|s| s.to_string()),
                    ) {
                        issue_map.insert(issue_id.clone(), (key, summary));
                    }
                }
            }
        }
    }

    // Шаг 4. Сборка DTO.
    let all = parse_worklogs_with_map(my_worklogs, &issue_map);

    if !all.is_empty() {
        return Ok(all);
    }

    // Шаг 5. JQL-fallback (старый путь — если bulk вернул записи, но ни одна не
    // совпала с автором). На практике сейчас срабатывает шаг 1.5 выше.
    if let Some(dr) = date_range.as_ref() {
        let jql_worklogs = fetch_worklogs_by_jql(&ctx, &params, &myself, dr).await
            .unwrap_or_else(|e| {
                eprintln!("[jira_client] JQL-fallback не удался: {e}");
                Vec::new()
            });
        if !jql_worklogs.is_empty() {
            return Ok(jql_worklogs);
        }
    }

    Ok(all)
}

/// Проверяет HTTP-статус ответа перед парсингом JSON. Без этого Jira-ошибки (401/403/500)
/// парсятся как success-JSON, тело без поля `values` трактуется как «нет данных», и
/// пользователь видит «соединение есть, часов нет». Возвращает Err с HTTP-кодом и
/// фрагментом тела, если статус не 2xx.
async fn ensure_json_success(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    if !status.is_success() {
        let body = truncate_chars(&resp.text().await.unwrap_or_default(), 300);
        return Err(format!("HTTP {status}: {body}"));
    }
    resp.json::<Value>().await.map_err(|e| format!("invalid response json: {e}"))
}

/// Bulk-получение worklog через worklog/updated → worklog/list.
/// Работает и для Cloud (api/3), и для Jira Server/DC 7.6.1+ (api/2).
async fn fetch_bulk_worklogs(
    ctx: &AuthedClient,
    params: &JiraConnectionParams,
    since_epoch_millis: i64,
) -> Result<Vec<Value>, String> {
    let mut all_ids: Vec<i64> = Vec::new();
    let mut since = since_epoch_millis;
    loop {
        let endpoint = url(params, "worklog/updated");
        let resp = send_with_retry(&ctx.client, || {
            apply_auth(ctx.client.get(&endpoint), params, &ctx.token)
                .query(&[("since", since.to_string())])
        }).await.map_err(String::from)?;
        let body: Value = ensure_json_success(resp).await?;
        let values = body.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for v in &values {
            if let Some(id) = v.get("worklogId").and_then(|x| x.as_i64()) { all_ids.push(id); }
        }
        let last_page = body.get("lastPage").and_then(|v| v.as_bool()).unwrap_or(true);
        if last_page || values.is_empty() { break; }
        since = body.get("until").and_then(|v| v.as_i64()).unwrap_or(since);
    }
    if all_ids.is_empty() { return Ok(Vec::new()); }

    let mut raw_worklogs: Vec<Value> = Vec::new();
    for chunk in all_ids.chunks(1000) {
        let endpoint = url(params, "worklog/list");
        let ids_body = json!({ "ids": chunk });
        let resp = send_with_retry(&ctx.client, || {
            apply_auth(ctx.client.post(&endpoint), params, &ctx.token).json(&ids_body)
        }).await.map_err(String::from)?;
        // worklog/list возвращает массив, а не объект — парсим как Value и берём как array.
        let arr_val: Value = ensure_json_success(resp).await?;
        let arr: Vec<Value> = arr_val.as_array().cloned().unwrap_or_default();
        raw_worklogs.extend(arr);
    }
    Ok(raw_worklogs)
}

/// Fallback-путь для старых Jira Server (<7.6): перебор issue/{KEY}/worklog.
/// Возвращает сырые worklog-объекты с известным issueKey в issueId-поле не будет,
/// но parse_one_worklog подставит fallback_issue_key.
async fn fetch_worklogs_by_issue_keys(
    ctx: &AuthedClient,
    params: &JiraConnectionParams,
    keys: &[String],
) -> Result<Vec<Value>, String> {
    let mut out: Vec<Value> = Vec::new();
    for key in keys {
        let endpoint = url(params, &format!("issue/{key}/worklog"));
        let resp = send_with_retry(&ctx.client, || {
            apply_auth(ctx.client.get(&endpoint), params, &ctx.token)
        }).await.map_err(String::from)?;
        let body: Value = ensure_json_success(resp).await?;
        let worklogs = body.get("worklogs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for mut v in worklogs {
            // Внедряем ключ задачи в объект, чтобы parse_worklogs_with_map его резолвнул,
            // даже если эндпоинт не вернул issueKey/issueId.
            if v.get("issueKey").is_none() {
                v["issueKey"] = json!(key);
            }
            out.push(v);
        }
    }
    Ok(out)
}

/// JQL-fallback для Jira Server 8.x, где bulk worklog/updated может вернуть пусто
/// даже при существующих записях. Ищем задачи через JQL:
///   worklogAuthor = currentUser() AND worklogDate >= "date_from" AND worklogDate <= "date_to"
/// (плюс project/issuekey-фильтр, если задан), затем забираем worklog по каждой
/// задаче через issue/{key}/worklog и фильтруем по автору + датам локально.
async fn fetch_worklogs_by_jql(
    ctx: &AuthedClient,
    params: &JiraConnectionParams,
    myself: &MyselfInfo,
    dr: &WorklogDateRange,
) -> Result<Vec<WorklogDto>, String> {
    let is_cloud = matches!(params.instance_type, JiraInstanceType::Cloud);
    let candidates = if is_cloud {
        Vec::new()
    } else {
        server_author_candidates(myself, &params.email)
    };

    // JQL-запрос: ищем задачи, где текущий пользователь логировал время в периоде.
    // Пагинация по startAt (Jira Server возвращает по ~100 задач за раз).
    let issue_clause = dr.issue_filter.as_deref().map(|f| {
        // SRM-123 → issuekey = SRM-123; SRM → project = SRM (если есть дефис — задача).
        if f.contains('-') {
            format!("AND issuekey = \"{}\"", f.to_uppercase())
        } else {
            format!("AND project = {}", f.to_uppercase())
        }
    }).unwrap_or_default();
    let jql = format!(
        "worklogAuthor = currentUser() AND worklogDate >= \"{}\" AND worklogDate <= \"{}\" {}",
        dr.date_from, dr.date_to, issue_clause
    );
    eprintln!("[jira_client] JQL-fallback: {}", jql);

    let endpoint = url(params, "search");
    let mut all_issues: Vec<Value> = Vec::new();
    let mut start_at: i64 = 0;
    loop {
        let body = json!({
            "jql": jql,
            "fields": ["summary"],
            "startAt": start_at,
            "maxResults": 100,
        });
        let resp = send_with_retry(&ctx.client, || {
            apply_auth(ctx.client.post(&endpoint), params, &ctx.token).json(&body)
        }).await.map_err(String::from)?;
        let search_result: Value = ensure_json_success(resp).await?;
        let issues = search_result.get("issues").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let total = search_result.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
        all_issues.extend(issues);
        start_at += 100;
        if start_at >= total || all_issues.len() >= 1000 { break; }
    }
    eprintln!("[jira_client] JQL-fallback: найдено {} задач", all_issues.len());

    let mut out: Vec<WorklogDto> = Vec::new();
    for issue in &all_issues {
        let issue_key = issue.get("key").and_then(|k| k.as_str()).unwrap_or("");
        let summary = issue.get("fields").and_then(|f| f.get("summary")).and_then(|s| s.as_str()).unwrap_or("").to_string();
        if issue_key.is_empty() { continue; }
        let _ = summary; // summary зарезервирован для будущего UI

        // Берём worklog по найденной задаче. Jira Server 8.x поддерживает
        // пагинацию через startAt/maxResults (по умолчанию ~20–5000 в зависимости
        // от версии). Перебираем все страницы.
        let wl_endpoint = url(params, &format!("issue/{}/worklog", issue_key));
        let mut wl_start_at: i64 = 0;
        let mut all_worklogs: Vec<Value> = Vec::new();
        loop {
            let resp = match send_with_retry(&ctx.client, || {
                apply_auth(ctx.client.get(&wl_endpoint), params, &ctx.token)
                    .query(&[("startAt", wl_start_at.to_string()), ("maxResults", "5000".to_string())])
            }).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[jira_client] JQL-fallback: не удалось получить worklog для {}: {}", issue_key, e);
                    break;
                }
            };
            let wl_body: Value = match ensure_json_success(resp).await {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[jira_client] JQL-fallback: {} worklog error: {}", issue_key, e);
                    break;
                }
            };
            let worklogs = wl_body.get("worklogs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let wl_total = wl_body.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
            all_worklogs.extend(worklogs);
            wl_start_at += 5000;
            // Если сервер не поддерживает пагинацию (total=0 или нет), выходим после первой страницы.
            if wl_total == 0 || wl_start_at >= wl_total || all_worklogs.len() as i64 >= wl_total { break; }
        }
        for v in &all_worklogs {
            // Фильтр по автору (как в основном пути).
            let author_matches = if is_cloud {
                let aid = myself.account_id.as_deref().unwrap_or("");
                cloud_author_matches(v, aid)
            } else {
                server_author_matches(v, &candidates)
            };
            if !author_matches { continue; }

            // Фильтр по дате: started должен попадать в период.
            let started = v.get("started").and_then(|x| x.as_str()).unwrap_or("");
            if !is_started_in_range(started, &dr.date_from, &dr.date_to) { continue; }

            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("0").to_string();
            let time_spent_seconds = v.get("timeSpentSeconds").and_then(|x| x.as_i64()).unwrap_or(0);
            let comment = v.get("comment").map(|c| adf_to_plain_text(c));
            let author = v.get("author").and_then(|a| a.get("displayName")).and_then(|d| d.as_str()).map(|s| s.to_string());
            let updated = v.get("updated").and_then(|x| x.as_str()).map(|s| s.to_string());
            out.push(WorklogDto {
                id, issue_key: Some(issue_key.to_string()),
                started: started.to_string(), time_spent_seconds, comment, author, updated,
            });
        }
    }
    eprintln!("[jira_client] JQL-fallback: собрано {} worklog", out.len());
    Ok(out)
}

/// Проверяет, попадает ли Jira-дата started (формат 2024-01-15T10:00:00.000+0000)
/// в диапазон date_from..date_to (формат YYYY-MM-DD).
fn is_started_in_range(started: &str, date_from: &str, date_to: &str) -> bool {
    // Берём первые 10 символов (YYYY-MM-DD) из started.
    let started_date = started.get(..10).unwrap_or("");
    if started_date.is_empty() { return true; } // если не смогли распарсить — пропускаем фильтр
    started_date >= date_from && started_date <= date_to
}

/// Парсит worklog-объекты из Cloud-ответа `worklog/list`, заменяя numeric issueId
/// на человекочитаемый issueKey через переданный HashMap.
fn parse_worklogs_with_map(
    values: Vec<Value>,
    issue_map: &std::collections::HashMap<String, (String, Option<String>)>,
) -> Vec<WorklogDto> {
    values.into_iter().filter_map(|v| {
        let id = v.get("id")?.as_str()?.to_string();
        let started = v.get("started")?.as_str()?.to_string();
        let time_spent_seconds = v.get("timeSpentSeconds").and_then(|x| x.as_i64()).unwrap_or(0);
        let comment = v.get("comment").map(|c| adf_to_plain_text(c));
        let author = v.get("author").and_then(|a| a.get("displayName")).and_then(|d| d.as_str()).map(|s| s.to_string());
        let updated = v.get("updated").and_then(|x| x.as_str()).map(|s| s.to_string());
        // Резолюция ключа задачи (приоритет):
        //   1. issue_map[numeric_id] — резольвнутый через GET /issue/{id} ключ (Cloud bulk)
        //   2. explicit issueKey — fallback-путь внедряет ключ прямо в объект
        //   3. сырой numeric issueId — последняя надежда, иначе null
        let numeric_id = v.get("issueId").and_then(|x| x.as_str()).map(|s| s.to_string());
        let explicit_key = v.get("issueKey").and_then(|x| x.as_str()).map(|s| s.to_string());
        let issue_key = numeric_id.as_deref()
            .and_then(|nid| issue_map.get(nid))
            .map(|(key, _)| key.clone())
            .or(explicit_key)
            .or(numeric_id);
        Some(WorklogDto { id, issue_key, started, time_spent_seconds, comment, author, updated })
    }).collect()
}

/// Вариант `parse_worklogs` для одного worklog-объекта (используется в Server-ветке
/// `get_worklogs_since`, где каждый worklog уже проверен на авторство до парсинга).
fn parse_one_worklog(v: &Value, fallback_issue_key: Option<&str>) -> Option<WorklogDto> {
    parse_worklogs(vec![v.clone()], fallback_issue_key).into_iter().next()
}

/// Парсит worklog-объекты с уже известным issue key (напр. из `issue/{KEY}/worklog`).
/// `fallback_issue_key` имеет приоритет над `issueId`-полем, потому что
/// `issueId` в собственном ответе `issue/{KEY}/worklog` — числовой id,
/// а не KEY — и его использовать было бы ошибкой.
fn parse_worklogs(values: Vec<Value>, fallback_issue_key: Option<&str>) -> Vec<WorklogDto> {
    values.into_iter().filter_map(|v| {
        let id = v.get("id")?.as_str()?.to_string();
        let started = v.get("started")?.as_str()?.to_string();
        let time_spent_seconds = v.get("timeSpentSeconds").and_then(|x| x.as_i64()).unwrap_or(0);
        let comment = v.get("comment").map(|c| adf_to_plain_text(c));
        let author = v.get("author").and_then(|a| a.get("displayName")).and_then(|d| d.as_str()).map(|s| s.to_string());
        let updated = v.get("updated").and_then(|x| x.as_str()).map(|s| s.to_string());
        // fallback_issue_key имеет приоритет над issueId (последнее — непригодный числовой id).
        let issue_key = fallback_issue_key.map(|s| s.to_string())
            .or_else(|| v.get("issueId").and_then(|x| x.as_str()).map(|s| s.to_string()));
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
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() {
                // Не пытаемся парсить тело ошибки как success-JSON — иначе пользователь
                // видит «invalid response json» вместо реальной причины (401/403/400).
                let body = resp.text().await.unwrap_or_default();
                let snippet = truncate_chars(&body, 300);
                return BulkResultItem {
                    issue_key: entry.issue_key.clone(), success: false, worklog_id: None,
                    error: Some(format!("HTTP {status}: {snippet}")), attempts,
                };
            }
            match resp.json::<Value>().await {
                Ok(payload) => {
                    let id = payload.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
                    BulkResultItem { issue_key: entry.issue_key.clone(), success: id.is_some(), worklog_id: id, error: None, attempts }
                }
                Err(e) => BulkResultItem { issue_key: entry.issue_key.clone(), success: false, worklog_id: None, error: Some(format!("invalid response json: {e}")), attempts },
            }
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
    async fn url_server_basic_uses_rest_api_v2() {
        // Сам по URL-хелпер, без сети: ServerBasic должен использовать REST API v2, как Server.
        // (Отдельно от apply_auth_server_basic_uses_basic_auth_not_bearer, который проверяет basic-авторизацию.)
        let params = JiraConnectionParams {
            base_url: "https://jira.example.com".to_string(), email: "ayurasov".to_string(),
            secret_ref: "test-basic-ref".to_string(),
            instance_type: JiraInstanceType::ServerBasic,
            extra_root_ca_pem_path: None, proxy: None,
            user_timezone: Some("Europe/Moscow".to_string()), accept_invalid_certs: false,
        };
        assert_eq!(url(&params, "myself"), "https://jira.example.com/rest/api/2/myself");
    }

    // ── тесты для логики идентификации/фильтрации worklog — главный риск этой сессии ──

    #[test]
    fn parse_worklogs_fallback_issue_key_takes_priority_over_raw_issue_id() {
        // fallback_issue_key (из issue/{KEY}/worklog) должен перебивать сырой числовой issueId,
        // иначе в UI вместо "PROJ-123" попадёт сырой нечитаемый id типа "10005".
        let v = json!({
            "id": "1001", "started": "2024-01-01T10:00:00.000+0000",
            "timeSpentSeconds": 3600, "issueId": "10005",
        });
        let out = parse_worklogs(vec![v], Some("PROJ-123"));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].issue_key.as_deref(), Some("PROJ-123"));
    }

    #[test]
    fn parse_worklogs_falls_back_to_raw_issue_id_when_no_fallback_key() {
        let v = json!({
            "id": "1001", "started": "2024-01-01T10:00:00.000+0000",
            "timeSpentSeconds": 3600, "issueId": "10005",
        });
        let out = parse_worklogs(vec![v], None);
        assert_eq!(out[0].issue_key.as_deref(), Some("10005"));
    }

    #[test]
    fn parse_worklogs_with_map_resolves_numeric_issue_id_to_key() {
        // Cloud worklog/list возвращает только числовой issueId — его надо резолвить
        // через GET /issue/{id} и подставить человеческий ключ в issue_map.
        let v = json!({
            "id": "1001", "started": "2024-01-01T10:00:00.000+0000",
            "timeSpentSeconds": 3600, "issueId": "10005",
        });
        let mut issue_map = std::collections::HashMap::new();
        issue_map.insert("10005".to_string(), ("PROJ-42".to_string(), Some("Fix bug".to_string())));
        let out = parse_worklogs_with_map(vec![v], &issue_map);
        assert_eq!(out[0].issue_key.as_deref(), Some("PROJ-42"));
    }

    #[test]
    fn parse_worklogs_with_map_falls_back_to_raw_id_when_unresolved() {
        let v = json!({
            "id": "1001", "started": "2024-01-01T10:00:00.000+0000",
            "timeSpentSeconds": 3600, "issueId": "99999",
        });
        let issue_map = std::collections::HashMap::new();
        let out = parse_worklogs_with_map(vec![v], &issue_map);
        assert_eq!(out[0].issue_key.as_deref(), Some("99999"));
    }

    #[test]
    fn cloud_author_filter_excludes_other_users_accountid() {
        // Тестирует реальную cloud_author_matches, вызываемую из get_worklogs_since (Cloud, шаг 3).
        let my_account_id = "acc-mine";
        let raw_worklogs = vec![
            json!({ "id": "1", "author": { "accountId": "acc-mine" } }),
            json!({ "id": "2", "author": { "accountId": "acc-other" } }),
            json!({ "id": "3" }), // нет author вообще
        ];
        let my_worklogs: Vec<Value> = raw_worklogs.into_iter()
            .filter(|v| cloud_author_matches(v, my_account_id))
            .collect();
        assert_eq!(my_worklogs.len(), 1);
        assert_eq!(my_worklogs[0]["id"], "1");
    }

    #[test]
    fn server_author_candidates_ignores_blank_email_and_dedupes_case() {
        // Пустой/пробельный params.email не должен попасть в кандидаты как пустая строка —
        // иначе candidates.is_empty() ложно вернёт false, и ошибка о невозможной идентификации не сработает.
        let myself = MyselfInfo { account_id: None, key: None, name: None, display_name: None, email: None };
        let candidates = server_author_candidates(&myself, "   ");
        assert!(candidates.is_empty());

        let myself2 = MyselfInfo {
            account_id: None, key: Some("AYURASOV".to_string()), name: None, display_name: None, email: None,
        };
        let candidates2 = server_author_candidates(&myself2, "a.yurasov@example.com");
        // server_author_candidates сортирует и дедуплицирует — порядок алфавитный.
        assert_eq!(candidates2, vec!["a.yurasov@example.com".to_string(), "ayurasov".to_string()]);
    }

    #[test]
    fn server_author_matches_by_key_name_or_email_case_insensitive() {
        // Тестирует реальную server_author_matches, вызываемую из get_worklogs_since (Server/ServerBasic).
        let candidates: Vec<String> = vec!["ayurasov".to_string(), "alexander yurasov".to_string(), "a.yurasov@example.com".to_string()];
        let mine_by_key = json!({ "author": { "key": "AYURASOV" } });
        let mine_by_email = json!({ "author": { "emailAddress": "A.Yurasov@Example.com" } });
        let other = json!({ "author": { "key": "other.user", "name": "Other User", "emailAddress": "other@example.com" } });
        let no_author = json!({ "id": "1" });
        assert!(server_author_matches(&mine_by_key, &candidates));
        assert!(server_author_matches(&mine_by_email, &candidates));
        assert!(!server_author_matches(&other, &candidates));
        assert!(!server_author_matches(&no_author, &candidates));
    }

    #[test]
    fn server_author_matches_by_display_name() {
        // Jira Server кладёт отображаемое имя автора в displayName — должно тоже матчится.
        let candidates = vec!["alexander yurasov".to_string()];
        let mine = json!({ "author": { "displayName": "Alexander Yurasov" } });
        assert!(server_author_matches(&mine, &candidates));
    }

    #[test]
    fn parse_worklogs_with_map_uses_explicit_issuekey_when_no_issueid() {
        // Fallback-путь (старый Jira Server <7.6) внедряет ключ задачи в поле issueKey,
        // т.к. issueId там может не быть. parse_worklogs_with_map должен его подобрать.
        let v = json!({
            "id": "1001", "started": "2024-01-01T10:00:00.000+0000",
            "timeSpentSeconds": 3600, "issueKey": "PROJ-99",
        });
        let issue_map = std::collections::HashMap::new();
        let out = parse_worklogs_with_map(vec![v], &issue_map);
        assert_eq!(out[0].issue_key.as_deref(), Some("PROJ-99"));
    }

    #[test]
    fn parse_worklogs_with_map_explicit_key_beats_raw_numeric_id() {
        // Если в объекте есть и numeric issueId, и явный issueKey — явный ключ должен
        // победить сырой numeric id (иначе в UI попадёт "10005" вместо "PROJ-99").
        let v = json!({
            "id": "1001", "started": "2024-01-01T10:00:00.000+0000",
            "timeSpentSeconds": 3600, "issueId": "10005", "issueKey": "PROJ-99",
        });
        let issue_map = std::collections::HashMap::new();
        let out = parse_worklogs_with_map(vec![v], &issue_map);
        assert_eq!(out[0].issue_key.as_deref(), Some("PROJ-99"));
    }

    /// End-to-end: Jira Server + Basic Auth (server_basic) — полный путь
    /// /myself → /worklog/updated → /worklog/list → /issue/{id} должен вернуть
    /// мои worklogs даже когда issue_keys_for_fallback пуст (главный баг «пустая таблица»).
    /// Воспроизводит реальный сетевой обмен через wiremock.
    #[tokio::test]
    async fn get_worklogs_since_server_basic_full_bulk_path_no_fallback_keys() {
        use wiremock::matchers::query_param;
        // sandbox не имеет keyring — подсунем секрет через env escape-hatch.
        // Безопасно: проверяем, что ещё не задано, чтобы избежать гонки std::env::set_var
        // между параллельными тестами.
        if std::env::var("JIRATIME_TEST_SECRET_TEST_SECRET_REF").is_err() {
            std::env::set_var("JIRATIME_TEST_SECRET_TEST_SECRET_REF", "dummy-pass");
        }
        let server = MockServer::start().await;

        // /myself — Server отдаёт key/name/displayName/emailAddress, без accountId.
        Mock::given(method("GET")).and(path("/rest/api/2/myself"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "key": "yurasov.av", "name": "yurasov.av",
                "displayName": "Yurasov AV",
                "emailAddress": "yurasov.av@almi-partner.ru",
                "accountId": null,
            })))
            .expect(1).mount(&server).await;

        // /worklog/updated — одна страница, одна моя запись + одна чужая.
        Mock::given(method("GET")).and(path("/rest/api/2/worklog/updated"))
            .and(query_param("since", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "values": [
                    { "worklogId": 5001 },
                    { "worklogId": 5002 },
                ],
                "lastPage": true,
            })))
            .expect(1).mount(&server).await;

        // /worklog/list — bulk-выгрузка по id: 5001 = моя (PROJ-99), 5002 = чужая (OTHER-1).
        Mock::given(method("POST")).and(path("/rest/api/2/worklog/list"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "id": "5001", "issueId": "10005", "started": "2024-01-01T10:00:00.000+0000",
                  "timeSpentSeconds": 7200,
                  "author": { "key": "yurasov.av", "name": "yurasov.av", "displayName": "Yurasov AV",
                              "emailAddress": "yurasov.av@almi-partner.ru", "accountId": null } },
                { "id": "5002", "issueId": "10006", "started": "2024-01-01T11:00:00.000+0000",
                  "timeSpentSeconds": 1800,
                  "author": { "key": "other.user", "name": "other.user", "displayName": "Other User",
                              "emailAddress": "other@almi-partner.ru", "accountId": null } },
            ])))
            .expect(1).mount(&server).await;

        // /issue/{id} — резолвция numeric issueId в ключ задачи.
        Mock::given(method("GET")).and(path("/rest/api/2/issue/10005"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "key": "PROJ-99", "fields": { "summary": "Fix login" } })))
            .expect(1).mount(&server).await;

        let params = test_params(server.uri(), JiraInstanceType::ServerBasic);
        // Главный момент: issue_keys_for_fallback = пустой список.
        let out = get_worklogs_since(params, 0, Some(Vec::new()), None).await.expect("должен вернуть результат");
        // Только моя запись survived фильтр по автору.
        assert_eq!(out.len(), 1, "должна остаться только моя запись (чужая отфильтрована)");
        assert_eq!(out[0].issue_key.as_deref(), Some("PROJ-99"), "numeric issueId должен быть резольвнут в PROJ-99");
        assert_eq!(out[0].time_spent_seconds, 7200);
    }

    /// Если /worklog/updated возвращает 403 (нет прав / auth failure),
    /// get_worklogs_since должен вернуть ОШИБКУ, а не пустой список (Ok([])),
    /// иначе пользователь видит «соединение есть, часов нет».
    #[tokio::test]
    async fn get_worklogs_since_worklog_updated_403_returns_error_not_empty() {
        use wiremock::matchers::query_param;
        if std::env::var("JIRATIME_TEST_SECRET_TEST_SECRET_REF").is_err() {
            std::env::set_var("JIRATIME_TEST_SECRET_TEST_SECRET_REF", "dummy-pass");
        }
        let server = MockServer::start().await;

        Mock::given(method("GET")).and(path("/rest/api/2/myself"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "key": "yurasov.av", "name": "yurasov.av", "displayName": "Yurasov AV",
                "emailAddress": "yurasov.av@almi-partner.ru",
            })))
            .mount(&server).await;

        // bulk-эндпоинт отдаёт 403 с JSON-телом (типичная ошибка Jira).
        Mock::given(method("GET")).and(path("/rest/api/2/worklog/updated"))
            .and(query_param("since", "0"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "errorMessages": ["Permission denied"], "errors": {},
            })))
            .mount(&server).await;

        let params = test_params(server.uri(), JiraInstanceType::ServerBasic);
        let result = get_worklogs_since(params, 0, Some(Vec::new()), None).await;
        assert!(result.is_err(), "403 не должен давать пустой Ok — должна быть ошибка");
        let err = result.unwrap_err();
        assert!(err.contains("403"), "сообщение должно содержать HTTP-код: {err}");
        assert!(!err.contains("fallback"), "403 не должен уходить в fallback (это не 404): {err}");
    }

    /// JQL-fallback: bulk worklog/updated вернул 200 + пусто → должен сработать
    /// JQL-запрос /search → /issue/{key}/worklog и вернуть мои записи.
    /// Воспроизводит главный сценарий Jira Server 8.x «соединение есть, часов нет».
    #[tokio::test]
    async fn get_worklogs_since_jql_fallback_when_bulk_empty() {
        use wiremock::matchers::query_param;
        if std::env::var("JIRATIME_TEST_SECRET_TEST_SECRET_REF").is_err() {
            std::env::set_var("JIRATIME_TEST_SECRET_TEST_SECRET_REF", "dummy-pass");
        }
        let server = MockServer::start().await;

        // /myself
        Mock::given(method("GET")).and(path("/rest/api/2/myself"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "key": "yurasov.av", "name": "yurasov.av", "displayName": "Yurasov AV",
                "emailAddress": "yurasov.av@almi-partner.ru",
            })))
            .mount(&server).await;

        // /worklog/updated — 200, но пусто (главный баг Jira Server 8.x).
        Mock::given(method("GET")).and(path("/rest/api/2/worklog/updated"))
            .and(query_param("since", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "values": [], "lastPage": true,
            })))
            .mount(&server).await;

        // /search — JQL нашёл 1 задачу с моим worklog.
        Mock::given(method("POST")).and(path("/rest/api/2/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "issues": [
                    { "key": "SRM-42", "fields": { "summary": "Интеграция" } },
                ],
            })))
            .mount(&server).await;

        // /issue/SRM-42/worklog — 1 моя запись в периоде + 1 чужая (отфильтруется).
        Mock::given(method("GET")).and(path("/rest/api/2/issue/SRM-42/worklog"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "worklogs": [
                    { "id": "9001", "started": "2026-06-15T10:00:00.000+0000",
                      "timeSpentSeconds": 5400,
                      "author": { "key": "yurasov.av", "name": "yurasov.av",
                                  "displayName": "Yurasov AV",
                                  "emailAddress": "yurasov.av@almi-partner.ru" } },
                    { "id": "9002", "started": "2026-06-15T12:00:00.000+0000",
                      "timeSpentSeconds": 3600,
                      "author": { "key": "other.user", "displayName": "Other User" } },
                ],
            })))
            .mount(&server).await;

        let params = test_params(server.uri(), JiraInstanceType::ServerBasic);
        let dr = WorklogDateRange {
            date_from: "2026-06-01".to_string(),
            date_to: "2026-06-30".to_string(),
            issue_filter: Some("SRM".to_string()),
        };
        let out = get_worklogs_since(params, 0, Some(Vec::new()), Some(dr)).await
            .expect("JQL-fallback должен вернуть записи");
        assert_eq!(out.len(), 1, "только моя запись (чужая отфильтрована по автору)");
        assert_eq!(out[0].issue_key.as_deref(), Some("SRM-42"));
        assert_eq!(out[0].time_spent_seconds, 5400);
    }
}
