//! Offline-лицензирование на основе Ed25519.
//!
//! # Принцип
//! Код = base32(payload || ed25519_signature).
//! payload = [version:1, days:2(LE), grant_id:16(UUID bytes)].
//! Приложение содержит только публичный ключ — верификация без возможности выписать новые.
//! Приватный ключ находится только в tools/license-codegen.
//!
//! # Накопительный эффект
//! Новый срок = max(текущее время, expires) + days.
//!
//! # Защита от повторного применения
//! Хранящийся SHA-256 grant_id (не сам код) в таблице license_applied_grants.

use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Duration, TimeZone, Utc};
use data_encoding::BASE32_NOPAD;
use ed25519_dalek::{Signature, VerifyingKey, Verifier};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{command, AppHandle, Manager, State};

// ─── Публичный ключ Ed25519 (база base64 std, 32 bytes) ─────────────────────────────
// Генерация: python tools/license-codegen/generate_key.py
// Заменить это значение на свой публичный ключ перед сборкой релиза.
const LICENSE_PUBLIC_KEY_B64: &str =
    "ODdDn3mo4IceyI8WYYRoiVi/LFiONWMp19O4HadLggk="; // <-- REPLACE WITH YOUR KEY

// Размеры payload: version(1) + days(2 LE) + grant_id(16)
const PAYLOAD_LEN: usize = 19;
// Размер подписи Ed25519 в байтах
const SIG_LEN: usize = 64;
const BLOB_LEN: usize = PAYLOAD_LEN + SIG_LEN; // 83 bytes → 133 base32 символа

// Текущая версия формата пайлоада
const PAYLOAD_VERSION: u8 = 1;

// ─── Tauri State ──────────────────────────────────────────────────────────────

pub struct LicenseDb(pub Arc<Mutex<Connection>>);

// ─── Структуры DTO ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// true если лицензия активна и не истекла
    pub active: bool,
    /// Дата истечения лицензии (ISO 8601) или null если не активирована
    pub expires_at: Option<String>,
    /// Осталось дней (целое, заокругление вниз)
    pub days_left: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateResult {
    pub ok: bool,
    pub message: String,
    pub status: LicenseStatus,
}

// ─── Инициализация ───────────────────────────────────────────────────────────────

pub fn init_license_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS license_state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS license_applied_grants (
            grant_hash TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )?;
    Ok(())
}

// ─── Внутренние хелперы ─────────────────────────────────────────────────────────

/// Читает значение из license_state
fn db_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM license_state WHERE key = ?1",
        [key],
        |r| r.get(0),
    ).ok()
}

/// Записывает / обновляет значение в license_state
fn db_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO license_state(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// Вычисляет текущий статус лицензии по expires_at в DB
fn compute_status(conn: &Connection) -> LicenseStatus {
    let expires_str = db_get(conn, "expires_at");
    match expires_str {
        None => LicenseStatus { active: false, expires_at: None, days_left: 0 },
        Some(s) => {
            match DateTime::parse_from_rfc3339(&s) {
                Err(_) => LicenseStatus { active: false, expires_at: Some(s), days_left: 0 },
                Ok(exp) => {
                    let now = Utc::now();
                    let exp_utc: DateTime<Utc> = exp.with_timezone(&Utc);
                    let diff = exp_utc.signed_duration_since(now);
                    let days_left = diff.num_days().max(0);
                    LicenseStatus {
                        active: diff.num_seconds() > 0,
                        expires_at: Some(s),
                        days_left,
                    }
                }
            }
        }
    }
}

/// Возвращает Err("ЛИЦЕНЗИЯ_НЕАКТИВНА") если лицензия не действительна.
fn check_license_active(conn: &Connection) -> std::result::Result<(), String> {
    let status = compute_status(conn);
    if status.active {
        Ok(())
    } else {
        Err("LICENSE_REQUIRED".to_string())
    }
}

/// Декодирует и верифицирует код.
/// Возвращает (days: u16, grant_id: [u8;16]) при успехе.
fn decode_and_verify(code: &str) -> Result<(u16, [u8; 16])> {
    // Убираем пробелы, дефисы, приводим к верхнему регистру
    let normalized: String = code
        .chars()
        .filter(|c| !c.is_ascii_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();

    let blob = BASE32_NOPAD
        .decode(normalized.as_bytes())
        .map_err(|e| anyhow!("base32 decode error: {e}"))?;

    if blob.len() != BLOB_LEN {
        bail!("invalid code length: {} bytes (expected {})", blob.len(), BLOB_LEN);
    }

    let payload = &blob[..PAYLOAD_LEN];
    let sig_bytes: &[u8; SIG_LEN] = blob[PAYLOAD_LEN..]
        .try_into()
        .map_err(|_| anyhow!("sig slice error"))?;

    // Версия формата
    if payload[0] != PAYLOAD_VERSION {
        bail!("unsupported payload version: {}", payload[0]);
    }

    // Проверяем Ed25519 подпись
    let pub_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        LICENSE_PUBLIC_KEY_B64,
    )?;
    let pub_arr: [u8; 32] = pub_bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("public key must be 32 bytes"))?;
    let verifying_key = VerifyingKey::from_bytes(&pub_arr)
        .map_err(|e| anyhow!("invalid public key: {e}"))?;
    let signature = Signature::from_bytes(sig_bytes);
    verifying_key
        .verify(payload, &signature)
        .map_err(|_| anyhow!("invalid signature — code is forged or corrupted"))?;

    // Извлекаем поля из payload
    let days = u16::from_le_bytes([payload[1], payload[2]]);
    let mut grant_id = [0u8; 16];
    grant_id.copy_from_slice(&payload[3..19]);

    Ok((days, grant_id))
}

