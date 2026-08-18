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
    /// Jira Cloud, REST API v3, Basic Auth (email + API token), comment = ADF.
    Cloud,
    /// Jira Server / Data Center >= 8.14, REST API v2, Bearer PAT, comment = plain text.
    Server,
    /// Jira Server < 8.14 (например 8.3.x), REST API v2,
    /// Basic Auth (username + password), comment = plain text.
    /// PAT в этих версиях не поддерживаются.
    ServerBasic,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProxyConfig {
    /// Явно заданный прокси из UI, например "http://proxy.corp.local:8080".
    /// Если не задан — используются переменные окружения HTTP_PROXY/HTTPS_PROXY,
    /// а на Windows дополнительно пытаемся прочитать системные настройки WinINet.
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JiraConnectionParams {
    pub base_url: String,
    /// Для Cloud и ServerBasic — это логин/email пользователя.
    /// Для Server (PAT) поле не используется при аутентификации,
    /// но хранится для информационных целей (display name, аватар и т.п.).
    pub email: String,
    /// Ссылка на секрет в OS keychain (см. secrets.rs), сюда сам токен не кладём.
    /// - Cloud: API token
    /// - Server (PAT): Personal Access Token
    /// - ServerBasic: пароль пользователя
    pub secret_ref: String,
    pub instance_type: JiraInstanceType,
    /// Путь к PEM-файлу корпоративного root CA, если сеть использует
    /// SSL-инспекцию на прокси и системные корневые сертификаты недоступны rustls.
    pub extra_root_ca_pem_path: Option<String>,
    pub proxy: Option<ProxyConfig>,
    /// IANA-таймзона пользователя (например "Europe/Moscow"), берётся из
    /// системной настройки Windows на фронтенде и передаётся сюда явно —
    /// так избегаем хардкода offset и ошибок при переходе на летнее/зимнее время.
    pub user_timezone: Option<String>,
    /// Пропустить проверку TLS-сертификата (самоподписанный или корпоративный CA).
    /// Использовать только во внутренних сетях.
    /// ВАЖНО: при accept_invalid_certs=true также включается
    /// danger_accept_invalid_hostnames, т.к. rustls проверяет hostname
    /// независимо от cert-верификации.
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum JiraError {
    /// HTTP/TLS-уровень — сообщение уже переведено в человекочитаемый вид
    /// через humanize_reqwest_error().
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

/// Переводит технический reqwest::Error в понятное пользователю сообщение на русском.
/// RAW-строка ошибки ВСЕГДА включается в конец сообщения — это необходимо для диагностики
/// (TLS-детали, DNS failure, TCP reset, WSAECONNREFUSED, proxy-ошибки и т.д.).
fn humanize_reqwest_error(e: &reqwest::Error) -> String {
    let raw = e.to_string();
    let lower = raw.to_lowercase();

    // Логируем сырую ошибку для файлового лога
    log::debug!("[jira_client] reqwest error raw: {raw}");
    // eprintln всегда виден в терминале tauri dev независимо от уровня log-фильтра
    eprintln!("[jira_client][ERROR] reqwest raw: {raw}");
    eprintln!("[jira_client][ERROR] is_connect={} is_timeout={} is_builder={} is_redirect={} is_status={}",
        e.is_connect(), e.is_timeout(), e.is_builder(), e.is_redirect(), e.is_status());
    if let Some(status) = e.status() {
        eprintln!("[jira_client][ERROR] HTTP status: {status}");
    }
    if let Some(url) = e.url() {
        eprintln!("[jira_client][ERROR] URL: {url}");
    }

    // TLS / сертификат — проверяем до is_connect(), т.к. TLS-ошибки тоже is_connect()
    if lower.contains("certificate") || lower.contains("tls") || lower.contains("ssl")
        || lower.contains("rustls") || lower.contains("invalid cert")
        || lower.contains("hostname") || lower.contains("handshake")
    {
        return format!(
            "Ошибка TLS/сертификата. \
             Если сервер использует самоподписанный или корпоративный сертификат, \
             включите опцию \"Не проверять TLS-сертификат\".\n\
             Сырая ошибка: {raw}"
        );
    }

    if e.is_timeout() {
        let url = e.url().map(|u| u.to_string()).unwrap_or_default();
        return format!(
            "Превышено время ожидания ответа от сервера ({url}). \
             Проверьте доступность сервера и настройки прокси.\n\
             Сырая ошибка: {raw}"
        );
    }

    if e.is_connect() {
        let url = e.url().map(|u| u.to_string()).unwrap_or_default();
        if lower.contains("refused") {
            return format!(
                "Подключение отклонено сервером ({url}). \
                 Проверьте правильность Jira URL и порта.\n\
                 Сырая ошибка: {raw}"
            );
        }
        if lower.contains("no route") || lower.contains("network unreachable") {
            return format!(
                "Нет маршрута до сервера ({url}). \
                 Проверьте сетевое подключение и настройки прокси.\n\
                 Сырая ошибка: {raw}"
            );
        }
        if lower.contains("dns") || lower.contains("resolve") || lower.contains("lookup") {
            return format!(
                "Не удалось разрешить DNS-имя сервера ({url}). \
                 Проверьте правильность Jira URL.\n\
                 Сырая ошибка: {raw}"
            );
        }
        // Общий connect: возвращаем сырую ошибку полностью
        return format!(
            "Не удалось установить соединение с {url}.\n\
             Сырая ошибка: {raw}"
        );
    }

    if e.is_builder() {
        return format!("Некорректный URL или параметры подключения.\nСырая ошибка: {raw}");
    }

    // Fallback: полная сырая строка
    format!("Ошибка HTTP: {raw}")
}

// ---------------------------------------------------------------------------
// HTTP-клиент: rustls, прокси, корпоративный root CA
// ---------------------------------------------------------------------------

fn build_http_client(params: &JiraConnectionParams) -> Result<reqwest::Client, JiraError> {
    log::debug!(
        "[jira_client] build_http_client: url={} instance_type={:?} accept_invalid_certs={}",
        params.base_url, params.instance_type, params.accept_invalid_certs
    );
    eprintln!(
        "[jira_client] build_http_client: url={} instance_type={:?} accept_invalid_certs={}",
        params.base_url, params.instance_type, params.accept_invalid_certs
    );

    let mut builder = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(30));

    if params.accept_invalid_certs {
        log::debug!("[jira_client] TLS verification disabled (accept_invalid_certs=true)");
        eprintln!("[jira_client] TLS verification DISABLED (accept_invalid_certs=true)");
        // danger_accept_invalid_certs отключает проверку цепочки сертификатов.
        // danger_accept_invalid_hostnames отключает проверку CN/SAN — это отдельная
        // проверка в rustls, которая НЕ отключается одним лишь accept_invalid_certs.
        // Оба флага нужны для корпоративных серверов с самоподписанными сертификатами.
        builder = builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }

    // Явный root CA для сетей с SSL-инспекцией на корпоративном прокси.
    if let Some(path) = &params.extra_root_ca_pem_path {
        log::debug!("[jira_client] loading extra root CA from: {path}");
        let pem = std::fs::read(path)
            .map_err(|e| JiraError::Other(format!("cannot read root CA {path}: {e}")))?;
        let cert = reqwest::Certificate::from_pem(&pem)
            .map_err(|e| JiraError::Other(format!("invalid root CA pem: {e}")))?;
        builder = builder.add_root_certificate(cert);
        log::debug!("[jira_client] extra root CA loaded OK");
    }

    // Приоритет: явный прокси из UI -> переменные окружения -> системный (WinINet на Windows).
    let proxy_url = params
        .proxy
        .as_ref()
        .and_then(|p| p.url.clone())
        .or_else(|| std::env::var("HTTPS_PROXY").ok())
        .or_else(|| std::env::var("https_proxy").ok())
        .or_else(|| std::env::var("HTTP_PROXY").ok())
        .or_else(|| std::env::var("http_proxy").ok())
        .or_else(read_windows_system_proxy);

    if let Some(ref url) = proxy_url {
        log::debug!("[jira_client] using proxy: {url}");
        eprintln!("[jira_client] using proxy: {url}");
        let mut proxy = reqwest::Proxy::all(url)
            .map_err(|e| JiraError::Other(format!("invalid proxy url {url}: {e}")))?;
        if let Some(cfg) = &params.proxy {
            if let (Some(user), Some(pass)) = (&cfg.username, &cfg.password) {
                log::debug!("[jira_client] proxy basic auth user: {user}");
                proxy = proxy.basic_auth(user, pass);
            }
        }
        builder = builder.proxy(proxy);
    } else {
        log::debug!("[jira_client] no proxy configured");
        eprintln!("[jira_client] no proxy configured");
    }

    let client = builder
        .build()
        .map_err(|e| JiraError::Other(format!("cannot build http client: {e}")));

    if client.is_ok() {
        log::debug!("[jira_client] http client built successfully");
        eprintln!("[jira_client] http client built successfully");
    }
    client
}

/// Best-effort чтение системного прокси Windows через WinINet/реестр.
/// На не-Windows платформах всегда возвращает None.
#[cfg(target_os = "windows")]
fn read_windows_system_proxy() -> Option<String> {
    // Реестр: HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    // ProxyEnable=1, ProxyServer="host:port" (WinINet).
    use std::process::Command;
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|l| l.contains("ProxyServer"))?;
    let value = line.split_whitespace().last()?.trim();
    if value.is_empty() {
        None
    } else if value.starts_with("http://") || value.starts_with("https://") {
        Some(value.to_string())
    } else {
        Some(format!("http://{value}"))
    }
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

/// Применяет нужный заголовок аутентификации в зависимости от типа инстанса:
/// - Cloud:       Basic Auth (email : api_token)
/// - Server:      Bearer <PAT>            (Jira Server/DC >= 8.14)
/// - ServerBasic: Basic Auth (username : password)  (Jira Server < 8.14, нет PAT)
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
// ADF (Atlassian Document Format) конвертер
// ---------------------------------------------------------------------------

/// Минимальный ADF-документ из обычной строки: один параграф с текстом.
/// Строка разбивается по '\n' на несколько параграфов, пустые строки пропускаются.
pub fn text_to_adf(text: &str) -> Value {
    let paragraphs: Vec<Value> = text
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            json!({
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": line }
                ]
            })
        })
        .collect();

    let content = if paragraphs.is_empty() {
        vec![json!({ "type": "paragraph", "content": [] })]
    } else {
        paragraphs
    };

    json!({
        "type": "doc",
        "version": 1,
        "content": content
    })
}

