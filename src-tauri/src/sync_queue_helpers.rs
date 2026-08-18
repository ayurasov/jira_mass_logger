//! Дополнительные pub-функции для sync_queue, используемые в тестах
//! и в будущем расширении функциональности.

use rusqlite::{params, Connection};

/// Подсчитать количество записей с данным статусом
pub fn count_by_status(conn: &Connection, status: &str) -> rusqlite::Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_queue WHERE status = ?1",
        params![status],
        |r| r.get(0),
    )?;
    Ok(count as usize)
}

/// Вставить запись напрямую (без State-обёртки) — для тестов
pub fn enqueue_item_raw(
    conn: &Connection,
    row_key: &str,
    operation: &str,
    payload_json: &str,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO sync_queue (row_key, operation, payload_json, status)
         VALUES (?1, ?2, ?3, 'pending')",
        params![row_key, operation, payload_json],
    )?;
    Ok(conn.last_insert_rowid())
}
