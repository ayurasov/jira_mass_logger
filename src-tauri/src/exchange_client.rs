//! Exchange/Outlook calendar integration.
//!
//! Два режима подключения:
//!   1. Microsoft Graph API (auth_mode = "graph") — OAuth2 PKCE, scope Calendars.Read.
//!      Refresh-токен хранится в OS keychain через `secrets` модуль.
//!   2. EWS (Exchange Web Services, auth_mode = "ews") — SOAP FindItem,
//!      Basic или NTLM авторизация для on-premise Exchange.
//!
//! Все запросы к внешним API идут через Rust (не из Vue), чтобы избежать CORS и утечки токенов.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::bulk_wizard::WizardDb;

// ─────────────────────────────────────────────────────────────────
// Типы данных
// ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeConnectionParams {
    pub auth_mode: String, // "graph" | "ews"
    pub ews_url: Option<String>,
    pub username: String,
    pub secret_ref: String,
    pub tenant_id: Option<String>,
    pub client_id: Option<String>,
    pub refresh_token_secret_ref: Option<String>,
    pub min_event_minutes: Option<i64>,
    pub exclude_free_busy: Option<bool>,
    pub exclude_declined: Option<bool>,
    pub ews_auth_type: Option<String>, // "basic" | "ntlm"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeProfileDto {
    pub id: Option<i64>,
    pub name: String,
    pub auth_mode: String,
    pub ews_url: Option<String>,
    pub ews_auth_type: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    pub series_master_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphAuthStartResult {
    pub auth_url: String,
    pub state: String,
    pub redirect_url: String,
    pub window_label: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphAuthCompleteResult {
    pub ok: bool,
    pub message: String,
}

// Shared state для OAuth loopback flow
pub struct OAuthLoopbackState(pub Mutex<Option<LoopbackContext>>);

pub struct LoopbackContext {
    pub client_id: String,
    pub tenant_id: String,
    pub redirect_uri: String,
    pub code_verifier: String,
    pub state_token: String,
    pub secret_ref: String,
    pub profile_id: Option<i64>,
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

fn basic_auth_header(username: &str, password: &str) -> String {
    format!("Basic {}", BASE64.encode(format!("{username}:{password}")))
}

fn lock_db<'a>(db: &'a State<'a, WizardDb>) -> Result<std::sync::MutexGuard<'a, Connection>, String> {
    db.0.lock().map_err(|e| e.to_string())
}

/// Определяет надо ли сохранять событие по правилам фильтрации.
fn should_keep_event(ev: &CalendarEventDto, params: &ExchangeConnectionParams) -> bool {
    let exclude_declined = params.exclude_declined.unwrap_or(true);
    let exclude_free_busy = params.exclude_free_busy.unwrap_or(true);
    let min_minutes = params.min_event_minutes.unwrap_or(0);

    if exclude_declined {
        if let Some(rs) = &ev.response_status {
            if rs.eq_ignore_ascii_case("declined") {
                return false;
            }
        }
    }
    if exclude_free_busy {
        if let Some(show_as) = &ev.show_as {
            let low = show_as.to_lowercase();
            if low == "free" || low == "oof" || low == "outofoffice" {
                return false;
            }
        }
        if ev.subject.trim().is_empty() {
            return false;
        }
    }
    if min_minutes > 0 && ev.duration_minutes < min_minutes {
        return false;
    }
    true
}

// ─────────────────────────────────────────────────────────────────
// Graph API — получение событий
// ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GraphEventValue {
    id: Option<String>,
    subject: Option<String>,
    start: Option<GraphDateTimeTimeZone>,
    end: Option<GraphDateTimeTimeZone>,
    attendees: Option<Vec<GraphAttendee>>,
    categories: Option<Vec<String>>,
    #[serde(rename = "onlineMeetingUrl")]
    online_meeting_url: Option<String>,
    #[serde(rename = "responseStatus")]
    response_status: Option<GraphResponseStatus>,
    #[serde(rename = "showAs")]
    show_as: Option<String>,
    #[serde(rename = "seriesMasterId")]
    series_master_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphDateTimeTimeZone {
    #[serde(rename = "dateTime")]
    date_time: String,
    #[serde(rename = "timeZone")]
    time_zone: String,
}

#[derive(Debug, Deserialize)]
struct GraphAttendee {
    #[serde(rename = "emailAddress")]
    email_address: Option<GraphEmailAddress>,
}

#[derive(Debug, Deserialize)]
struct GraphEmailAddress {
    address: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphResponseStatus {
    response: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphEventsResponse {
    value: Option<Vec<GraphEventValue>>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

fn parse_graph_datetime(dt: &GraphDateTimeTimeZone) -> DateTime<Utc> {
    // Graph возвращает datetime без 'Z' в ряде TZ — нормализуем
    let s = if dt.time_zone.eq_ignore_ascii_case("UTC") && !dt.date_time.ends_with('Z') {
        format!("{}Z", dt.date_time)
    } else {
        dt.date_time.clone()
    };
    DateTime::parse_from_rfc3339(&s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

async fn fetch_graph_events(
    access_token: &str,
    date_from: &str,
    date_to: &str,
) -> Result<Vec<CalendarEventDto>> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .build()?;

    let mut url = format!(
        "https://graph.microsoft.com/v1.0/me/calendarview\
         ?startDateTime={date_from}&endDateTime={date_to}\
         &$select=id,subject,start,end,attendees,categories,onlineMeetingUrl,responseStatus,showAs,seriesMasterId\
         &$top=100"
    );

    let mut all: Vec<CalendarEventDto> = Vec::new();

    loop {
        let resp: GraphEventsResponse = client
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {access_token}"))
            .send()
            .await
            .context("Graph calendarview request")?
            .error_for_status()
            .context("Graph calendarview HTTP error")?
            .json()
            .await
            .context("Graph calendarview JSON parse")?;

        for ev in resp.value.unwrap_or_default() {
            let start_dt = ev.start.as_ref().map(parse_graph_datetime).unwrap_or_else(Utc::now);
            let end_dt = ev.end.as_ref().map(parse_graph_datetime).unwrap_or(start_dt);
            let duration_minutes = (end_dt - start_dt).num_minutes().max(0);

            let attendees = ev
                .attendees
                .unwrap_or_default()
                .into_iter()
                .filter_map(|a| a.email_address?.address)
                .collect();

            all.push(CalendarEventDto {
                id: ev.id.unwrap_or_default(),
                subject: ev.subject.unwrap_or_default(),
                start_at: start_dt.to_rfc3339(),
                end_at: end_dt.to_rfc3339(),
                duration_minutes,
                attendees,
                category: ev.categories.and_then(|c| c.into_iter().next()),
                color: None,
                online_meeting_url: ev.online_meeting_url,
                response_status: ev
                    .response_status
                    .and_then(|rs| rs.response),
                show_as: ev.show_as,
                series_master_id: ev.series_master_id,
            });
        }

        match resp.next_link {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }

    Ok(all)
}

// ─────────────────────────────────────────────────────────────────
// Graph OAuth2 — получение/обновление access token
// ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GraphTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

async fn refresh_graph_access_token(
    client_id: &str,
    tenant_id: &str,
    refresh_token: &str,
) -> Result<GraphTokenResponse> {
    let client = reqwest::Client::builder().use_rustls_tls().build()?;
    let params = [
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("scope", "Calendars.Read offline_access"),
    ];
    let resp: GraphTokenResponse = client
        .post(format!("https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"))
        .form(&params)
        .send()
        .await
        .context("token refresh request")?
        .error_for_status()
        .context("token refresh HTTP error")?
        .json()
        .await
        .context("token refresh JSON parse")?;
    Ok(resp)
}

async fn get_graph_access_token(conn_params: &ExchangeConnectionParams) -> Result<String> {
    let client_id = conn_params
        .client_id
        .as_deref()
        .ok_or_else(|| anyhow!("client_id is required for Graph auth"))?;
    let tenant_id = conn_params
        .tenant_id
        .as_deref()
        .unwrap_or("common");
    let refresh_ref = conn_params
        .refresh_token_secret_ref
        .as_deref()
        .ok_or_else(|| anyhow!("refresh_token_secret_ref is required for Graph auth"))?;

    let refresh_token = keyring::Entry::new("jiratime", refresh_ref)
        .and_then(|e| e.get_password())
        .map_err(|e| anyhow!("keychain read: {e}"))?;

    let token_resp = refresh_graph_access_token(client_id, tenant_id, &refresh_token).await?;

    // Если пришёл новый refresh_token — сохраняем
    if let Some(new_rt) = &token_resp.refresh_token {
        let _ = keyring::Entry::new("jiratime", refresh_ref).and_then(|e| e.set_password(new_rt));
    }

    Ok(token_resp.access_token)
}

// ─────────────────────────────────────────────────────────────────
// EWS — получение событий
// ─────────────────────────────────────────────────────────────────

fn ews_find_item_body(date_from: &str, date_to: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="calendar:Start"/>
          <t:FieldURI FieldURI="calendar:End"/>
          <t:FieldURI FieldURI="calendar:LegacyFreeBusyStatus"/>
          <t:FieldURI FieldURI="calendar:MyResponseType"/>
          <t:FieldURI FieldURI="calendar:CalendarItemType"/>
          <t:FieldURI FieldURI="calendar:RecurringMasterId"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:CalendarView StartDate="{date_from}" EndDate="{date_to}" MaxEntriesReturned="500"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="calendar"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>"#
    )
}

struct EwsRawEvent {
    id: String,
    subject: String,
    start: String,
    end: String,
    show_as: Option<String>,
    response_status: Option<String>,
    series_master_id: Option<String>,
}

fn parse_ews_finditem_response(xml: &str) -> Vec<EwsRawEvent> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut in_item = false;
    let mut current_tag = String::new();
    let mut ev = EwsRawEvent {
        id: String::new(),
        subject: String::new(),
        start: String::new(),
        end: String::new(),
        show_as: None,
        response_status: None,
        series_master_id: None,
    };
    let mut out: Vec<EwsRawEvent> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if local == "CalendarItem" {
                    in_item = true;
                    ev = EwsRawEvent {
                        id: String::new(), subject: String::new(),
                        start: String::new(), end: String::new(),
                        show_as: None, response_status: None, series_master_id: None,
                    };
                }
                if local == "ItemId" && in_item {
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"Id" {
                            ev.id = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                }
                current_tag = local;
            }
            Ok(Event::Empty(e)) => {
                let local = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if local == "ItemId" && in_item {
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"Id" {
                            ev.id = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if !in_item { buf.clear(); continue; }
                let text = t.unescape().map(|v| v.to_string()).unwrap_or_default();
                match current_tag.as_str() {
                    "Subject"               => ev.subject = text,
                    "Start"                 => ev.start = text,
                    "End"                   => ev.end = text,
                    "LegacyFreeBusyStatus"  => ev.show_as = Some(text),
                    "MyResponseType"        => ev.response_status = Some(text),
                    "RecurringMasterId"     => ev.series_master_id = Some(text),
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                if String::from_utf8_lossy(e.local_name().as_ref()) == "CalendarItem" {
                    in_item = false;
                    out.push(EwsRawEvent {
                        id: ev.id.clone(), subject: ev.subject.clone(),
                        start: ev.start.clone(), end: ev.end.clone(),
                        show_as: ev.show_as.clone(),
                        response_status: ev.response_status.clone(),
                        series_master_id: ev.series_master_id.clone(),
                    });
                }
                current_tag.clear();
            }
            Ok(Event::Eof) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

async fn fetch_ews_events(
    ews_url: &str,
    auth_header: &str,
    date_from: &str,
    date_to: &str,
) -> Result<Vec<CalendarEventDto>> {
    let body = ews_find_item_body(date_from, date_to);
    let client = reqwest::Client::builder().use_rustls_tls().build()?;
    let xml = client
        .post(ews_url)
        .header(AUTHORIZATION, auth_header)
        .header(CONTENT_TYPE, "text/xml; charset=utf-8")
        .body(body)
        .send()
        .await
        .context("EWS FindItem request")?
        .error_for_status()
        .context("EWS FindItem HTTP error")?
        .text()
        .await
        .context("EWS response text")?;

    let raw_events = parse_ews_finditem_response(&xml);
    let mut out = Vec::new();
    for r in raw_events {
        let start_dt = DateTime::parse_from_rfc3339(&r.start)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        let end_dt = DateTime::parse_from_rfc3339(&r.end)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or(start_dt);
        out.push(CalendarEventDto {
            id: r.id,
            subject: r.subject,
            start_at: start_dt.to_rfc3339(),
            end_at: end_dt.to_rfc3339(),
            duration_minutes: (end_dt - start_dt).num_minutes().max(0),
            attendees: vec![],
            category: None,
            color: None,
            online_meeting_url: None,
            response_status: r.response_status,
            show_as: r.show_as,
            series_master_id: r.series_master_id,
        });
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────
// Кэш событий в SQLite
// ─────────────────────────────────────────────────────────────────

fn load_cached_events(
    conn: &Connection,
    profile_id: i64,
    date: &str,
) -> Result<Vec<CalendarEventDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, subject, start_at, end_at, duration_minutes, attendees_json,
                category, color, online_meeting_url, response_status, show_as, series_master_id
         FROM calendar_events_cache
         WHERE profile_id = ?1 AND cached_date = ?2",
    )?;
    let rows = stmt.query_map(params![profile_id, date], |row| {
        let attendees_json: String = row.get(5)?;
        Ok(CalendarEventDto {
            id: row.get(0)?,
            subject: row.get(1)?,
            start_at: row.get(2)?,
            end_at: row.get(3)?,
            duration_minutes: row.get(4)?,
            attendees: serde_json::from_str(&attendees_json).unwrap_or_default(),
            category: row.get(6)?,
            color: row.get(7)?,
            online_meeting_url: row.get(8)?,
            response_status: row.get(9)?,
            show_as: row.get(10)?,
            series_master_id: row.get(11)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| anyhow!(e))
}

fn save_events_to_cache(
    conn: &Connection,
    profile_id: i64,
    date: &str,
    events: &[CalendarEventDto],
) -> Result<()> {
    conn.execute(
        "DELETE FROM calendar_events_cache WHERE profile_id = ?1 AND cached_date = ?2",
        params![profile_id, date],
    )?;
    for ev in events {
        conn.execute(
            "INSERT INTO calendar_events_cache
             (id, profile_id, subject, start_at, end_at, duration_minutes,
              attendees_json, category, color, online_meeting_url,
              response_status, show_as, series_master_id, cached_date)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                ev.id, profile_id, ev.subject, ev.start_at, ev.end_at, ev.duration_minutes,
                serde_json::to_string(&ev.attendees).unwrap_or_else(|_| "[]".into()),
                ev.category, ev.color, ev.online_meeting_url,
                ev.response_status, ev.show_as, ev.series_master_id, date
            ],
        )?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────
// Tauri commands — profile CRUD
// ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_exchange_profiles(db: State<'_, WizardDb>) -> Result<Vec<ExchangeProfileDto>, String> {
    let conn = lock_db(&db)?;
    let mut stmt = conn
        .prepare(
            "SELECT id,name,auth_mode,ews_url,ews_auth_type,username,secret_ref,
                    tenant_id,client_id,refresh_token_secret_ref,
                    min_event_minutes,exclude_free_busy,exclude_declined,is_active
             FROM exchange_profiles ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ExchangeProfileDto {
                id: Some(row.get(0)?),
                name: row.get(1)?,
                auth_mode: row.get(2)?,
                ews_url: row.get(3)?,
                ews_auth_type: row.get(4)?,
                username: row.get(5)?,
                secret_ref: row.get(6)?,
                tenant_id: row.get(7)?,
                client_id: row.get(8)?,
                refresh_token_secret_ref: row.get(9)?,
                min_event_minutes: row.get(10)?,
                exclude_free_busy: row.get::<_, Option<i64>>(11)?.map(|v| v != 0),
                exclude_declined: row.get::<_, Option<i64>>(12)?.map(|v| v != 0),
                is_active: Some(row.get::<_, i64>(13)? != 0),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_exchange_profile(
    db: State<'_, WizardDb>,
    profile: ExchangeProfileDto,
) -> Result<i64, String> {
    let conn = lock_db(&db)?;
    let is_active = profile.is_active.unwrap_or(false) as i64;
    if is_active != 0 {
        conn.execute("UPDATE exchange_profiles SET is_active = 0", [])
            .map_err(|e| e.to_string())?;
    }
    match profile.id {
        Some(id) => {
            conn.execute(
                "UPDATE exchange_profiles SET
                 name=?1,auth_mode=?2,ews_url=?3,ews_auth_type=?4,username=?5,secret_ref=?6,
                 tenant_id=?7,client_id=?8,refresh_token_secret_ref=?9,
                 min_event_minutes=?10,exclude_free_busy=?11,exclude_declined=?12,is_active=?13
                 WHERE id=?14",
                params![
                    profile.name, profile.auth_mode, profile.ews_url, profile.ews_auth_type,
                    profile.username, profile.secret_ref, profile.tenant_id, profile.client_id,
                    profile.refresh_token_secret_ref,
                    profile.min_event_minutes,
                    profile.exclude_free_busy.map(|v| v as i64),
                    profile.exclude_declined.map(|v| v as i64),
                    is_active, id
                ],
            ).map_err(|e| e.to_string())?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO exchange_profiles
                 (name,auth_mode,ews_url,ews_auth_type,username,secret_ref,
                  tenant_id,client_id,refresh_token_secret_ref,
                  min_event_minutes,exclude_free_busy,exclude_declined,is_active)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    profile.name, profile.auth_mode, profile.ews_url, profile.ews_auth_type,
                    profile.username, profile.secret_ref, profile.tenant_id, profile.client_id,
                    profile.refresh_token_secret_ref,
                    profile.min_event_minutes,
                    profile.exclude_free_busy.map(|v| v as i64),
                    profile.exclude_declined.map(|v| v as i64),
                    is_active
                ],
            ).map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
pub fn delete_exchange_profile(db: State<'_, WizardDb>, id: i64) -> Result<bool, String> {
    let conn = lock_db(&db)?;
    let n = conn
        .execute("DELETE FROM exchange_profiles WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

// ─────────────────────────────────────────────────────────────────
// Tauri commands — calendar access
// ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn test_exchange_connection(
    params: ExchangeConnectionParams,
) -> Result<bool, String> {
    let result = match params.auth_mode.as_str() {
        "graph" => {
            get_graph_access_token(&params)
                .await
                .map(|_| true)
                .map_err(|e| e.to_string())
        }
        "ews" => {
            let ews_url = params
                .ews_url
                .as_deref()
                .ok_or("ews_url is required".to_string())?;
            let password = keyring::Entry::new("jiratime", &params.secret_ref)
                .and_then(|e| e.get_password())
                .map_err(|e| e.to_string())?;
            let auth = basic_auth_header(&params.username, &password);
            let client = reqwest::Client::builder()
                .use_rustls_tls()
                .build()
                .map_err(|e| e.to_string())?;
            let xml_body = r#"<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <soap:Body>
    <GetFolder xmlns="http://schemas.microsoft.com/exchange/services/2006/messages">
      <FolderShape><t:BaseShape>Default</t:BaseShape></FolderShape>
      <FolderIds><t:DistinguishedFolderId Id="calendar"/></FolderIds>
    </GetFolder>
  </soap:Body>
</soap:Envelope>"#;
            client
                .post(ews_url)
                .header(AUTHORIZATION, &auth)
                .header(CONTENT_TYPE, "text/xml; charset=utf-8")
                .body(xml_body)
                .send()
                .await
                .map(|r| r.status().is_success())
                .map_err(|e| e.to_string())
        }
        _ => Err("Unknown auth_mode".to_string()),
    };
    result
}

#[tauri::command]
pub async fn get_calendar_events(
    db: State<'_, WizardDb>,
    params: ExchangeConnectionParams,
    date_from: String,
    date_to: String,
    force_refresh: bool,
) -> Result<Vec<CalendarEventDto>, String> {
    let cache_date = date_from.get(..10).unwrap_or(&date_from).to_string();

    if !force_refresh {
        let conn = lock_db(&db)?;
        let profile_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM exchange_profiles WHERE secret_ref = ?1 LIMIT 1",
                params![params.secret_ref],
                |r| r.get(0),
            )
            .ok();
        if let Some(pid) = profile_id {
            let cached = load_cached_events(&conn, pid, &cache_date)
                .map_err(|e| e.to_string())?;
            if !cached.is_empty() {
                return Ok(cached
                    .into_iter()
                    .filter(|ev| should_keep_event(ev, &params))
                    .collect());
            }
        }
    }

    let events: Vec<CalendarEventDto> = match params.auth_mode.as_str() {
        "graph" => {
            let token = get_graph_access_token(&params)
                .await
                .map_err(|e| e.to_string())?;
            fetch_graph_events(&token, &date_from, &date_to)
                .await
                .map_err(|e| e.to_string())?
        }
        "ews" => {
            let ews_url = params
                .ews_url
                .as_deref()
                .ok_or("ews_url is required")?;
            let password = keyring::Entry::new("jiratime", &params.secret_ref)
                .and_then(|e| e.get_password())
                .map_err(|e| e.to_string())?;
            let auth_type = params.ews_auth_type.as_deref().unwrap_or("basic");
            let auth_header = if auth_type == "ntlm" {
                make_ntlm_negotiate_header(&params.username, &password)
                    .map_err(|e| e.to_string())?
            } else {
                basic_auth_header(&params.username, &password)
            };
            fetch_ews_events(ews_url, &auth_header, &date_from, &date_to)
                .await
                .map_err(|e| e.to_string())?
        }
        _ => return Err("Unknown auth_mode".to_string()),
    };

    {
        let conn = lock_db(&db)?;
        let profile_id: i64 = conn
            .query_row(
                "SELECT id FROM exchange_profiles WHERE secret_ref = ?1 LIMIT 1",
                params![params.secret_ref],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if profile_id > 0 {
            let _ = save_events_to_cache(&conn, profile_id, &cache_date, &events);
        }
    }

    Ok(events
        .into_iter()
        .filter(|ev| should_keep_event(ev, &params))
        .collect())
}

// ─────────────────────────────────────────────────────────────────
// OAuth2 PKCE embedded flow
// ─────────────────────────────────────────────────────────────────

fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(verifier.as_bytes());
    BASE64
        .encode(hash)
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

#[tauri::command]
pub async fn start_graph_oauth_embedded(
    app: AppHandle,
    params: ExchangeConnectionParams,
) -> Result<GraphAuthStartResult, String> {
    let client_id = params
        .client_id
        .clone()
        .ok_or("client_id required")?;
    let tenant_id = params
        .tenant_id
        .clone()
        .unwrap_or_else(|| "common".into());
    let redirect_uri = "http://localhost:43782/callback".to_string();

    let verifier: String = {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        (0..64)
            .map(|_| {
                let idx = rng.gen_range(0..62);
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[idx] as char
            })
            .collect()
    };
    let challenge = pkce_challenge(&verifier);
    let state_token = uuid::Uuid::new_v4().to_string();

    let auth_url = format!(
        "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize\
         ?client_id={client_id}\
         &response_type=code\
         &redirect_uri={redir}\
         &scope={scope}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &state={state}",
        redir     = urlencoding::encode(&redirect_uri),
        scope     = urlencoding::encode("Calendars.Read offline_access"),
        challenge = challenge,
        state     = state_token,
    );

    if let Some(loopback_state) = app.try_state::<OAuthLoopbackState>() {
        let mut lock = loopback_state.0.lock().map_err(|e| e.to_string())?;
        *lock = Some(LoopbackContext {
            client_id,
            tenant_id,
            redirect_uri: redirect_uri.clone(),
            code_verifier: verifier,
            state_token: state_token.clone(),
            secret_ref: params.secret_ref.clone(),
            profile_id: None,
        });
    }

    Ok(GraphAuthStartResult {
        auth_url,
        state: state_token,
        redirect_url: redirect_uri,
        window_label: "oauth".into(),
        mode: "pkce_loopback".into(),
    })
}

#[tauri::command]
pub async fn complete_graph_oauth_loopback(
    app: AppHandle,
) -> Result<GraphAuthCompleteResult, String> {
    let ctx = {
        let state = app
            .try_state::<OAuthLoopbackState>()
            .ok_or("OAuth state not found")?;
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        lock.take().ok_or("No pending OAuth flow")?
    };

    let server = tiny_http::Server::http("127.0.0.1:43782").map_err(|e| e.to_string())?;
    let request = server
        .recv_timeout(std::time::Duration::from_secs(120))
        .map_err(|e| e.to_string())?
        .ok_or("OAuth timeout: no redirect received within 2 minutes")?;

    let url = format!("http://localhost{}", request.url());
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    let code = parsed
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .ok_or("OAuth redirect missing 'code' parameter")?;

    let http_client = reqwest::Client::builder().use_rustls_tls().build().map_err(|e| e.to_string())?;
    let form = [
        ("client_id", ctx.client_id.as_str()),
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", ctx.redirect_uri.as_str()),
        ("code_verifier", ctx.code_verifier.as_str()),
        ("scope", "Calendars.Read offline_access"),
    ];
    let token: GraphTokenResponse = http_client
        .post(format!("https://login.microsoftonline.com/{}/oauth2/v2.0/token", ctx.tenant_id))
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let refresh_token = token
        .refresh_token
        .ok_or("Token response missing refresh_token")?;
    keyring::Entry::new("jiratime", &ctx.secret_ref)
        .and_then(|e| e.set_password(&refresh_token))
        .map_err(|e| e.to_string())?;

    let response = tiny_http::Response::from_string(
        "<html><body><h2>Авторизация прошла успешно — можно закрыть это окно.</h2></body></html>",
    )
    .with_header(
        tiny_http::Header::from_bytes(b"Content-Type", b"text/html; charset=utf-8").unwrap(),
    );
    let _ = request.respond(response);

    Ok(GraphAuthCompleteResult {
        ok: true,
        message: "Токен сохранён успешно".into(),
    })
}

// ─────────────────────────────────────────────────────────────────
// NTLM negotiate (первый шаг Handshake)
// ─────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn make_ntlm_negotiate_header(username: &str, password: &str) -> Result<String> {
    use sspi::{
        AuthIdentity, BufferType, ClientRequestFlags, CredentialUse,
        DataRepresentation, Ntlm, SecurityBuffer, Sspi, SspiImpl, Username,
    };
    let mut ntlm = Ntlm::new();
    let identity = AuthIdentity {
        username: Username::parse(username).map_err(|e| anyhow!("username: {e}"))?,
        password: password.to_string().into(),
    };
    let mut acq = ntlm
        .acquire_credentials_handle()
        .with_credential_use(CredentialUse::Outbound)
        .with_auth_data(&identity)
        .execute(&mut ntlm)
        .map_err(|e| anyhow!("acq_cred: {e}"))?;
    let mut output = vec![SecurityBuffer::new(Vec::new(), BufferType::Token)];
    let mut builder = ntlm
        .initialize_security_context()
        .with_credentials_handle(&mut acq.credentials_handle)
        .with_context_requirements(
            ClientRequestFlags::CONFIDENTIALITY | ClientRequestFlags::ALLOCATE_MEMORY,
        )
        .with_target_data_representation(DataRepresentation::Native)
        .with_output(&mut output);
    ntlm.initialize_security_context_impl(&mut builder)
        .map_err(|e| anyhow!("isc: {e}"))?
        .resolve_to_result()
        .map_err(|e| anyhow!("resolve: {e}"))?;
    let token = output
        .into_iter()
        .next()
        .map(|b| b.buffer)
        .unwrap_or_default();
    Ok(format!("NTLM {}", BASE64.encode(&token)))
}

#[cfg(not(target_os = "windows"))]
fn make_ntlm_negotiate_header(_username: &str, _password: &str) -> Result<String> {
    bail!("NTLM auth is only supported on Windows")
}