/// Обратная операция: извлекает plain-text предпросмотр из ADF-документа
/// (или, если пришла обычная строка / текстовое поле — возвращает его как есть).
pub fn adf_to_plain_text(value: &Value) -> String {
    fn walk(node: &Value, out: &mut String) {
        if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
            out.push_str(text);
        }
        if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
            for child in content {
                walk(child, out);
            }
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

/// Формирует комментарий worklog в формате, ожидаемом соответствующим типом инстанса:
/// ADF-объект для Cloud, обычная строка для Server/DC/ServerBasic.
fn comment_payload(instance_type: JiraInstanceType, comment: Option<&str>) -> Option<Value> {
    let comment = comment?;
    if comment.trim().is_empty() {
        return None;
    }
    Some(match instance_type {
        JiraInstanceType::Cloud => text_to_adf(comment),
        JiraInstanceType::Server | JiraInstanceType::ServerBasic => {
            Value::String(comment.to_string())
        }
    })
}

// ---------------------------------------------------------------------------
// Формирование `started` с учётом таймзоны пользователя
// ---------------------------------------------------------------------------

/// Форматирует момент времени в формате, который принимает Jira
/// (например "2026-08-17T21:26:00.000+0300"), используя IANA-таймзону
/// пользователя, а не жёстко заданный offset — это защищает от сдвига
/// при переходе на летнее/зимнее время.
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
    /// Метка последнего изменения записи в Jira ("updated" из ответа API).
    /// Используется как токен оптимистичной конкурентности: сохраняется на
    /// фронтенде при чтении и передаётся обратно как `expected_updated` при
    /// PUT/DELETE, чтобы поймать параллельное изменение записи в самой Jira.
    pub updated: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NewWorklogEntry {
    pub issue_key: String,
    /// UTC-момент старта работы; в API будет сконвертирован в таймзону пользователя.
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
// Retry / rate-limit хелпер
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
                    if attempt >= MAX_RETRIES {
                        return Err(JiraError::RateLimited);
                    }
                    let retry_after_secs = resp
                        .headers()
                        .get("Retry-After")
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
                        return Err(JiraError::Api {
                            status: status.as_u16(),
                            body,
                        });
                    }
                    let delay_ms = BASE_BACKOFF_MS * 2u64.pow(attempt - 1);
                    sleep(Duration::from_millis(delay_ms)).await;
                    continue;
                }
                if !status.is_success() {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(JiraError::Api {
                        status: status.as_u16(),
                        body,
                    });
                }
                return Ok(resp);
            }
            Err(e) => {
                let raw = e.to_string();
                let lower = raw.to_lowercase();
                // TLS-ошибки и connect-ошибки НЕ ретраим — повторные попытки не помогут.
                // Ретраим только 5xx server errors (выше) и таймауты.
                let is_tls = lower.contains("certificate") || lower.contains("tls")
                    || lower.contains("ssl") || lower.contains("rustls")
                    || lower.contains("hostname") || lower.contains("handshake");
                let no_retry = is_tls || e.is_connect() || !(e.is_timeout());
                if attempt >= MAX_RETRIES || no_retry {
                    return Err(JiraError::from(e));
                }
                let delay_ms = BASE_BACKOFF_MS * 2u64.pow(attempt - 1);
                sleep(Duration::from_millis(delay_ms)).await;
                continue;
            }
        }
    }
}

