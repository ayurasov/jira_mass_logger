//! Интеграционные тесты для сценария:
//!   offline создание 20 записей → восстановление сети → успешная синхронизация всех
//!
//! Запуск: `cargo test --test sync_queue_integration -- --nocapture`
//! В CI: windows-latest runner (см. .github/workflows/integration-tests.yml)

#[cfg(test)]
mod offline_to_sync {
    use rusqlite::{Connection, params};
    use std::sync::{Arc, Mutex};
    use tokio::sync::Notify;
    use wiremock::{MockServer, Mock, ResponseTemplate};
    use wiremock::matchers::{method, path_regex};

    use crate::sync_queue::{
        fetch_pending, set_synced, SyncStatus,
        enqueue_item_raw, count_by_status,
    };
    use crate::logger::AppLogger;
    use crate::db::init_db_conn;

    // ──────────────────────────────────────────
    // Вспомогательные функции
    // ──────────────────────────────────────────

    fn make_in_memory_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_queue (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                row_key      TEXT    NOT NULL UNIQUE,
                operation    TEXT    NOT NULL,
                payload_json TEXT    NOT NULL,
                status       TEXT    NOT NULL DEFAULT 'pending',
                attempts     INTEGER NOT NULL DEFAULT 0,
                last_error   TEXT,
                created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
            );",
        )
        .expect("create table");
        Arc::new(Mutex::new(conn))
    }

    fn make_noop_logger() -> Arc<crate::logger::NoopLogger> {
        Arc::new(crate::logger::NoopLogger)
    }

    /// Добавить N pending-записей напрямую в БД
    fn enqueue_n(db: &Arc<Mutex<Connection>>, base_url: &str, n: usize) {
        let conn = db.lock().unwrap();
        for i in 0..n {
            let row_key = format!("offline-{i:03}");
            let payload = serde_json::json!({
                "baseUrl":  base_url,
                "issueKey": format!("TEST-{}", i + 1),
                "email":    "test@example.com",
                "token":    "fake-token",
                "timeSpent": "1h",
                "started":  "2026-08-18T10:00:00.000+0300",
                "comment":  format!("Offline worklog {i}"),
            });
            conn.execute(
                "INSERT OR IGNORE INTO sync_queue (row_key, operation, payload_json, status)
                 VALUES (?1, 'create', ?2, 'pending')",
                params![row_key, payload.to_string()],
            )
            .expect("insert");
        }
    }

    // ──────────────────────────────────────────
    // Тест: offline 20 записей → успешная синхронизация
    // ──────────────────────────────────────────

    #[tokio::test]
    async fn test_offline_20_entries_then_sync_all() {
        // 1. Поднимаем mock-сервер Jira
        let mock_server = MockServer::start().await;

        // Регистрируем обработчик: POST /rest/api/2/issue/{key}/worklog → 201
        Mock::given(method("POST"))
            .and(path_regex(r"/rest/api/2/issue/TEST-\d+/worklog"))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(serde_json::json!({
                    "id":        "10001",
                    "issueId":   "10000",
                    "timeSpent": "1h",
                    "started":   "2026-08-18T10:00:00.000+0300",
                }))
            )
            .expect(20)  // ровно 20 вызовов
            .mount(&mock_server)
            .await;

        // 2. Создаём in-memory БД и загружаем 20 offline-записей
        let db = make_in_memory_db();
        enqueue_n(&db, &mock_server.uri(), 20);

        // 3. Проверяем, что все 20 записей в статусе pending
        {
            let conn = db.lock().unwrap();
            let pending = fetch_pending(&conn).expect("fetch_pending");
            assert_eq!(pending.len(), 20, "должно быть 20 pending-записей до синхронизации");
        }

        // 4. Запускаем воркер с wake-сигналом
        let wake = Arc::new(Notify::new());
        let logger = make_noop_logger() as Arc<dyn crate::logger::LogSink>;
        crate::sync_queue::start_worker(db.clone(), wake.clone(), logger);

        // 5. Имитируем восстановление сети: отправляем wake-сигнал
        wake.notify_one();

        // 6. Ждём завершения синхронизации (до 10 секунд)
        let timeout = tokio::time::Duration::from_secs(10);
        let check = async {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                let conn = db.lock().unwrap();
                let pending = fetch_pending(&conn).unwrap_or_default();
                if pending.is_empty() {
                    break;
                }
            }
        };
        tokio::time::timeout(timeout, check)
            .await
            .expect("синхронизация не завершилась за 10 секунд");

        // 7. Проверяем финальный статус всех 20 записей
        {
            let conn = db.lock().unwrap();
            let synced_count = count_by_status(&conn, "synced").expect("count_by_status");
            let pending_count = count_by_status(&conn, "pending").expect("count_by_status");
            let failed_count  = count_by_status(&conn, "failed").expect("count_by_status");

            assert_eq!(synced_count, 20, "все 20 записей должны стать synced");
            assert_eq!(pending_count, 0, "pending должно быть 0");
            assert_eq!(failed_count,  0, "failed должно быть 0");
        }

        // 8. Проверяем порядок: синхронизация по created_at ASC
        {
            let conn = db.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT row_key FROM sync_queue WHERE status='synced' ORDER BY created_at ASC"
            ).unwrap();
            let keys: Vec<String> = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();

            for (i, key) in keys.iter().enumerate() {
                assert_eq!(*key, format!("offline-{i:03}"),
                    "порядок синхронизации нарушен на позиции {i}");
            }
        }

        // wiremock автоматически проверяет expect(20) при drop
    }

    // ──────────────────────────────────────────
    // Тест: 429 rate-limit → retry-after → успех
    // ──────────────────────────────────────────

    #[tokio::test]
    async fn test_rate_limit_then_retry_success() {
        let mock_server = MockServer::start().await;

        // Первый вызов → 429 с Retry-After: 1
        Mock::given(method("POST"))
            .and(path_regex(r"/rest/api/2/issue/RL-1/worklog"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("retry-after", "1")
            )
            .up_to_n_times(1)
            .mount(&mock_server)
            .await;

        // Второй вызов → 201 успех
        Mock::given(method("POST"))
            .and(path_regex(r"/rest/api/2/issue/RL-1/worklog"))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(serde_json::json!({"id":"10002"}))
            )
            .mount(&mock_server)
            .await;

        let db = make_in_memory_db();
        {
            let conn = db.lock().unwrap();
            let payload = serde_json::json!({
                "baseUrl":  mock_server.uri(),
                "issueKey": "RL-1",
                "email":    "test@example.com",
                "token":    "fake-token",
                "timeSpent": "30m",
                "started":  "2026-08-18T09:00:00.000+0300",
            });
            conn.execute(
                "INSERT INTO sync_queue (row_key, operation, payload_json, status)
                 VALUES ('rate-limit-test', 'create', ?1, 'pending')",
                params![payload.to_string()],
            ).unwrap();
        }

        let wake = Arc::new(Notify::new());
        let logger = make_noop_logger() as Arc<dyn crate::logger::LogSink>;
        crate::sync_queue::start_worker(db.clone(), wake.clone(), logger);
        wake.notify_one();

        tokio::time::timeout(tokio::time::Duration::from_secs(15), async {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                let conn = db.lock().unwrap();
                let synced = count_by_status(&conn, "synced").unwrap_or(0);
                if synced == 1 { break; }
            }
        })
        .await
        .expect("запись после rate-limit не синхронизировалась за 15 секунд");
    }

    // ──────────────────────────────────────────
    // Тест: permanent 400 → статус failed, не crash
    // ──────────────────────────────────────────

    #[tokio::test]
    async fn test_permanent_error_goes_to_failed() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path_regex(r"/rest/api/2/issue/BAD-1/worklog"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"errorMessages":["Invalid issue"]}))
            )
            .mount(&mock_server)
            .await;

        let db = make_in_memory_db();
        {
            let conn = db.lock().unwrap();
            let payload = serde_json::json!({
                "baseUrl":  mock_server.uri(),
                "issueKey": "BAD-1",
                "email":    "test@example.com",
                "token":    "fake-token",
            });
            conn.execute(
                "INSERT INTO sync_queue (row_key, operation, payload_json, status)
                 VALUES ('perm-error-test', 'create', ?1, 'pending')",
                params![payload.to_string()],
            ).unwrap();
        }

        let wake = Arc::new(Notify::new());
        let logger = make_noop_logger() as Arc<dyn crate::logger::LogSink>;
        crate::sync_queue::start_worker(db.clone(), wake.clone(), logger);
        wake.notify_one();

        tokio::time::timeout(tokio::time::Duration::from_secs(5), async {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                let conn = db.lock().unwrap();
                // permanent: статус failed, pending = 0
                let pending = fetch_pending(&conn).unwrap_or_default();
                if pending.is_empty() { break; }
            }
        })
        .await
        .expect("запись не перешла в failed за 5 секунд");

        let conn = db.lock().unwrap();
        let failed = count_by_status(&conn, "failed").unwrap();
        assert_eq!(failed, 1, "запись с 400 должна стать failed");
    }
}
