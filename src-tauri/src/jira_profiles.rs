//! CRUD-команды для профилей подключения к Jira (таблица `jira_profiles`).
//!
//! Раньше фронтенд (`src/views/Profiles.vue`) вызывал команды
//! `list_jira_profiles`, `save_jira_profile`, `delete_jira_profile` и
//! `test_jira_connection`, которых не существовало в Rust-коде — это приводило
//! к ошибке `"unknown command"` при открытии экрана «Подключения» и делало
//! невозможным управление профилями Jira (только onboarding мог создать один
//! профиль напрямую через SQL). Этот модуль добавляет недостающие команды и
//! регистрирует их в `main.rs`.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bulk_wizard::WizardDb;
use crate::jira_client::{self, JiraConnectionParams, JiraInstanceType};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraProfileDto {
    pub id: Option<i64>,
    pub name: String,
    /// 'cloud' | 'server'
    pub instance_type: String,
    /// 'token' (Cloud API token) | 'pat' (Server PAT) | 'server_basic' (login+password)
    pub auth_type: Option<String>,
    pub base_url: String,
    pub email: String,
    pub secret_ref: Option<String>,
    /// Пароль/токен в открытом виде — только на вход, никогда не возвращается наружу.
    pub token: Option<String>,
    pub is_active: Option<bool>,
}

fn lock_db<'a>(db: &'a State<'a, WizardDb>) -> Result<std::sync::MutexGuard<'a, Connection>, String> {
    db.0.lock().map_err(|e| e.to_string())
}

fn parse_instance_type(instance_type: &str, auth_type: &str) -> JiraInstanceType {
    if auth_type == "server_basic" {
        JiraInstanceType::ServerBasic
    } else if instance_type == "cloud" {
        JiraInstanceType::Cloud
    } else {
        JiraInstanceType::Server
    }
}

#[tauri::command]
pub fn list_jira_profiles(db: State<'_, WizardDb>) -> Result<Vec<JiraProfileDto>, String> {
    let conn = lock_db(&db)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, instance_type, auth_type, base_url, email, secret_ref, is_active
             FROM jira_profiles ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(JiraProfileDto {
                id: Some(row.get(0)?),
                name: row.get(1)?,
                instance_type: row.get(2)?,
                auth_type: row.get(3)?,
                base_url: row.get(4)?,
                email: row.get(5)?,
                secret_ref: row.get(6)?,
                token: None,
                is_active: Some(row.get::<_, i64>(7)? != 0),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_jira_profile(
    db: State<'_, WizardDb>,
    profile: JiraProfileDto,
) -> Result<i64, String> {
    let conn = lock_db(&db)?;
    let is_active = profile.is_active.unwrap_or(false) as i64;
    let auth_type = profile
        .auth_type
        .clone()
        .unwrap_or_else(|| if profile.instance_type == "cloud" { "token".to_string() } else { "server_basic".to_string() });

    if is_active != 0 {
        conn.execute("UPDATE jira_profiles SET is_active = 0", [])
            .map_err(|e| e.to_string())?;
    }

    match profile.id {
        Some(id) => {
            // Существующая запись: секрет обновляем только если пришёл новый токен/пароль.
            let existing_secret_ref: String = conn
                .query_row(
                    "SELECT secret_ref FROM jira_profiles WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;

            if let Some(token) = &profile.token {
                if !token.is_empty() {
                    let entry = keyring::Entry::new("jiratime", &existing_secret_ref)
                        .map_err(|e| e.to_string())?;
                    entry.set_password(token).map_err(|e| e.to_string())?;
                }
            }

            conn.execute(
                "UPDATE jira_profiles SET
                 name=?1, base_url=?2, email=?3, type=?4, instance_type=?5,
                 auth_type=?6, is_active=?7
                 WHERE id=?8",
                params![
                    profile.name,
                    profile.base_url,
                    profile.email,
                    profile.instance_type,
                    profile.instance_type,
                    auth_type,
                    is_active,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
        None => {
            let token = profile
                .token
                .clone()
                .filter(|t| !t.is_empty())
                .ok_or_else(|| "token/password is required for a new profile".to_string())?;

            let secret_ref = format!("jira-profile-{}", uuid::Uuid::new_v4());
            let entry = keyring::Entry::new("jiratime", &secret_ref).map_err(|e| e.to_string())?;
            entry.set_password(&token).map_err(|e| e.to_string())?;

            conn.execute(
                "INSERT INTO jira_profiles
                 (name, base_url, email, type, instance_type, auth_type, secret_ref, is_active)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    profile.name,
                    profile.base_url,
                    profile.email,
                    profile.instance_type,
                    profile.instance_type,
                    auth_type,
                    secret_ref,
                    is_active
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
pub fn delete_jira_profile(db: State<'_, WizardDb>, id: i64) -> Result<bool, String> {
    let conn = lock_db(&db)?;
    let secret_ref: Option<String> = conn
        .query_row(
            "SELECT secret_ref FROM jira_profiles WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok();
    let n = conn
        .execute("DELETE FROM jira_profiles WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let Some(secret_ref) = secret_ref {
        if let Ok(entry) = keyring::Entry::new("jiratime", &secret_ref) {
            let _ = entry.delete_password();
        }
    }
    Ok(n > 0)
}

#[tauri::command]
pub async fn test_jira_connection(
    db: State<'_, WizardDb>,
    profile_id: i64,
) -> Result<bool, String> {
    let (base_url, email, secret_ref, instance_type, auth_type): (String, String, String, String, String) = {
        let conn = lock_db(&db)?;
        conn.query_row(
            "SELECT base_url, email, secret_ref, instance_type, COALESCE(auth_type, 'token')
             FROM jira_profiles WHERE id = ?1",
            params![profile_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| e.to_string())?
    };

    let params = JiraConnectionParams {
        base_url,
        email,
        secret_ref,
        instance_type: parse_instance_type(&instance_type, &auth_type),
        extra_root_ca_pem_path: None,
        proxy: None,
        user_timezone: None,
        accept_invalid_certs: false,
    };

    jira_client::test_connection(params).await
}