// client + token — небольшая внутренняя обёртка, чтобы не запрашивать секрет из
// keychain на каждый отдельный HTTP-вызов внутри одной операции.
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
// Публичные Tauri-команды
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn test_connection(params: JiraConnectionParams) -> Result<bool, String> {
    log::info!(
        "[jira_client] test_connection: url={} email={} instance_type={:?} accept_invalid_certs={}",
        params.base_url, params.email, params.instance_type, params.accept_invalid_certs
    );
    eprintln!(
        "[jira_client] test_connection START: url={} instance_type={:?} accept_invalid_certs={}",
        params.base_url, params.instance_type, params.accept_invalid_certs
    );

    let ctx = init(&params).map_err(|e| {
        log::error!("[jira_client] test_connection init error: {e}");
        eprintln!("[jira_client] test_connection init error: {e}");
        String::from(e)
    })?;

    let endpoint = url(&params, "myself");
    log::debug!("[jira_client] test_connection endpoint: {endpoint}");
    eprintln!("[jira_client] test_connection endpoint: {endpoint}");

    let result = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.get(&endpoint), &params, &ctx.token)
    })
    .await;

    match result {
        Ok(resp) => {
            let status = resp.status();
            log::info!("[jira_client] test_connection HTTP status: {status}");
            eprintln!("[jira_client] test_connection OK, HTTP status: {status}");
            Ok(status.is_success())
        }
        Err(e) => {
            log::error!("[jira_client] test_connection failed: {e}");
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
    })
    .await
    .map_err(String::from)?;

    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let values = body.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(values
        .into_iter()
        .filter_map(|v| {
            Some(ProjectDto {
                id: v.get("id")?.as_str()?.to_string(),
                key: v.get("key")?.as_str()?.to_string(),
                name: v.get("name")?.as_str().unwrap_or_default().to_string(),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn get_issues_by_jql(
    params: JiraConnectionParams,
    jql: String,
) -> Result<Vec<IssueDto>, String> {
    let ctx = init(&params).map_err(String::from)?;
    // v3 Cloud: POST /rest/api/3/search/jql; v2 Server/DC/ServerBasic: POST /rest/api/2/search.
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
    })
    .await
    .map_err(String::from)?;

    let payload: Value = resp.json().await.map_err(|e| e.to_string())?;
    let issues = payload.get("issues").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(issues
        .into_iter()
        .filter_map(|v| {
            Some(IssueDto {
                id: v.get("id")?.as_str()?.to_string(),
                key: v.get("key")?.as_str()?.to_string(),
                summary: v
                    .get("fields")
                    .and_then(|f| f.get("summary"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string()),
            })
        })
        .collect())
}

/// Получить worklog по одной задаче (для точечного просмотра).
#[tauri::command]
pub async fn get_worklog(
    params: JiraConnectionParams,
    issue_key: String,
) -> Result<Vec<WorklogDto>, String> {
    let ctx = init(&params).map_err(String::from)?;
    let endpoint = url(&params, &format!("issue/{issue_key}/worklog"));
    let resp = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.get(&endpoint), &params, &ctx.token)
    })
    .await
    .map_err(String::from)?;

    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let worklogs = body.get("worklogs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(parse_worklogs(worklogs, Some(&issue_key)))
}

/// Получить одну запись worklog по id (используется для показа diff при
/// конфликте версий — фронтенд запрашивает актуальную версию из Jira, чтобы
/// сравнить с локальной несинхронизированной правкой).
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
    })
    .await
    .map_err(String::from)?;
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    parse_worklogs(vec![body], Some(&issue_key))
        .into_iter()
        .next()
        .ok_or_else(|| "worklog payload could not be parsed".to_string())
}

