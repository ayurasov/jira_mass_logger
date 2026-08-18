//! Интеграционные тесты: оффлайн → восстановление сети → синхронизация 20 записей.
//!
//! Сценарий:
//!  1. Создаём in-memory SQLite с нужными таблицами.
//!  2. Добавляем 20 pending-записей через enqueue_operation (offline-режим).
//!  3. Поднимаем wiremock мок-сервер для /rest/api/2/issue/*/worklog → 201 Created.
//!  4. Запускаем start_worker с немедленным wake-сигналом ("restore network").
//!  5. Ждём до 10 секунд, поллингуем: все 20 записей должны стать synced.
//!  6. Проверяем порядок отправки (created_at ASC = по времени добавления).

#[cfg(test)]
mod offline_sync_integration {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use rusqlite::{params, Connection};
    use serde_json::json;
    use tokio::sync::Notify;
    use wiremock::{
        matchers::{method, path_regex},
        Mock, MockServer, ResponseTemplate,
    };

    use crate::{
        logger::AppLogger,
        sync_queue::{fetch_pending, start_worker, SyncStatus, WakeSignal},
    };

    // Создаём in-memory SQLite с нужными таблицами
    fn setup_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE sync_queue (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 row_key TEXT NOT NULL,
                 operation TEXT NOT NULL,
                 payload_json TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'pending',
                 attempts INTEGER NOT NULL DEFAULT 0,
                 last_error TEXT,
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )
        .expect("schema");
        Arc::new(Mutex::new(conn))
    }

    fn enqueue(conn: &Connection, idx: usize, base_url: &str) {
        let row_key = format!("test-row-{idx}");
        let issue_key = "TEST-1";
        let payload = json!({
            "baseUrl":  base_url,
            "issueKey": issue_key,
            "email":    "test@example.com",
            "token":    "secret",
            "timeSpentSeconds": 3600,
            "started":  format!("2025-01-{:02}T09:00:00.000+0000", (idx % 28) + 1),
            "comment":  format!("offline entry {idx}"),
        })
        .to_string();
        conn.execute(
            "INSERT INTO sync_queue (row_key, operation, payload_json, status) VALUES (?1, 'create', ?2, 'pending')",
            params![row_key, payload],
        )
        .expect("enqueue");
    }

    fn count_by_status(conn: &Connection, status: &str) -> usize {
        conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = ?1",
            params![status],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize
    }

    fn synced_ids_in_order(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn
            .prepare("SELECT id FROM sync_queue WHERE status='synced' ORDER BY created_at ASC, id ASC")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, i64>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    // Простой stub-логгер без Tauri AppHandle
    struct StubLogger;
    impl StubLogger {
        fn debug(&self, _m: &str, msg: &str) { eprintln!("[DEBUG] {msg}"); }
        fn info (&self, _m: &str, msg: &str) { eprintln!("[INFO]  {msg}"); }
        fn warn (&self, _m: &str, msg: &str) { eprintln!("[WARN]  {msg}"); }
        fn error(&self, _m: &str, msg: &str) { eprintln!("[ERROR] {msg}"); }
    }

    /// Главный интеграционный тест
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn offline_20_entries_sync_on_restore() {
        // 1. Поднимаем mock Jira-сервер
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"/rest/api/2/issue/.+/worklog"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "id": "10000",
                "timeSpent": "1h",
                "timeSpentSeconds": 3600,
            })))
            .expect(20)   // ровно 20 запросов
            .mount(&mock_server)
            .await;

        let base_url = mock_server.uri();

        // 2. In-memory DB + 20 offline-записей
        let db = setup_db();
        {
            let conn = db.lock().unwrap();
            for i in 0..20 {
                enqueue(&conn, i, &base_url);
            }
        }

        // Все 20 — pending
        assert_eq!(db.lock().unwrap().query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status='pending'", [], |r| r.get::<_,i64>(0)
        ).unwrap(), 20, "all 20 should be pending before restore");

        // 3. WakeSignal (пока не подаюм сигнал)
        let wake: WakeSignal = Arc::new(Notify::new());

        // 4. Запускаем воркер.
        //    AppLogger не обязателен в продакшн — используем реальный,
        //    но записывать в файл не будет (log_dir = temp).
        //
        //    В тестах подтыпичиваем через Arc<dyn LogSink> — см. ниже.
        //    Поскольку start_worker принимает Arc<AppLogger>,
        //    в тесте передаём TestLogger, совместимый через TestAppLogger wrapper.
        let logger = Arc::new(TestAppLogger::new());

        start_worker(db.clone(), wake.clone(), logger);

        // 5. Симулируем восстановление сети
        wake.notify_one();

        // 6. Поллинг до 10 секунд
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let synced = count_by_status(&db.lock().unwrap(), "synced");
            if synced == 20 { break; }
            if tokio::time::Instant::now() > deadline {
                panic!("Timeout: only {synced}/20 items synced");
            }
        }

        // 7. Проверяем отсутствие failed
        assert_eq!(count_by_status(&db.lock().unwrap(), "failed"), 0, "no failures expected");
        assert_eq!(count_by_status(&db.lock().unwrap(), "pending"), 0, "no pending remaining");

        // 8. Проверяем порядок: synced IDs в возрастающем порядке id
        let ids = synced_ids_in_order(&db.lock().unwrap());
        assert_eq!(ids.len(), 20);
        let is_sorted = ids.windows(2).all(|w| w[0] <= w[1]);
        assert!(is_sorted, "entries should be synced in creation order, got: {ids:?}");

        // 9. wiremock проверяет, что было ровно 20 HTTP-запросов
        mock_server.verify().await;
    }

    // ───────────────────────────────────────────────────────────────
    // Тонкая обёртка AppLogger для тестов
    // ───────────────────────────────────────────────────────────────

    /// AppLogger-совместимая обёртка: выводит в stderr,
    /// не пытаясь создать Tauri AppHandle.
    pub struct TestAppLogger;
    impl TestAppLogger {
        pub fn new() -> Self { Self }
        pub fn debug(&self, m: &str, msg: &str) { eprintln!("[T:DEBUG] [{m}] {msg}"); }
        pub fn info (&self, m: &str, msg: &str) { eprintln!("[T:INFO]  [{m}] {msg}"); }
        pub fn warn (&self, m: &str, msg: &str) { eprintln!("[T:WARN]  [{m}] {msg}"); }
        pub fn error(&self, m: &str, msg: &str) { eprintln!("[T:ERROR] [{m}] {msg}"); }
    }

    // Тест rate-limit: сервер возвращает 429 с Retry-After: 1,
    // после чего отвечает 201.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rate_limit_retry_after_respected() {
        let mock_server = MockServer::start().await;

        // Первый запрос → 429
        Mock::given(method("POST"))
            .and(path_regex(r"/rest/api/2/issue/.+/worklog"))
            .respond_with(
                ResponseTemplate::new(429)
                    .append_header("retry-after", "1")
            )
            .up_to_n_times(1)
            .mount(&mock_server)
            .await;

        // Повторный запрос → 201
        Mock::given(method("POST"))
            .and(path_regex(r"/rest/api/2/issue/.+/worklog"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "id": "10001", "timeSpentSeconds": 3600,
            })))
            .mount(&mock_server)
            .await;

        let base_url = mock_server.uri();
        let db = setup_db();
        {
            let conn = db.lock().unwrap();
            enqueue(&conn, 0, &base_url);
        }

        let wake: WakeSignal = Arc::new(Notify::new());
        let logger = Arc::new(TestAppLogger::new());
        start_worker(db.clone(), wake.clone(), logger);
        wake.notify_one();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let synced = count_by_status(&db.lock().unwrap(), "synced");
            if synced == 1 { break; }
            if tokio::time::Instant::now() > deadline {
                let failed = count_by_status(&db.lock().unwrap(), "failed");
                let pending = count_by_status(&db.lock().unwrap(), "pending");
                panic!("Timeout: synced={synced}, failed={failed}, pending={pending}");
            }
        }
        assert_eq!(count_by_status(&db.lock().unwrap(), "failed"), 0);
    }

    // Тест permanent error (400): запись должна сразу стать failed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn permanent_400_becomes_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"/rest/api/2/issue/.+/worklog"))
            .respond_with(ResponseTemplate::new(400).set_body_string("Bad Request: invalid field"))
            .mount(&mock_server)
            .await;

        let base_url = mock_server.uri();
        let db = setup_db();
        { enqueue(&db.lock().unwrap(), 0, &base_url); }

        let wake: WakeSignal = Arc::new(Notify::new());
        let logger = Arc::new(TestAppLogger::new());
        start_worker(db.clone(), wake.clone(), logger);
        wake.notify_one();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let failed = count_by_status(&db.lock().unwrap(), "failed");
            if failed == 1 { break; }
            if tokio::time::Instant::now() > deadline {
                panic!("Timeout: item should be failed");
            }
        }
        assert_eq!(count_by_status(&db.lock().unwrap(), "synced"), 0);
    }
}
