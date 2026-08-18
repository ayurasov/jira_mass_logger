//! Интеграционные тесты сценариев оффлайн/синхронизация.
//! Запуск: cargo test --test sync_queue_integration_tests
//! CI: .github/workflows/integration-tests.yml (windows-latest)

#[cfg(test)]
mod offline_to_sync {
    use std::{
        sync::{Arc, Mutex},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use rusqlite::Connection;
    use tokio::time::timeout;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };
    use crate::{
        sync_queue,
        sync_queue_helpers::{count_by_status, enqueue_item_raw, get_synced_ids_ordered},
        logger_noop::noop_logger,
    };

    /// Создаёт in-memory SQLite и выполняет миграцию таблицы sync_queue.
    fn make_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_queue (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                operation   TEXT    NOT NULL,
                payload     TEXT    NOT NULL,
                status      TEXT    NOT NULL DEFAULT 'pending',
                attempts    INTEGER NOT NULL DEFAULT 0,
                last_error  TEXT,
                created_at  INTEGER NOT NULL
            );",
        )
        .expect("migrate");
        Arc::new(Mutex::new(conn))
    }

    /// Текущее время в миллисекундах с эпохи UNIX.
    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    /// Сценарий 1: 20 записей в offline → восстановление сети → все synced в правильном порядке.
    #[tokio::test]
    async fn test_offline_20_entries_then_sync_all() {
        // ─ Поднимаем mock-сервер Jira API
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/api/2/issue/TEST-1/worklog"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": "10000",
                "issueId": "10001",
                "timeSpentSeconds": 3600
            })))
            .expect(20) // ровно 20 вызовов
            .mount(&mock_server)
            .await;

        // ─ Создаём БД и заполняем 20 записей (с последовательными created_at)
        let db = make_db();
        let base_ms = now_ms();
        {
            let conn = db.lock().unwrap();
            for i in 0..20i64 {
                let payload = serde_json::json!({
                    "jira_base_url": mock_server.uri(),
                    "issue_key": "TEST-1",
                    "time_spent_seconds": 3600,
                    "comment": format!("Entry {}", i),
                    "started": "2026-08-18T09:00:00.000+0000"
                })
                .to_string();
                enqueue_item_raw(&conn, "create_worklog", &payload, base_ms + i)
                    .expect("enqueue");
            }
        }

        // ─ Убеждаемся что 20 pending
        assert_eq!(count_by_status(&db.lock().unwrap(), "pending"), 20);

        // ─ Стартуем воркер (симулируем восстановление сети)
        let wake = Arc::new(tokio::sync::Notify::new());
        sync_queue::start_worker(db.clone(), wake.clone(), noop_logger());
        wake.notify_one(); // ← сигнал возобновления сети

        // ─ Ждём до 10 секунд пока все не станут synced
        let result = timeout(Duration::from_secs(10), async {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let synced = count_by_status(&db.lock().unwrap(), "synced");
                if synced == 20 {
                    break;
                }
            }
        })
        .await;
        assert!(result.is_ok(), "Timeout: not all 20 entries became synced");

        // ─ Проверяем порядок (created_at ASC)
        let ids = get_synced_ids_ordered(&db.lock().unwrap());
        assert_eq!(ids.len(), 20);
        for w in ids.windows(2) {
            assert!(w[0] < w[1], "Order violated: {} >= {}", w[0], w[1]);
        }

        // ─ Проверяем wiremock-ожидания (ещё раз убеждаемся в 20 запросах)
        mock_server.verify().await;
    }

    /// Сценарий 2: 429 + Retry-After -> затем 201 -> synced.
    #[tokio::test]
    async fn test_rate_limit_then_retry_success() {
        let mock_server = MockServer::start().await;

        // Первый вызов — 429
        Mock::given(method("POST"))
            .and(path("/rest/api/2/issue/RL-1/worklog"))
            .respond_with(
                ResponseTemplate::new(429).insert_header("Retry-After", "1"),
            )
            .up_to_n_times(1)
            .mount(&mock_server)
            .await;

        // Второй вызов — 201
        Mock::given(method("POST"))
            .and(path("/rest/api/2/issue/RL-1/worklog"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": "20001",
                "issueId": "20002",
                "timeSpentSeconds": 1800
            })))
            .mount(&mock_server)
            .await;

        let db = make_db();
        {
            let conn = db.lock().unwrap();
            let payload = serde_json::json!({
                "jira_base_url": mock_server.uri(),
                "issue_key": "RL-1",
                "time_spent_seconds": 1800,
                "comment": "Rate limit test",
                "started": "2026-08-18T10:00:00.000+0000"
            })
            .to_string();
            enqueue_item_raw(&conn, "create_worklog", &payload, now_ms()).unwrap();
        }

        let wake = Arc::new(tokio::sync::Notify::new());
        sync_queue::start_worker(db.clone(), wake.clone(), noop_logger());
        wake.notify_one();

        let result = timeout(Duration::from_secs(15), async {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if count_by_status(&db.lock().unwrap(), "synced") == 1 {
                    break;
                }
            }
        })
        .await;
        assert!(result.is_ok(), "Timeout: entry not synced after 429 retry");
        assert_eq!(count_by_status(&db.lock().unwrap(), "failed"), 0);
    }

    /// Сценарий 3: постоянный 400 Bad Request -> запись уходит в failed, приложение не падает.
    #[tokio::test]
    async fn test_permanent_error_goes_to_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/api/2/issue/BAD-1/worklog"))
            .respond_with(
                ResponseTemplate::new(400).set_body_json(serde_json::json!({
                    "errorMessages": ["Field 'timeSpent' cannot be empty"]
                })),
            )
            .mount(&mock_server)
            .await;

        let db = make_db();
        {
            let conn = db.lock().unwrap();
            let payload = serde_json::json!({
                "jira_base_url": mock_server.uri(),
                "issue_key": "BAD-1",
                "time_spent_seconds": 0,
                "comment": "",
                "started": "2026-08-18T11:00:00.000+0000"
            })
            .to_string();
            enqueue_item_raw(&conn, "create_worklog", &payload, now_ms()).unwrap();
        }

        let wake = Arc::new(tokio::sync::Notify::new());
        sync_queue::start_worker(db.clone(), wake.clone(), noop_logger());
        wake.notify_one();

        // Ждём перехода в failed (с exponential backoff может занять до 30 с)
        let result = timeout(Duration::from_secs(30), async {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let f = count_by_status(&db.lock().unwrap(), "failed");
                if f >= 1 {
                    break;
                }
            }
        })
        .await;
        assert!(result.is_ok(), "Timeout: entry did not reach 'failed' status");
        assert_eq!(count_by_status(&db.lock().unwrap(), "synced"), 0);
        // Приложение всё ещё работает (отсутствие panic проверяется тем что мы дошли сюда)
    }
}