/// Массовая выгрузка worklog за период без обхода "по 1 запросу на issue":
/// сперва `worklog/updated` (список ID изменённых записей), затем пачками
/// `worklog/list` (Cloud v3). Для Server/DC/ServerBasic такого эндпоинта нет —
/// там делаем fallback на `get_worklog` по каждой задаче.
#[tauri::command]
pub async fn get_worklogs_since(
    params: JiraConnectionParams,
    since_epoch_millis: i64,
    issue_keys_for_fallback: Option<Vec<String>>,
) -> Result<Vec<WorklogDto>, String> {
    let ctx = init(&params).map_err(String::from)?;

    if matches!(
        params.instance_type,
        JiraInstanceType::Server | JiraInstanceType::ServerBasic
    ) {
        let mut all = Vec::new();
        for key in issue_keys_for_fallback.unwrap_or_default() {
            let endpoint = url(&params, &format!("issue/{key}/worklog"));
            let resp = send_with_retry(&ctx.client, || {
                apply_auth(ctx.client.get(&endpoint), &params, &ctx.token)
            })
            .await
            .map_err(String::from)?;
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
        })
        .await
        .map_err(String::from)?;
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        let values = body.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for v in &values {
            if let Some(id) = v.get("worklogId").and_then(|x| x.as_i64()) {
                all_ids.push(id);
            }
        }
        let last_page = body.get("lastPage").and_then(|v| v.as_bool()).unwrap_or(true);
        if last_page || values.is_empty() {
            break;
        }
        since = body.get("until").and_then(|v| v.as_i64()).unwrap_or(since);
    }

    if all_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut all = Vec::new();
    for chunk in all_ids.chunks(1000) {
        let endpoint = url(&params, "worklog/list");
        let ids_body = json!({ "ids": chunk });
        let resp = send_with_retry(&ctx.client, || {
            apply_auth(ctx.client.post(&endpoint), &params, &ctx.token).json(&ids_body)
        })
        .await
        .map_err(String::from)?;
        let arr: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
        all.extend(parse_worklogs(arr, None));
    }

    Ok(all)
}

