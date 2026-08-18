// Интеграция с корпоративным календарём Microsoft Exchange / Outlook.
//
// Поддерживаем два режима:
//  1) Microsoft Graph API (рекомендуемый) — Authorization Code + PKCE для desktop.
//     В идеале в Windows это открывается во встроенном WebView2-окне Tauri, но
//     в корпоративных средах Intune / AD это иногда блокируется политиками, поэтому
//     даём fallback на loopback redirect `http://127.0.0.1:{port}/callback`.
//  2) EWS (Exchange Web Services) — для on-premise Exchange без Graph API.
//     Поддерживается Basic auth и полноценный NTLM client-side handshake через sspi.
//
// Важно: это production-oriented skeleton с реальным HTTP/JSON/XML-потоком,
// локальным кэшем на день и хранением refresh token в keyring. При этом для
// embedded WebView2 здесь реализован best-effort путь через отдельное Tauri
// окно `msal-auth`; если политика блокирует такой поток, фронтенду возвращается
// понятная ошибка с рекомендацией использовать loopback fallback.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use keyring::Entry;
use oauth2::{
    basic::BasicClient, AuthUrl, AuthorizationCode, ClientId, CsrfToken, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, RefreshToken, Scope, TokenResponse, TokenUrl,
};
use quick_xml::events::Event;
use quick_xml::Reader;
use rand::{distributions::Alphanumeric, Rng};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::{Response, StatusCode};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sspi::{
    AuthIdentity, BufferType, ClientRequestFlags, CredentialUse, DataRepresentation, Ntlm,
    SecurityBuffer, SecurityStatus, Sspi, SspiImpl, Username,
};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tiny_http::{Response as TinyHttpResponse, Server};
use url::Url;

use crate::bulk_wizard::WizardDb;