// ─── Tauri-команды ────────────────────────────────────────────────────────────

/// Возвращает текущий статус лицензии.
#[command]
pub fn get_license_status(state: State<'_, LicenseDb>) -> LicenseStatus {
    let conn = state.0.lock().unwrap();
    compute_status(&conn)
}

/// Активирует лицензионный код.
/// Накопительный эффект: expires = max(now, current_expires) + days.
#[command]
pub fn activate_license_code(code: String, state: State<'_, LicenseDb>) -> ActivateResult {
    let conn = state.0.lock().unwrap();

    // 1. Декод и проверка подписи
    let (days, grant_id) = match decode_and_verify(&code) {
        Ok(v) => v,
        Err(e) => {
            let status = compute_status(&conn);
            return ActivateResult {
                ok: false,
                message: format!("Неверный код: {e}"),
                status,
            };
        }
    };

    // 2. Проверяем, не применялся ли уже этот grant_id
    let grant_hash = hex_sha256(&grant_id);
    let already_used: bool = conn
        .query_row(
            "SELECT 1 FROM license_applied_grants WHERE grant_hash = ?1",
            [&grant_hash],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if already_used {
        let status = compute_status(&conn);
        return ActivateResult {
            ok: false,
            message: "Данный код уже был применён на этом устройстве.".to_string(),
            status,
        };
    }

    // 3. Вычисляем новый expires с накопительным эффектом
    let now = Utc::now();
    let base = match db_get(&conn, "expires_at") {
        Some(s) => DateTime::parse_from_rfc3339(&s)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or(now),
        None => now,
    };
    let base = if base > now { base } else { now };
    let new_expires = base + Duration::days(days as i64);

    // 4. Сохраняем в DB
    let expires_str = new_expires.to_rfc3339();
    if let Err(e) = db_set(&conn, "expires_at", &expires_str) {
        let status = compute_status(&conn);
        return ActivateResult {
            ok: false,
            message: format!("Ошибка сохранения: {e}"),
            status,
        };
    }
    // Фингерпринт grant_id для предотвращения повторной активации
    let _ = conn.execute(
        "INSERT OR IGNORE INTO license_applied_grants(grant_hash, applied_at) VALUES(?1, ?2)",
        rusqlite::params![grant_hash, now.to_rfc3339()],
    );

    let status = compute_status(&conn);
    let label = days_label(days);
    ActivateResult {
        ok: true,
        message: format!(
            "Лицензия активирована! {label}. Действительна до {}.",
            new_expires.format("%d.%m.%Y")
        ),
        status,
    }
}

// ─── Хелпер для Rust-бекенда ───────────────────────────────────────────────────

/// Вызывается из jira_client.rs перед любым записывающим действием в Jira.
pub fn ensure_license_active(conn: &Connection) -> std::result::Result<(), String> {
    check_license_active(conn)
}

// ─── Вспомогательные функции ───────────────────────────────────────────────────────

fn hex_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn days_label(days: u16) -> String {
    match days {
        7 => "Пробный период (7 дней) добавлен".to_string(),
        30 => "Подписка на 1 месяц добавлена".to_string(),
        90 => "Подписка на 3 месяца добавлена".to_string(),
        183 => "Подписка на 6 месяцев добавлена".to_string(),
        365 => "Подписка на 1 год добавлена".to_string(),
        d => format!("+{d} дней добавлено"),
    }
}