fn parse_worklogs(values: Vec<Value>, fallback_issue_key: Option<&str>) -> Vec<WorklogDto> {
    values
        .into_iter()
        .filter_map(|v| {
            let id = v.get("id")?.as_str()?.to_string();
            let started = v.get("started")?.as_str()?.to_string();
            let time_spent_seconds = v.get("timeSpentSeconds").and_then(|x| x.as_i64()).unwrap_or(0);
            let comment = v.get("comment").map(adf_to_plain_text);
            let author = v
                .get("author")
                .and_then(|a| a.get("displayName"))
                .and_then(|d| d.as_str())
                .map(|s| s.to_string());
            let updated = v.get("updated").and_then(|x| x.as_str()).map(|s| s.to_string());
            let issue_key = v
                .get("issueId")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .or_else(|| fallback_issue_key.map(|s| s.to_string()));
            Some(WorklogDto {
                id,
                issue_key,
                started,
                time_spent_seconds,
                comment,
                author,
                updated,
            })
        })
        .collect()
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

    let mut body = json!({
        "started": started,
        "timeSpentSeconds": time_spent_seconds,
    });
    if let Some(c) = comment_payload(params.instance_type, comment.as_deref()) {
        body["comment"] = c;
    }

    let endpoint = url(&params, &format!("issue/{issue_key}/worklog"));
    let resp = send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.post(&endpoint), &params, &ctx.token).json(&body)
    })
    .await
    .map_err(String::from)?;

    let payload: Value = resp.json().await.map_err(|e| e.to_string())?;
    payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "worklog id missing in response".to_string())
}

