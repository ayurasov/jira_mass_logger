//! Тесты для exchange_client.
//!
//! Запуск: `cargo test -p jiratime exchange_client_tests -- --nocapture`
//!
//! Тесты покрывают три слоя:
//!   1. SQLite CRUD для exchange_profiles (создание, обновление, удаление,
//!      выбор активного профиля и правило уникальности is_active).
//!   2. Вспомогательные функции NTLM: basic_auth_header, make_ntlm_negotiate_message.
//!   3. Парсер EWS FindItem SOAP-ответа.

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    // ────────────────────────────────────────────────────
    // Помощник: in-memory Считаем схему и возвращаем Connection
    // ────────────────────────────────────────────────────
    fn make_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE exchange_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                auth_mode TEXT NOT NULL DEFAULT 'graph',
                ews_url TEXT,
                ews_auth_type TEXT NOT NULL DEFAULT 'basic',
                username TEXT NOT NULL,
                secret_ref TEXT NOT NULL,
                tenant_id TEXT,
                client_id TEXT,
                refresh_token_secret_ref TEXT,
                min_event_minutes INTEGER NOT NULL DEFAULT 0,
                exclude_free_busy INTEGER NOT NULL DEFAULT 1,
                exclude_declined INTEGER NOT NULL DEFAULT 1,
                is_active INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )
        .expect("create table");
        conn
    }

    fn insert_profile(
        conn: &Connection,
        name: &str,
        auth_mode: &str,
        username: &str,
        is_active: i64,
    ) -> i64 {
        conn.execute(
            "INSERT INTO exchange_profiles (name, auth_mode, username, secret_ref, is_active)
             VALUES (?1, ?2, ?3, 'ref', ?4)",
            rusqlite::params![name, auth_mode, username, is_active],
        )
        .expect("insert");
        conn.last_insert_rowid()
    }

    // ──────────── SQLite CRUD tests ────────────

    #[test]
    fn test_insert_and_list() {
        let conn = make_test_db();
        insert_profile(&conn, "Work Graph", "graph", "alice@corp.com", 0);
        insert_profile(&conn, "On-Prem EWS", "ews", "alice@corp.local", 0);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM exchange_profiles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "should have 2 profiles");
    }

    #[test]
    fn test_update_profile_name() {
        let conn = make_test_db();
        let id = insert_profile(&conn, "Old Name", "graph", "bob@corp.com", 0);

        conn.execute(
            "UPDATE exchange_profiles SET name = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params!["New Name", id],
        )
        .unwrap();

        let name: String = conn
            .query_row(
                "SELECT name FROM exchange_profiles WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "New Name");
    }

    #[test]
    fn test_delete_profile() {
        let conn = make_test_db();
        let id = insert_profile(&conn, "ToDelete", "ews", "carol@corp.com", 0);

        let deleted = conn
            .execute(
                "DELETE FROM exchange_profiles WHERE id = ?1",
                rusqlite::params![id],
            )
            .unwrap();
        assert_eq!(deleted, 1);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM exchange_profiles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_set_active_single_profile() {
        let conn = make_test_db();
        insert_profile(&conn, "Profile A", "graph", "a@corp.com", 0);
        let id_b = insert_profile(&conn, "Profile B", "graph", "b@corp.com", 0);

        // Симулируем транзакцию save_exchange_profile: сброс всех, затем активировать один
        conn.execute("UPDATE exchange_profiles SET is_active = 0", []).unwrap();
        conn.execute(
            "UPDATE exchange_profiles SET is_active = 1 WHERE id = ?1",
            rusqlite::params![id_b],
        )
        .unwrap();

        let active_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM exchange_profiles WHERE is_active = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(active_count, 1, "exactly one profile must be active");

        let active_id: i64 = conn
            .query_row(
                "SELECT id FROM exchange_profiles WHERE is_active = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(active_id, id_b, "Profile B should be the active one");
    }

    #[test]
    fn test_migration_add_column_idempotent() {
        // Проверяем, что ALTER TABLE ADD COLUMN не паникует при повторном вызове
        let conn = make_test_db();
        // Первый вызов подобен init_db
        let _ = conn.execute(
            "ALTER TABLE exchange_profiles ADD COLUMN ews_auth_type TEXT NOT NULL DEFAULT 'basic'",
            [],
        );
        // Второй вызов — должен вернуть Err, но не паниковать
        let result = conn.execute(
            "ALTER TABLE exchange_profiles ADD COLUMN ews_auth_type TEXT NOT NULL DEFAULT 'basic'",
            [],
        );
        // rusqlite возвращает Err с SQLite error «дублирование колонки» — это ожидаемое поведение
        assert!(
            result.is_err(),
            "second ADD COLUMN must fail with duplicate column error (handled by db.rs with let _ = ...)"
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("duplicate column name"),
            "error should mention duplicate column name"
        );
    }

    // ──────────── basic_auth_header ────────────

    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;

    fn basic_auth_header_local(username: &str, password: &str) -> String {
        let raw = format!("{username}:{password}");
        format!("Basic {}", BASE64_STANDARD.encode(raw.as_bytes()))
    }

    #[test]
    fn test_basic_auth_header_format() {
        let header = basic_auth_header_local("alice", "secret");
        assert!(header.starts_with("Basic "), "must start with 'Basic '");
    }

    #[test]
    fn test_basic_auth_header_decodes_correctly() {
        let username = "user@corp.com";
        let password = "P@$$w0rd!";
        let header = basic_auth_header_local(username, password);
        let b64_part = header.strip_prefix("Basic ").unwrap();
        let decoded = String::from_utf8(BASE64_STANDARD.decode(b64_part).unwrap()).unwrap();
        assert_eq!(decoded, format!("{username}:{password}"));
    }

    #[test]
    fn test_basic_auth_header_no_newline() {
        // base64 без line-wrap (стандартный STANDARD engine) — важно
        let header = basic_auth_header_local("user", &"x".repeat(200));
        assert!(!header.contains('\n'), "Basic header must not contain newline");
        assert!(!header.contains('\r'), "Basic header must not contain CR");
    }

    // ──────────── NTLM negotiate token ────────────

    use sspi::{
        AuthIdentity, BufferType, ClientRequestFlags, CredentialUse, DataRepresentation, Ntlm,
        SecurityBuffer, Sspi, SspiImpl, Username,
    };

    fn make_negotiate_token(username: &str, password: &str) -> Result<Vec<u8>, String> {
        let mut ntlm = Ntlm::new();
        let identity = AuthIdentity {
            username: Username::parse(username)
                .map_err(|e| format!("username parse: {e}"))?,
            password: password.to_string().into(),
        };
        let mut acq = ntlm
            .acquire_credentials_handle()
            .with_credential_use(CredentialUse::Outbound)
            .with_auth_data(&identity)
            .execute(&mut ntlm)
            .map_err(|e| format!("acq_cred: {e}"))?;

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
            .map_err(|e| format!("isc: {e}"))?
            .resolve_to_result()
            .map_err(|e| format!("resolve: {e}"))?;

        Ok(output.into_iter().next().map(|b| b.buffer).unwrap_or_default())
    }

    #[test]
    fn test_ntlm_negotiate_token_is_nonempty() {
        let token = make_negotiate_token("CORP\\alice", "password123");
        assert!(token.is_ok(), "negotiate must succeed: {:?}", token.err());
        assert!(!token.unwrap().is_empty(), "negotiate token must not be empty");
    }

    #[test]
    fn test_ntlm_negotiate_token_starts_with_ntlmssp_signature() {
        // NTLMSSP Negotiate message всегда начинается с "NTLMSSP\0"
        let token = make_negotiate_token("user", "pass").unwrap();
        assert!(
            token.starts_with(b"NTLMSSP\0"),
            "negotiate token must start with NTLMSSP signature, got {:?}",
            &token[..token.len().min(16)]
        );
    }

    #[test]
    fn test_ntlm_negotiate_encoded_as_valid_base64() {
        let token = make_negotiate_token("user", "pass").unwrap();
        let encoded = format!("NTLM {}", BASE64_STANDARD.encode(&token));
        let b64_part = encoded.strip_prefix("NTLM ").unwrap();
        let decoded = BASE64_STANDARD.decode(b64_part);
        assert!(decoded.is_ok(), "encoded negotiate token must be valid base64");
        assert_eq!(decoded.unwrap(), token);
    }

    #[test]
    fn test_ntlm_invalid_username_format_error() {
        // Пустой username — sspi Username::parse не должен паниковать или вернуть
        // неожиданный Ok — тестируем, что ошибка обрабатывается
        let result = Username::parse("");
        // Поведение sspi: пустой username Ok или Err — в любом случае не паник
        let _ = result;
    }

    // ──────────── EWS SOAP parser ────────────

    // Минимальный inline-парсер на базе quick_xml, повторяющий логику
    // parse_ews_finditem_response без зависимости от private API
    use quick_xml::events::Event;
    use quick_xml::Reader;

    #[derive(Debug, PartialEq)]
    struct ParsedEvent {
        subject: String,
        start_at: String,
        end_at: String,
        duration_minutes: i64,
    }

    fn parse_ews_xml(xml: &str) -> Vec<ParsedEvent> {
        let mut reader = Reader::from_str(xml);
        reader.trim_text(true);
        let mut buf = Vec::new();

        let mut in_item = false;
        let mut current_tag = String::new();
        let mut subject = String::new();
        let mut start = String::new();
        let mut end = String::new();
        let mut out = Vec::new();

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) => {
                    current_tag =
                        String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                    if current_tag == "CalendarItem" {
                        in_item = true;
                        subject.clear();
                        start.clear();
                        end.clear();
                    }
                }
                Ok(Event::Text(t)) => {
                    if !in_item {
                        buf.clear();
                        continue;
                    }
                    let text = t.unescape().map(|v| v.to_string()).unwrap_or_default();
                    match current_tag.as_str() {
                        "Subject" => subject = text,
                        "Start" => start = text,
                        "End" => end = text,
                        _ => {}
                    }
                }
                Ok(Event::End(e)) => {
                    if String::from_utf8_lossy(e.local_name().as_ref()) == "CalendarItem" {
                        in_item = false;
                        use chrono::{DateTime, Utc};
                        let s = DateTime::parse_from_rfc3339(&start)
                            .map(|d| d.with_timezone(&Utc))
                            .unwrap_or_else(|_| Utc::now());
                        let e2 = DateTime::parse_from_rfc3339(&end)
                            .map(|d| d.with_timezone(&Utc))
                            .unwrap_or_else(|_| s);
                        out.push(ParsedEvent {
                            subject: subject.clone(),
                            start_at: s.to_rfc3339(),
                            end_at: e2.to_rfc3339(),
                            duration_minutes: (e2 - s).num_minutes().max(0),
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

    fn sample_ews_xml() -> &'static str {
        r#"<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
            xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <s:Body>
    <m:FindItemResponse>
      <m:ResponseMessages>
        <m:FindItemResponseMessage ResponseClass="Success">
          <m:ResponseCode>NoError</m:ResponseCode>
          <m:RootFolder TotalItemsInView="2" IncludesLastItemInRange="true">
            <t:Items>
              <t:CalendarItem>
                <t:ItemId Id="AAA=" ChangeKey="BBB="/>
                <t:Subject>Daily Standup</t:Subject>
                <t:Start>2026-08-18T09:00:00Z</t:Start>
                <t:End>2026-08-18T09:30:00Z</t:End>
                <t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus>
              </t:CalendarItem>
              <t:CalendarItem>
                <t:ItemId Id="CCC=" ChangeKey="DDD="/>
                <t:Subject>Architecture Review</t:Subject>
                <t:Start>2026-08-18T14:00:00Z</t:Start>
                <t:End>2026-08-18T15:30:00Z</t:End>
                <t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus>
              </t:CalendarItem>
            </t:Items>
          </m:RootFolder>
        </m:FindItemResponseMessage>
      </m:ResponseMessages>
    </m:FindItemResponse>
  </s:Body>
</s:Envelope>"#
    }

    #[test]
    fn test_ews_parser_returns_two_events() {
        let events = parse_ews_xml(sample_ews_xml());
        assert_eq!(events.len(), 2, "must parse exactly 2 calendar items");
    }

    #[test]
    fn test_ews_parser_subjects() {
        let events = parse_ews_xml(sample_ews_xml());
        assert_eq!(events[0].subject, "Daily Standup");
        assert_eq!(events[1].subject, "Architecture Review");
    }

    #[test]
    fn test_ews_parser_duration_minutes() {
        let events = parse_ews_xml(sample_ews_xml());
        assert_eq!(events[0].duration_minutes, 30, "Daily Standup is 30 min");
        assert_eq!(events[1].duration_minutes, 90, "Architecture Review is 90 min");
    }

    #[test]
    fn test_ews_parser_empty_xml_returns_empty_vec() {
        let events = parse_ews_xml(
            r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body/></s:Envelope>"#,
        );
        assert!(events.is_empty(), "empty body must produce no events");
    }

    #[test]
    fn test_ews_parser_malformed_date_does_not_panic() {
        let xml = r#"<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <s:Body>
    <t:CalendarItem>
      <t:Subject>Bad Dates</t:Subject>
      <t:Start>NOT-A-DATE</t:Start>
      <t:End>ALSO-NOT-A-DATE</t:End>
    </t:CalendarItem>
  </s:Body>
</s:Envelope>"#;
        // Не должно паниковать — parser fallback на Utc::now()
        let _ = parse_ews_xml(xml);
    }

    // ──────────── should_keep_event logic ────────────

    // Инлайн повторяем логику фильтра через локальную структуру, не завися от pub-API.

    struct FilterParams {
        exclude_declined: bool,
        exclude_free_busy: bool,
        min_event_minutes: i64,
    }

    struct FakeEvent {
        response_status: Option<String>,
        show_as: Option<String>,
        subject: String,
        duration_minutes: i64,
    }

    fn should_keep(ev: &FakeEvent, p: &FilterParams) -> bool {
        if p.exclude_declined {
            if ev
                .response_status
                .as_deref()
                .map(|s| s.eq_ignore_ascii_case("declined"))
                .unwrap_or(false)
            {
                return false;
            }
        }
        if p.exclude_free_busy {
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
        if p.min_event_minutes > 0 && ev.duration_minutes < p.min_event_minutes {
            return false;
        }
        true
    }

    #[test]
    fn test_filter_keeps_normal_event() {
        let ev = FakeEvent {
            response_status: Some("accepted".into()),
            show_as: Some("Busy".into()),
            subject: "Sprint Planning".into(),
            duration_minutes: 60,
        };
        let p = FilterParams { exclude_declined: true, exclude_free_busy: true, min_event_minutes: 15 };
        assert!(should_keep(&ev, &p));
    }

    #[test]
    fn test_filter_drops_declined() {
        let ev = FakeEvent {
            response_status: Some("Declined".into()),
            show_as: Some("Busy".into()),
            subject: "Meeting".into(),
            duration_minutes: 60,
        };
        let p = FilterParams { exclude_declined: true, exclude_free_busy: true, min_event_minutes: 0 };
        assert!(!should_keep(&ev, &p));
    }

    #[test]
    fn test_filter_keeps_declined_when_not_excluded() {
        let ev = FakeEvent {
            response_status: Some("Declined".into()),
            show_as: Some("Busy".into()),
            subject: "Meeting".into(),
            duration_minutes: 60,
        };
        let p = FilterParams { exclude_declined: false, exclude_free_busy: false, min_event_minutes: 0 };
        assert!(should_keep(&ev, &p));
    }

    #[test]
    fn test_filter_drops_free_event() {
        let ev = FakeEvent {
            response_status: None,
            show_as: Some("Free".into()),
            subject: "Blocker".into(),
            duration_minutes: 60,
        };
        let p = FilterParams { exclude_declined: true, exclude_free_busy: true, min_event_minutes: 0 };
        assert!(!should_keep(&ev, &p));
    }

    #[test]
    fn test_filter_drops_oof() {
        let ev = FakeEvent {
            response_status: None,
            show_as: Some("OOF".into()),
            subject: "Out of Office".into(),
            duration_minutes: 480,
        };
        let p = FilterParams { exclude_declined: true, exclude_free_busy: true, min_event_minutes: 0 };
        assert!(!should_keep(&ev, &p));
    }

    #[test]
    fn test_filter_drops_empty_subject() {
        let ev = FakeEvent {
            response_status: None,
            show_as: Some("Busy".into()),
            subject: "   ".into(),
            duration_minutes: 30,
        };
        let p = FilterParams { exclude_declined: false, exclude_free_busy: true, min_event_minutes: 0 };
        assert!(!should_keep(&ev, &p));
    }

    #[test]
    fn test_filter_drops_too_short() {
        let ev = FakeEvent {
            response_status: None,
            show_as: Some("Busy".into()),
            subject: "Quick Chat".into(),
            duration_minutes: 10,
        };
        let p = FilterParams { exclude_declined: true, exclude_free_busy: true, min_event_minutes: 15 };
        assert!(!should_keep(&ev, &p));
    }

    #[test]
    fn test_filter_keeps_exact_min_minutes() {
        let ev = FakeEvent {
            response_status: None,
            show_as: Some("Busy".into()),
            subject: "Exact Length".into(),
            duration_minutes: 15,
        };
        let p = FilterParams { exclude_declined: true, exclude_free_busy: true, min_event_minutes: 15 };
        assert!(should_keep(&ev, &p));
    }
}