const GRAPH_AUTH_BASE: &str = "https://login.microsoftonline.com";
const GRAPH_API_BASE: &str = "https://graph.microsoft.com/v1.0";
const ACCESS_TOKEN_TTL_SAFETY_SECONDS: i64 = 120;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExchangeAuthMode {
    Graph,
    Ews,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EwsAuthType {
    Basic,
    Ntlm,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExchangeConnectionParams {
    pub auth_mode: ExchangeAuthMode,
    pub ews_url: Option<String>,
    pub username: String,
    pub secret_ref: String,
    pub tenant_id: Option<String>,
    pub client_id: Option<String>,
    pub refresh_token_secret_ref: Option<String>,
    pub min_event_minutes: Option<i64>,
    pub exclude_free_busy: Option<bool>,
    pub exclude_declined: Option<bool>,
    pub ews_auth_type: Option<EwsAuthType>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExchangeProfileDto {
    pub id: Option<i64>,
    pub name: String,
    pub auth_mode: ExchangeAuthMode,
    pub ews_url: Option<String>,
    pub ews_auth_type: Option<EwsAuthType>,
    pub username: String,
    pub secret_ref: String,
    pub tenant_id: Option<String>,
    pub client_id: Option<String>,
    pub refresh_token_secret_ref: Option<String>,
    pub min_event_minutes: Option<i64>,
    pub exclude_free_busy: Option<bool>,
    pub exclude_declined: Option<bool>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CalendarEventDto {
    pub id: String,
    pub subject: String,
    pub start_at: String,
    pub end_at: String,
    pub duration_minutes: i64,
    pub attendees: Vec<String>,
    pub category: Option<String>,
    pub color: Option<String>,
    pub online_meeting_url: Option<String>,
    pub response_status: Option<String>,
    pub show_as: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphAuthStartResult {
    pub auth_url: String,
    pub state: String,
    pub redirect_url: String,
    pub window_label: String,
    pub mode: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphAuthCompleteResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CachedTokenEnvelope {
    access_token: String,
    refresh_token: Option<String>,
    expires_at_utc: String,
}

#[derive(thiserror::Error, Debug)]
pub enum ExchangeError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("OAuth error: {0}")]
    OAuth(String),
    #[error("EWS SOAP parse error: {0}")]
    Soap(String),
    #[error("Secret not found for ref {0}")]
    SecretNotFound(String),
    #[error("Missing required setting: {0}")]
    MissingSetting(String),
    #[error("Corporate policy appears to block embedded OAuth/WebView2 or redirect handling. Try loopback OAuth fallback. Details: {0}")]
    OAuthBlocked(String),
    #[error("NTLM handshake failed: {0}")]
    Ntlm(String),
    #[error("Other: {0}")]
    Other(String),
}

impl From<ExchangeError> for String {
    fn from(value: ExchangeError) -> Self {
        value.to_string()
    }
}

fn lock_db(db: &State<'_, WizardDb>) -> Result<std::sync::MutexGuard<'_, Connection>, ExchangeError> {
    db.0.lock().map_err(|e| ExchangeError::Other(e.to_string()))
}

fn get_secret(secret_ref: &str) -> Result<String, ExchangeError> {
    let entry = Entry::new("jiratime", secret_ref).map_err(|e| ExchangeError::Other(e.to_string()))?;
    entry
        .get_password()
        .map_err(|_| ExchangeError::SecretNotFound(secret_ref.to_string()))
}

fn set_secret(secret_ref: &str, value: &str) -> Result<(), ExchangeError> {
    let entry = Entry::new("jiratime", secret_ref).map_err(|e| ExchangeError::Other(e.to_string()))?;
    entry
        .set_password(value)
        .map_err(|e| ExchangeError::Other(e.to_string()))
}

fn build_http_client() -> Result<reqwest::Client, ExchangeError> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| ExchangeError::Other(format!("cannot build http client: {e}")))
}

fn local_callback_port() -> u16 {
    43891
}

fn graph_client(params: &ExchangeConnectionParams, redirect_url: &str) -> Result<BasicClient, ExchangeError> {
    let tenant = params
        .tenant_id
        .clone()
        .ok_or_else(|| ExchangeError::MissingSetting("tenant_id".to_string()))?;
    let client_id = params
        .client_id
        .clone()
        .ok_or_else(|| ExchangeError::MissingSetting("client_id".to_string()))?;

    let auth_url = AuthUrl::new(format!("{GRAPH_AUTH_BASE}/{tenant}/oauth2/v2.0/authorize"))
        .map_err(|e| ExchangeError::OAuth(e.to_string()))?;
    let token_url = TokenUrl::new(format!("{GRAPH_AUTH_BASE}/{tenant}/oauth2/v2.0/token"))
        .map_err(|e| ExchangeError::OAuth(e.to_string()))?;
    let redirect = RedirectUrl::new(redirect_url.to_string()).map_err(|e| ExchangeError::OAuth(e.to_string()))?;

    Ok(BasicClient::new(ClientId::new(client_id), None, auth_url, Some(token_url)).set_redirect_uri(redirect))
}

fn graph_token_cache_ref(params: &ExchangeConnectionParams) -> Result<String, ExchangeError> {
    params
        .refresh_token_secret_ref
        .clone()
        .ok_or_else(|| ExchangeError::MissingSetting("refresh_token_secret_ref".to_string()))
}

fn read_cached_token(params: &ExchangeConnectionParams) -> Result<Option<CachedTokenEnvelope>, ExchangeError> {
    let secret_ref = graph_token_cache_ref(params)?;
    let entry = Entry::new("jiratime", &secret_ref).map_err(|e| ExchangeError::Other(e.to_string()))?;
    let value = match entry.get_password() {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let parsed: CachedTokenEnvelope = serde_json::from_str(&value)
        .map_err(|e| ExchangeError::Other(format!("invalid cached graph token envelope: {e}")))?;
    Ok(Some(parsed))
}

fn write_cached_token(params: &ExchangeConnectionParams, token: &CachedTokenEnvelope) -> Result<(), ExchangeError> {
    let secret_ref = graph_token_cache_ref(params)?;
    let json = serde_json::to_string(token).map_err(|e| ExchangeError::Other(e.to_string()))?;
    set_secret(&secret_ref, &json)
}

fn token_is_fresh(token: &CachedTokenEnvelope) -> bool {
    let expires_at = DateTime::parse_from_rfc3339(&token.expires_at_utc)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now() - ChronoDuration::minutes(5));
    expires_at > Utc::now() + ChronoDuration::seconds(ACCESS_TOKEN_TTL_SAFETY_SECONDS)
}

async fn refresh_graph_access_token(params: &ExchangeConnectionParams, refresh_token: &str) -> Result<CachedTokenEnvelope, ExchangeError> {
    let client = build_http_client()?;
    let oauth = graph_client(params, &format!("http://127.0.0.1:{}/callback", local_callback_port()))?;
    let token = oauth
        .exchange_refresh_token(&RefreshToken::new(refresh_token.to_string()))
        .add_scope(Scope::new("Calendars.Read".to_string()))
        .request_async(&client)
        .await
        .map_err(|e| ExchangeError::OAuth(e.to_string()))?;

    let expires_at = Utc::now() + ChronoDuration::seconds(token.expires_in().map(|d| d.as_secs() as i64).unwrap_or(3600));
    Ok(CachedTokenEnvelope {
        access_token: token.access_token().secret().to_string(),
        refresh_token: token
            .refresh_token()
            .map(|rt| rt.secret().to_string())
            .or_else(|| Some(refresh_token.to_string())),
        expires_at_utc: expires_at.to_rfc3339(),
    })
}

async fn ensure_graph_access_token(params: &ExchangeConnectionParams) -> Result<String, ExchangeError> {
    if let Some(cached) = read_cached_token(params)? {
        if token_is_fresh(&cached) {
            return Ok(cached.access_token);
        }
        if let Some(rt) = &cached.refresh_token {
            let refreshed = refresh_graph_access_token(params, rt).await?;
            write_cached_token(params, &refreshed)?;
            return Ok(refreshed.access_token);
        }
    }
    Err(ExchangeError::OAuthBlocked(
        "Graph access token missing or expired and no refresh token is available. Reconnect calendar via OAuth login in Settings.".to_string(),
    ))
}

fn random_state(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

#[tauri::command]
pub async fn start_graph_oauth_embedded(
    app: AppHandle,
    params: ExchangeConnectionParams,
) -> Result<GraphAuthStartResult, String> {
    let redirect_url = format!("http://127.0.0.1:{}/callback", local_callback_port());
    let oauth = graph_client(&params, &redirect_url).map_err(String::from)?;
    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let state = CsrfToken::new_random();
    let window_label = format!("msal-auth-{}", random_state(8));

    let (auth_url, csrf) = oauth
        .authorize_url(|| state)
        .add_scope(Scope::new("Calendars.Read".to_string()))
        .add_scope(Scope::new("offline_access".to_string()))
        .add_scope(Scope::new("openid".to_string()))
        .add_scope(Scope::new("profile".to_string()))
        .set_pkce_challenge(pkce_challenge)
        .url();

    app.manage(GraphOAuthEphemeralState(Mutex::new(Some(EphemeralOauthState {
        pkce_verifier: pkce_verifier.secret().to_string(),
        state: csrf.secret().to_string(),
        redirect_url: redirect_url.clone(),
        params: params.clone(),
    }))));

    WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::External(auth_url.clone()))
        .title("Вход в Microsoft / Outlook")
        .inner_size(980.0, 760.0)
        .build()
        .map_err(|e| ExchangeError::OAuthBlocked(format!("cannot open embedded WebView2 window: {e}")))?;

    Ok(GraphAuthStartResult {
        auth_url: auth_url.to_string(),
        state: csrf.secret().to_string(),
        redirect_url,
        window_label,
        mode: "embedded_then_loopback".to_string(),
    })
}

#[derive(Debug, Clone)]
struct EphemeralOauthState {
    pkce_verifier: String,
    state: String,
    redirect_url: String,
    params: ExchangeConnectionParams,
}

pub struct GraphOAuthEphemeralState(pub Mutex<Option<EphemeralOauthState>>);

#[tauri::command]
pub async fn complete_graph_oauth_loopback(app: AppHandle) -> Result<GraphAuthCompleteResult, String> {
    let state = app
        .try_state::<GraphOAuthEphemeralState>()
        .ok_or_else(|| ExchangeError::Other("GraphOAuthEphemeralState is not initialized".to_string()))?;

    let oauth_state = state
        .0
        .lock()
        .map_err(|e| ExchangeError::Other(e.to_string()))?
        .clone()
        .ok_or_else(|| ExchangeError::Other("OAuth flow not started".to_string()))?;

    let server = Server::http(format!("127.0.0.1:{}", local_callback_port()))
        .map_err(|e| ExchangeError::OAuthBlocked(format!("cannot bind localhost redirect listener: {e}")))?;

    let request = server
        .recv_timeout(Duration::from_secs(180))
        .map_err(|e| ExchangeError::OAuthBlocked(format!("OAuth redirect was not received within timeout: {e}")))?
        .ok_or_else(|| ExchangeError::OAuthBlocked("OAuth redirect timed out. Embedded browser or loopback redirect may be blocked by corporate policy.".to_string()))?;

    let url = Url::parse(&format!("http://127.0.0.1{}", request.url()))
        .map_err(|e| ExchangeError::OAuth(format!("invalid redirect url: {e}")))?;
    let params_q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

    if let Some(err) = params_q.get("error") {
        let _ = request.respond(TinyHttpResponse::from_string("OAuth failed. You can close this tab/window."));
        return Err(ExchangeError::OAuthBlocked(format!(
            "OAuth provider returned error={err}, description={}",
            params_q.get("error_description").cloned().unwrap_or_default()
        ))
        .into());
    }

    let code = params_q
        .get("code")
        .cloned()
        .ok_or_else(|| ExchangeError::OAuthBlocked("authorization code missing in redirect".to_string()))?;
    let returned_state = params_q
        .get("state")
        .cloned()
        .ok_or_else(|| ExchangeError::OAuth("state missing in redirect".to_string()))?;
    if returned_state != oauth_state.state {
        let _ = request.respond(TinyHttpResponse::from_string("OAuth state mismatch. You can close this tab/window."));
        return Err(ExchangeError::OAuth("OAuth state mismatch".to_string()).into());
    }

    let _ = request.respond(TinyHttpResponse::from_string(
        "Авторизация завершена. Можно закрыть это окно и вернуться в JiraTime.",
    ));

    let client = build_http_client().map_err(String::from)?;
    let oauth = graph_client(&oauth_state.params, &oauth_state.redirect_url).map_err(String::from)?;
    let token = oauth
        .exchange_code(AuthorizationCode::new(code))
        .set_pkce_verifier(PkceCodeVerifier::new(oauth_state.pkce_verifier.clone()))
        .request_async(&client)
        .await
        .map_err(|e| ExchangeError::OAuth(e.to_string()))
        .map_err(String::from)?;

    let expires_at = Utc::now() + ChronoDuration::seconds(token.expires_in().map(|d| d.as_secs() as i64).unwrap_or(3600));
    let envelope = CachedTokenEnvelope {
        access_token: token.access_token().secret().to_string(),
        refresh_token: token.refresh_token().map(|rt| rt.secret().to_string()),
        expires_at_utc: expires_at.to_rfc3339(),
    };
    write_cached_token(&oauth_state.params, &envelope).map_err(String::from)?;

    if let Some(window) = app.get_webview_window("msal-auth") {
        let _ = window.close();
    }

    Ok(GraphAuthCompleteResult {
        ok: true,
        message: "Календарь Microsoft Graph успешно подключён. Refresh token сохранён в защищённом хранилище Windows Credential Manager/keyring.".to_string(),
    })
}

async fn fetch_graph_calendar_events(
    params: &ExchangeConnectionParams,
    date_from: &str,
    date_to: &str,
) -> Result<Vec<CalendarEventDto>, ExchangeError> {
    let access_token = ensure_graph_access_token(params).await?;
    let client = build_http_client()?;

    let endpoint = format!(
        "{GRAPH_API_BASE}/me/calendarview?startDateTime={}&endDateTime={}",
        urlencoding::encode(date_from),
        urlencoding::encode(date_to)
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}"))
            .map_err(|e| ExchangeError::Other(e.to_string()))?,
    );
    headers.insert("Prefer", HeaderValue::from_static("outlook.timezone=\"UTC\""));

    let payload: Value = client
        .get(endpoint)
        .headers(headers)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let mut out = Vec::new();
    for item in payload.get("value").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let subject = item.get("subject").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let start_at = item
            .get("start")
            .and_then(|v| v.get("dateTime"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let end_at = item
            .get("end")
            .and_then(|v| v.get("dateTime"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if start_at.is_empty() || end_at.is_empty() {
            continue;
        }

        let start_dt = DateTime::parse_from_rfc3339(&format!("{}+00:00", start_at.replace(' ', "T")))
            .or_else(|_| DateTime::parse_from_rfc3339(&start_at))
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        let end_dt = DateTime::parse_from_rfc3339(&format!("{}+00:00", end_at.replace(' ', "T")))
            .or_else(|_| DateTime::parse_from_rfc3339(&end_at))
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| start_dt);
        let duration_minutes = (end_dt - start_dt).num_minutes().max(0);

        let attendees = item
            .get("attendees")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|a| {
                a.get("emailAddress")
                    .and_then(|e| e.get("address"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string())
            })
            .collect::<Vec<_>>();

        let category = item
            .get("categories")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let color = item
            .get("categories")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let online_meeting_url = item
            .get("onlineMeeting")
            .and_then(|v| v.get("joinUrl"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| item.get("webLink").and_then(|v| v.as_str()).map(|s| s.to_string()));

        let response_status = item
            .get("responseStatus")
            .and_then(|v| v.get("response"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let show_as = item.get("showAs").and_then(|v| v.as_str()).map(|s| s.to_string());

        out.push(CalendarEventDto {
            id: item.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            subject,
            start_at: start_dt.to_rfc3339(),
            end_at: end_dt.to_rfc3339(),
            duration_minutes,
            attendees,
            category,
            color,
            online_meeting_url,
            response_status,
            show_as,
        });
    }

    Ok(out)
}

fn build_ews_finditem_body(start: &str, end: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>AllProperties</t:BaseShape>
      </m:ItemShape>
      <m:CalendarView StartDate="{start}" EndDate="{end}" />
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="calendar" />
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>"#
    )
}

fn basic_auth_header(username: &str, password: &str) -> String {
    let raw = format!("{username}:{password}");
    format!("Basic {}", BASE64_STANDARD.encode(raw.as_bytes()))
}

fn username_for_ntlm(raw_username: &str) -> Result<Username, ExchangeError> {
    Username::parse(raw_username).map_err(|e| ExchangeError::Ntlm(format!("invalid NTLM username '{raw_username}': {e}")))
}

fn extract_ntlm_challenge(response: &Response) -> Option<String> {
    response
        .headers()
        .get_all(WWW_AUTHENTICATE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|header| {
            let trimmed = header.trim();
            if trimmed.eq_ignore_ascii_case("NTLM") {
                return Some(String::new());
            }
            trimmed
                .strip_prefix("NTLM ")
                .or_else(|| trimmed.strip_prefix("ntlm "))
                .map(|v| v.trim().to_string())
        })
}

fn make_ntlm_negotiate_message(username: &str, password: &str) -> Result<String, ExchangeError> {
    let mut ntlm = Ntlm::new();
    let identity = AuthIdentity {
        username: username_for_ntlm(username)?,
        password: password.to_string().into(),
    };

    let mut acq_cred = ntlm
        .acquire_credentials_handle()
        .with_credential_use(CredentialUse::Outbound)
        .with_auth_data(&identity)
        .execute(&mut ntlm)
        .map_err(|e| ExchangeError::Ntlm(format!("acquire_credentials_handle failed: {e}")))?;

    let mut output = vec![SecurityBuffer::new(Vec::new(), BufferType::Token)];
    let mut builder = ntlm
        .initialize_security_context()
        .with_credentials_handle(&mut acq_cred.credentials_handle)
        .with_context_requirements(ClientRequestFlags::CONFIDENTIALITY | ClientRequestFlags::ALLOCATE_MEMORY)
        .with_target_data_representation(DataRepresentation::Native)
        .with_output(&mut output);

    let result = ntlm
        .initialize_security_context_impl(&mut builder)
        .map_err(|e| ExchangeError::Ntlm(format!("initialize_security_context negotiate failed: {e}")))?
        .resolve_to_result()
        .map_err(|e| ExchangeError::Ntlm(format!("resolve_to_result negotiate failed: {e}")))?;

    if result.status != SecurityStatus::ContinueNeeded && result.status != SecurityStatus::Ok {
        return Err(ExchangeError::Ntlm(format!(
            "unexpected negotiate security status: {:?}",
            result.status
        )));
    }

    let token = output
        .into_iter()
        .next()
        .map(|b| b.buffer)
        .filter(|b| !b.is_empty())
        .ok_or_else(|| ExchangeError::Ntlm("NTLM negotiate token is empty".to_string()))?;

    Ok(format!("NTLM {}", BASE64_STANDARD.encode(token)))
}

fn make_ntlm_authenticate_message(username: &str, password: &str, challenge_b64: &str) -> Result<String, ExchangeError> {
    let mut ntlm = Ntlm::new();
    let identity = AuthIdentity {
        username: username_for_ntlm(username)?,
        password: password.to_string().into(),
    };

    let mut acq_cred = ntlm
        .acquire_credentials_handle()
        .with_credential_use(CredentialUse::Outbound)
        .with_auth_data(&identity)
        .execute(&mut ntlm)
        .map_err(|e| ExchangeError::Ntlm(format!("acquire_credentials_handle failed: {e}")))?;

    let mut negotiate_output = vec![SecurityBuffer::new(Vec::new(), BufferType::Token)];
    let mut negotiate_builder = ntlm
        .initialize_security_context()
        .with_credentials_handle(&mut acq_cred.credentials_handle)
        .with_context_requirements(ClientRequestFlags::CONFIDENTIALITY | ClientRequestFlags::ALLOCATE_MEMORY)
        .with_target_data_representation(DataRepresentation::Native)
        .with_output(&mut negotiate_output);

    let _ = ntlm
        .initialize_security_context_impl(&mut negotiate_builder)
        .map_err(|e| ExchangeError::Ntlm(format!("initialize_security_context first leg failed: {e}")))?
        .resolve_to_result()
        .map_err(|e| ExchangeError::Ntlm(format!("resolve_to_result first leg failed: {e}")))?;

    let challenge_bytes = BASE64_STANDARD
        .decode(challenge_b64.as_bytes())
        .map_err(|e| ExchangeError::Ntlm(format!("cannot decode NTLM challenge: {e}")))?;
    let mut input = vec![SecurityBuffer::new(challenge_bytes, BufferType::Token)];
    let mut output = vec![SecurityBuffer::new(Vec::new(), BufferType::Token)];

    let mut authenticate_builder = ntlm
        .initialize_security_context()
        .with_credentials_handle(&mut acq_cred.credentials_handle)
        .with_context_requirements(ClientRequestFlags::CONFIDENTIALITY | ClientRequestFlags::ALLOCATE_MEMORY)
        .with_target_data_representation(DataRepresentation::Native)
        .with_input(&mut input)
        .with_output(&mut output);

    let result = ntlm
        .initialize_security_context_impl(&mut authenticate_builder)
        .map_err(|e| ExchangeError::Ntlm(format!("initialize_security_context authenticate failed: {e}")))?
        .resolve_to_result()
        .map_err(|e| ExchangeError::Ntlm(format!("resolve_to_result authenticate failed: {e}")))?;

    if result.status != SecurityStatus::Ok
        && result.status != SecurityStatus::CompleteNeeded
        && result.status != SecurityStatus::CompleteAndContinue
    {
        return Err(ExchangeError::Ntlm(format!(
            "unexpected authenticate security status: {:?}",
            result.status
        )));
    }

    let token = output
        .into_iter()
        .next()
        .map(|b| b.buffer)
        .filter(|b| !b.is_empty())
        .ok_or_else(|| ExchangeError::Ntlm("NTLM authenticate token is empty".to_string()))?;

    Ok(format!("NTLM {}", BASE64_STANDARD.encode(token)))
}

async fn fetch_ews_calendar_events_with_ntlm(
    client: &reqwest::Client,
    ews_url: &str,
    username: &str,
    password: &str,
    body: String,
) -> Result<Vec<CalendarEventDto>, ExchangeError> {
    let negotiate_header = make_ntlm_negotiate_message(username, password)?;
    let first = client
        .post(ews_url)
        .header(CONTENT_TYPE, "text/xml; charset=utf-8")
        .header("Accept", "text/xml")
        .header(AUTHORIZATION, negotiate_header)
        .body(body.clone())
        .send()
        .await?;

    if first.status() == StatusCode::OK {
        let xml = first.text().await?;
        return parse_ews_finditem_response(&xml);
    }

    let challenge = extract_ntlm_challenge(&first).ok_or_else(|| {
        ExchangeError::Ntlm(format!(
            "server did not return NTLM challenge, status={}",
            first.status()
        ))
    })?;

    if challenge.is_empty() {
        return Err(ExchangeError::Ntlm(
            "server responded with bare 'WWW-Authenticate: NTLM' but no challenge blob; retry path is ambiguous".to_string(),
        ));
    }

    let authenticate_header = make_ntlm_authenticate_message(username, password, &challenge)?;
    let second = client
        .post(ews_url)
        .header(CONTENT_TYPE, "text/xml; charset=utf-8")
        .header("Accept", "text/xml")
        .header(AUTHORIZATION, authenticate_header)
        .body(body)
        .send()
        .await?
        .error_for_status()?;

    let xml = second.text().await?;
    parse_ews_finditem_response(&xml)
}

async fn fetch_ews_calendar_events(
    params: &ExchangeConnectionParams,
    date_from: &str,
    date_to: &str,
) -> Result<Vec<CalendarEventDto>, ExchangeError> {
    let ews_url = params
        .ews_url
        .clone()
        .ok_or_else(|| ExchangeError::MissingSetting("ews_url".to_string()))?;
    let password = get_secret(&params.secret_ref)?;
    let client = build_http_client()?;
    let body = build_ews_finditem_body(date_from, date_to);

    match params.ews_auth_type.clone().unwrap_or(EwsAuthType::Basic) {
        EwsAuthType::Basic => {
            let xml = client
                .post(&ews_url)
                .header(CONTENT_TYPE, "text/xml; charset=utf-8")
                .header("Accept", "text/xml")
                .header(AUTHORIZATION, basic_auth_header(&params.username, &password))
                .body(body)
                .send()
                .await?
                .error_for_status()?
                .text()
                .await?;
            parse_ews_finditem_response(&xml)
        }
        EwsAuthType::Ntlm => fetch_ews_calendar_events_with_ntlm(
            &client,
            &ews_url,
            &params.username,
            &password,
            body,
        )
        .await,
    }
}

fn parse_ews_finditem_response(xml: &str) -> Result<Vec<CalendarEventDto>, ExchangeError> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    let mut in_calendar_item = false;
    let mut current_tag = String::new();
    let mut subject = String::new();
    let mut item_id = String::new();
    let mut start = String::new();
    let mut end = String::new();
    let mut response_status = None::<String>;
    let mut show_as = None::<String>;
    let mut categories: Vec<String> = Vec::new();
    let mut attendees: Vec<String> = Vec::new();
    let mut web_link: Option<String> = None;
    let mut out = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                current_tag = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if current_tag == "CalendarItem" {
                    in_calendar_item = true;
                    subject.clear();
                    item_id.clear();
                    start.clear();
                    end.clear();
                    response_status = None;
                    show_as = None;
                    categories.clear();
                    attendees.clear();
                    web_link = None;
                }
                if current_tag == "ItemId" && in_calendar_item {
                    for attr in e.attributes().flatten() {
                        let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                        if key.ends_with("Id") {
                            item_id = String::from_utf8_lossy(attr.value.as_ref()).to_string();
                        }
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if !in_calendar_item {
                    buf.clear();
                    continue;
                }
                let text = t.unescape().map(|v| v.to_string()).unwrap_or_default();
                match current_tag.as_str() {
                    "Subject" => subject = text,
                    "Start" => start = text,
                    "End" => end = text,
                    "ResponseType" => response_status = Some(text),
                    "LegacyFreeBusyStatus" => show_as = Some(text),
                    "String" => categories.push(text),
                    "EmailAddress" => attendees.push(text),
                    "WebClientReadFormQueryString" => web_link = Some(text),
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let tag = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if tag == "CalendarItem" {
                    in_calendar_item = false;
                    let start_dt = DateTime::parse_from_rfc3339(&start)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now());
                    let end_dt = DateTime::parse_from_rfc3339(&end)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| start_dt);
                    out.push(CalendarEventDto {
                        id: item_id.clone(),
                        subject: subject.clone(),
                        start_at: start_dt.to_rfc3339(),
                        end_at: end_dt.to_rfc3339(),
                        duration_minutes: (end_dt - start_dt).num_minutes().max(0),
                        attendees: attendees.clone(),
                        category: categories.first().cloned(),
                        color: categories.first().cloned(),
                        online_meeting_url: web_link.clone(),
                        response_status: response_status.clone(),
                        show_as: show_as.clone(),
                    });
                }
                current_tag.clear();
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(ExchangeError::Soap(e.to_string())),
            _ => {}
        }
        buf.clear();
    }

    Ok(out)
}

fn should_keep_event(event: &CalendarEventDto, params: &ExchangeConnectionParams) -> bool {
    if params.exclude_declined.unwrap_or(true)
        && event
            .response_status
            .as_deref()
            .map(|s| s.eq_ignore_ascii_case("declined"))
            .unwrap_or(false)
    {
        return false;
    }

    if params.exclude_free_busy.unwrap_or(true) {
        if let Some(show_as) = &event.show_as {
            let low = show_as.to_lowercase();
            if low == "free" || low == "oof" || low == "outofoffice" {
                return false;
            }
        }
        if event.subject.trim().is_empty() {
            return false;
        }
    }

    if let Some(min_minutes) = params.min_event_minutes {
        if min_minutes > 0 && event.duration_minutes < min_minutes {
            return false;
        }
    }

    true
}

fn cache_day_key(dt: &DateTime<Utc>) -> String {
    dt.date_naive().to_string()
}

fn read_cached_calendar_events(
    db: &State<'_, WizardDb>,
    date_from: &str,
    date_to: &str,
) -> Result<Vec<CalendarEventDto>, ExchangeError> {
    let conn = lock_db(db)?;
    let mut stmt = conn
        .prepare(
            "SELECT event_id, subject, start_at, end_at, attendees, category, online_meeting_url, response_status, show_as
             FROM calendar_events_cache
             WHERE cached_date BETWEEN ?1 AND ?2
             ORDER BY start_at ASC",
        )
        .map_err(|e| ExchangeError::Other(e.to_string()))?;

    let rows = stmt
        .query_map(params![date_from, date_to], |row| {
            let attendees_json: String = row.get(4)?;
            let attendees = serde_json::from_str::<Vec<String>>(&attendees_json).unwrap_or_default();
            let start_at: String = row.get(2)?;
            let end_at: String = row.get(3)?;
            let start_dt = DateTime::parse_from_rfc3339(&start_at)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            let end_dt = DateTime::parse_from_rfc3339(&end_at)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| start_dt);
            Ok(CalendarEventDto {
                id: row.get(0)?,
                subject: row.get(1)?,
                start_at,
                end_at,
                duration_minutes: (end_dt - start_dt).num_minutes().max(0),
                attendees,
                category: row.get(5)?,
                color: row.get(5)?,
                online_meeting_url: row.get(6)?,
                response_status: row.get(7)?,
                show_as: row.get(8)?,
            })
        })
        .map_err(|e| ExchangeError::Other(e.to_string()))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| ExchangeError::Other(e.to_string()))
}

fn upsert_cached_calendar_events(db: &State<'_, WizardDb>, events: &[CalendarEventDto]) -> Result<(), ExchangeError> {
    let conn = lock_db(db)?;
    let tx = conn.unchecked_transaction().map_err(|e| ExchangeError::Other(e.to_string()))?;
    for ev in events {
        let start_dt = DateTime::parse_from_rfc3339(&ev.start_at)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        let attendees_json = serde_json::to_string(&ev.attendees).map_err(|e| ExchangeError::Other(e.to_string()))?;
        tx.execute(
            "INSERT INTO calendar_events_cache (event_id, subject, start_at, end_at, attendees, category, online_meeting_url, response_status, show_as, cached_date, cached_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
             ON CONFLICT(event_id) DO UPDATE SET
               subject = excluded.subject,
               start_at = excluded.start_at,
               end_at = excluded.end_at,
               attendees = excluded.attendees,
               category = excluded.category,
               online_meeting_url = excluded.online_meeting_url,
               response_status = excluded.response_status,
               show_as = excluded.show_as,
               cached_date = excluded.cached_date,
               cached_at = datetime('now')",
            params![
                ev.id,
                ev.subject,
                ev.start_at,
                ev.end_at,
                attendees_json,
                ev.category,
                ev.online_meeting_url,
                ev.response_status,
                ev.show_as,
                cache_day_key(&start_dt),
            ],
        )
        .map_err(|e| ExchangeError::Other(e.to_string()))?;
    }
    tx.commit().map_err(|e| ExchangeError::Other(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn list_exchange_profiles(db: State<'_, WizardDb>) -> Result<Vec<ExchangeProfileDto>, String> {
    let conn = lock_db(&db).map_err(String::from)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, auth_mode, ews_url, ews_auth_type, username, secret_ref, tenant_id, client_id,
                    refresh_token_secret_ref, min_event_minutes, exclude_free_busy, exclude_declined, is_active
             FROM exchange_profiles
             ORDER BY is_active DESC, updated_at DESC, id DESC",
        )
        .map_err(|e| ExchangeError::Other(e.to_string()))
        .map_err(String::from)?;

    let rows = stmt
        .query_map([], |row| {
            let auth_mode_s: String = row.get(2)?;
            let ews_auth_type_s: Option<String> = row.get(4)?;
            Ok(ExchangeProfileDto {
                id: Some(row.get(0)?),
                name: row.get(1)?,
                auth_mode: match auth_mode_s.as_str() {
                    "ews" => ExchangeAuthMode::Ews,
                    _ => ExchangeAuthMode::Graph,
                },
                ews_url: row.get(3)?,
                ews_auth_type: Some(match ews_auth_type_s.as_deref().unwrap_or("basic") {
                    "ntlm" => EwsAuthType::Ntlm,
                    _ => EwsAuthType::Basic,
                }),
                username: row.get(5)?,
                secret_ref: row.get(6)?,
                tenant_id: row.get(7)?,
                client_id: row.get(8)?,
                refresh_token_secret_ref: row.get(9)?,
                min_event_minutes: Some(row.get(10)?),
                exclude_free_busy: Some(row.get::<_, i64>(11)? != 0),
                exclude_declined: Some(row.get::<_, i64>(12)? != 0),
                is_active: Some(row.get::<_, i64>(13)? != 0),
            })
        })
        .map_err(|e| ExchangeError::Other(e.to_string()))
        .map_err(String::from)?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| ExchangeError::Other(e.to_string()).to_string())
}

#[tauri::command]
pub fn save_exchange_profile(db: State<'_, WizardDb>, profile: ExchangeProfileDto) -> Result<i64, String> {
    let conn = lock_db(&db).map_err(String::from)?;
    let auth_mode = match profile.auth_mode {
        ExchangeAuthMode::Graph => "graph",
        ExchangeAuthMode::Ews => "ews",
    };
    let ews_auth_type = match profile.ews_auth_type.unwrap_or(EwsAuthType::Basic) {
        EwsAuthType::Basic => "basic",
        EwsAuthType::Ntlm => "ntlm",
    };
    let is_active = if profile.is_active.unwrap_or(false) { 1_i64 } else { 0_i64 };

    let tx = conn.unchecked_transaction().map_err(|e| ExchangeError::Other(e.to_string()))
        .map_err(String::from)?;

    if is_active != 0 {
        tx.execute("UPDATE exchange_profiles SET is_active = 0", [])
            .map_err(|e| ExchangeError::Other(e.to_string()))
            .map_err(String::from)?;
    }

    if let Some(id) = profile.id {
        tx.execute(
            "UPDATE exchange_profiles
             SET name = ?1,
                 auth_mode = ?2,
                 ews_url = ?3,
                 ews_auth_type = ?4,
                 username = ?5,
                 secret_ref = ?6,
                 tenant_id = ?7,
                 client_id = ?8,
                 refresh_token_secret_ref = ?9,
                 min_event_minutes = ?10,
                 exclude_free_busy = ?11,
                 exclude_declined = ?12,
                 is_active = ?13,
                 updated_at = datetime('now')
             WHERE id = ?14",
            params![
                profile.name,
                auth_mode,
                profile.ews_url,
                ews_auth_type,
                profile.username,
                profile.secret_ref,
                profile.tenant_id,
                profile.client_id,
                profile.refresh_token_secret_ref,
                profile.min_event_minutes.unwrap_or(0),
                if profile.exclude_free_busy.unwrap_or(true) { 1_i64 } else { 0_i64 },
                if profile.exclude_declined.unwrap_or(true) { 1_i64 } else { 0_i64 },
                is_active,
                id,
            ],
        )
        .map_err(|e| ExchangeError::Other(e.to_string()))
        .map_err(String::from)?;
        tx.commit().map_err(|e| ExchangeError::Other(e.to_string()))
            .map_err(String::from)?;
        Ok(id)
    } else {
        tx.execute(
            "INSERT INTO exchange_profiles (
                name, auth_mode, ews_url, ews_auth_type, username, secret_ref, tenant_id, client_id,
                refresh_token_secret_ref, min_event_minutes, exclude_free_busy, exclude_declined,
                is_active, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, datetime('now'), datetime('now'))",
            params![
                profile.name,
                auth_mode,
                profile.ews_url,
                ews_auth_type,
                profile.username,
                profile.secret_ref,
                profile.tenant_id,
                profile.client_id,
                profile.refresh_token_secret_ref,
                profile.min_event_minutes.unwrap_or(0),
                if profile.exclude_free_busy.unwrap_or(true) { 1_i64 } else { 0_i64 },
                if profile.exclude_declined.unwrap_or(true) { 1_i64 } else { 0_i64 },
                is_active,
            ],
        )
        .map_err(|e| ExchangeError::Other(e.to_string()))
        .map_err(String::from)?;
        let id = tx.last_insert_rowid();
        tx.commit().map_err(|e| ExchangeError::Other(e.to_string()))
            .map_err(String::from)?;
        Ok(id)
    }
}

#[tauri::command]
pub fn delete_exchange_profile(db: State<'_, WizardDb>, id: i64) -> Result<bool, String> {
    let conn = lock_db(&db).map_err(String::from)?;
    let deleted = conn
        .execute("DELETE FROM exchange_profiles WHERE id = ?1", params![id])
        .map_err(|e| ExchangeError::Other(e.to_string()))
        .map_err(String::from)?;
    Ok(deleted > 0)
}

#[tauri::command]
pub async fn get_calendar_events(
    db: State<'_, WizardDb>,
    params: ExchangeConnectionParams,
    date_from: String,
    date_to: String,
    force_refresh: Option<bool>,
) -> Result<Vec<CalendarEventDto>, String> {
    if !force_refresh.unwrap_or(false) {
        let cached = read_cached_calendar_events(&db, &date_from, &date_to).map_err(String::from)?;
        if !cached.is_empty() {
            return Ok(cached
                .into_iter()
                .filter(|ev| should_keep_event(ev, &params))
                .collect());
        }
    }

    let raw = match params.auth_mode {
        ExchangeAuthMode::Graph => fetch_graph_calendar_events(&params, &date_from, &date_to).await,
        ExchangeAuthMode::Ews => fetch_ews_calendar_events(&params, &date_from, &date_to).await,
    }
    .map_err(String::from)?;

    let filtered = raw
        .into_iter()
        .filter(|ev| should_keep_event(ev, &params))
        .collect::<Vec<_>>();
    upsert_cached_calendar_events(&db, &filtered).map_err(String::from)?;
    Ok(filtered)
}

#[tauri::command]
pub async fn test_exchange_connection(
    db: State<'_, WizardDb>,
    params: ExchangeConnectionParams,
) -> Result<bool, String> {
    let now = Utc::now();
    let from = now.to_rfc3339();
    let to = (now + ChronoDuration::days(1)).to_rfc3339();
    let _ = get_calendar_events(db, params, from, to, Some(true)).await?;
    Ok(true)
}