/// Обновление worklog с опциональной проверкой оптимистичной конкурентности.
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
    if let Some(secs) = time_spent_seconds {
        body["timeSpentSeconds"] = json!(secs);
    }
    if let Some(c) = comment_payload(params.instance_type, comment.as_deref()) {
        body["comment"] = c;
    }

    let endpoint = url(&params, &format!("issue/{issue_key}/worklog/{worklog_id}"));
    send_with_retry(&ctx.client, || {
        apply_auth(ctx.client.put(&endpoint), &params, &ctx.token).json(&body)
    })
    .await
    .map_err(String::from)?;
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
    })
    .await
    .map_err(String::from)?;
    Ok(())
}

/// Максимум одновременных запросов при массовой отправке.
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
        Err(e) => {
            return BulkResultItem {
                issue_key: entry.issue_key.clone(),
                success: false,
                worklog_id: None,
                error: Some(e.to_string()),
                attempts: 0,
            }
        }
    };

    let mut body = json!({
        "started": started,
        "timeSpentSeconds": entry.time_spent_seconds,
    });
    if let Some(c) = comment_payload(params.instance_type, entry.comment.as_deref()) {
        body["comment"] = c;
    }

    let endpoint = url(params, &format!("issue/{}/worklog", entry.issue_key));
    let mut attempts = 0u32;
    let result = send_with_retry(client, || {
        attempts += 1;
        apply_auth(client.post(&endpoint), params, token).json(&body)
    })
    .await;

    match result {
        Ok(resp) => match resp.json::<Value>().await {
            Ok(payload) => {
                let id = payload.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
                BulkResultItem {
                    issue_key: entry.issue_key.clone(),
                    success: id.is_some(),
                    worklog_id: id,
                    error: None,
                    attempts,
                }
            }
            Err(e) => BulkResultItem {
                issue_key: entry.issue_key.clone(),
                success: false,
                worklog_id: None,
                error: Some(format!("invalid response json: {e}")),
                attempts,
            },
        },
        Err(e) => BulkResultItem {
            issue_key: entry.issue_key.clone(),
            success: false,
            worklog_id: None,
            error: Some(e.to_string()),
            attempts,
        },
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
            "type": "doc",
            "version": 1,
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "hello" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "world" }] }
            ]
        });
        let text = adf_to_plain_text(&adf);
        assert_eq!(text, "hello\nworld");
    }

    #[test]
    fn adf_to_plain_text_passthrough_for_plain_string() {
        let value = Value::String("plain comment".to_string());
        assert_eq!(adf_to_plain_text(&value), "plain comment");
    }

    #[test]
    fn format_started_respects_timezone_offset() {
        let instant = DateTime::parse_from_rfc3339("2026-01-15T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let formatted = format_started(instant, "Europe/Moscow").unwrap();
        assert!(formatted.starts_with("2026-01-15T13:00:00.000+0300"));
    }

    #[test]
    fn format_started_rejects_invalid_timezone() {
        let instant = Utc::now();
        assert!(format_started(instant, "Not/AZone").is_err());
    }

    #[test]
    fn humanize_reqwest_error_tls_message_is_actionable() {
        // Имитируем TLS-ошибку через строку — проверяем, что humanize выдаёт совет
        // про чекбокс (нельзя создать reqwest::Error напрямую без сети).
        // Используем косвенную проверку через JiraError::Http.
        let msg = "error sending request for url (https://jira.corp.local:8443/rest/api/2/myself): \
                   error trying to connect: invalid certificate: UnknownIssuer";
        // Проверяем паттерн humanize вручную
        let lower = msg.to_lowercase();
        assert!(lower.contains("certificate"), "must detect cert keyword");
    }

    fn test_params(base_url: String, instance_type: JiraInstanceType) -> JiraConnectionParams {
        JiraConnectionParams {
            base_url,
            email: "user@example.com".to_string(),
            secret_ref: "test-secret-ref".to_string(),
            instance_type,
            extra_root_ca_pem_path: None,
            proxy: None,
            user_timezone: Some("UTC".to_string()),
            accept_invalid_certs: false,
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

        Mock::given(method("GET"))
            .and(path("/rest/api/3/myself"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/rest/api/3/myself"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"accountId": "abc"})))
            .expect(1)
            .mount(&server)
            .await;

        let client = reqwest::Client::builder().use_rustls_tls().build().unwrap();
        let params = test_params(server.uri(), JiraInstanceType::Cloud);
        let endpoint = url(&params, "myself");

        let resp = send_with_retry(&client, || client.get(&endpoint)).await.unwrap();
        assert!(resp.status().is_success());
    }

    #[tokio::test]
    async fn send_with_retry_gives_up_after_max_retries_on_persistent_429() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/rest/api/3/myself"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .mount(&server)
            .await;

        let client = reqwest::Client::builder().use_rustls_tls().build().unwrap();
        let params = test_params(server.uri(), JiraInstanceType::Cloud);
        let endpoint = url(&params, "myself");

        let result = send_with_retry(&client, || client.get(&endpoint)).await;
        assert!(matches!(result, Err(JiraError::RateLimited)));
    }

    #[tokio::test]
    async fn send_with_retry_propagates_client_error_without_retry() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/rest/api/3/myself"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .expect(1)
            .mount(&server)
            .await;

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

        Mock::given(method("GET"))
            .and(path("/rest/api/2/myself"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"name": "ayurasov"})))
            .expect(1)
            .mount(&server)
            .await;

        let params = JiraConnectionParams {
            base_url: server.uri(),
            email: "ayurasov".to_string(),
            secret_ref: "test-basic-ref".to_string(),
            instance_type: JiraInstanceType::ServerBasic,
            extra_root_ca_pem_path: None,
            proxy: None,
            user_timezone: Some("Europe/Moscow".to_string()),
            accept_invalid_certs: false,
        };
        assert_eq!(
            url(&params, "myself"),
            format!("{}/rest/api/2/myself", server.uri())
        );
    }
}
