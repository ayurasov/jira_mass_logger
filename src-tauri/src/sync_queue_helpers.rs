//! Вспомогательные публичные функции для интеграционных тестов.
//! Используются только в тестовом окружении (#[cfg(test)]).
use rusqlite::Connection;

/// Подсчитывает количество записей в таблице sync_queue с заданным статусом.
pub fn count_by_status(conn: &Connection, status: &str) -> usize {
    conn.query_row(
        "SELECT COUNT(*) FROM sync_queue WHERE status = ?1",
        rusqlite::params![status],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0) as usize
}

/// Вставляет запись в очередь напрямую (без Tauri стейта), для предварительного заполнения тестовой БД.
pub fn enqueue_item_raw(
    conn: &Connection,
    operation: &str,
    payload_json: &str,
    created_at_ms: i64,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO sync_queue (operation, payload, status, attempts, last_error, created_at)
         VALUES (?1, ?2, 'pending', 0, NULL, ?3)",
        rusqlite::params![operation, payload_json, created_at_ms],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Проверяет порядок синхронизации: возвращает вектор id в порядке created_at ASC,
/// в котором они были обработаны.
pub fn get_synced_ids_ordered(conn: &Connection) -> Vec<i64> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM sync_queue WHERE status = 'synced' ORDER BY created_at ASC",
        )
        .expect("prepare failed");
    stmt.query_map([], |row| row.get(0))
        .expect("query failed")
        .filter_map(|r| r.ok())
        .collect()
}
