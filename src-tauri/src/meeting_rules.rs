// Сопоставление встреч Exchange/Outlook с задачами Jira для экрана
// "День из календаря" (Промпт 6).
//
// Три уровня сопоставления (первый совпавший выигрывает):
//  1) история пользователя — таблица meeting_issue_history (по series_key);
//  2) пользовательские regex/keyword/prefix-правила — meeting_match_rules;
//  3) авто-извлечение issue key из префикса темы "[PROJ-123] ...".
//
// Повторяющиеся встречи: series_key = seriesMasterId (Graph/EWS),
// иначе нормализованная тема без дат/счётчиков.

use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bulk_wizard::WizardDb;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MeetingMatchRule {
    pub id: Option<i64>,
    pub name: String,
    /// 'regex' | 'keyword' | 'prefix'
    pub kind: String,
    pub pattern: String,
    pub issue_key: String,
    pub priority: i64,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MeetingIssueHistoryEntry {
    pub series_key: String,
    pub issue_key: String,
    pub issue_summary: Option<String>,
    pub last_used_at: String,
    pub use_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MatchSuggestion {
    pub issue_key: Option<String>,
    pub issue_summary: Option<String>,
    /// 'history' | 'rule' | 'prefix' | 'none'
    pub source: String,
    pub matched_rule_name: Option<String>,
}

fn lock_db(db: &State<'_, WizardDb>) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.0.lock().map_err(|e| e.to_string())
}

/// Нормализует тему в серийный ключ: убирает даты, время, счётчики.
pub fn normalize_series_key(subject: &str) -> String {
    let re_date = Regex::new(r"\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b").unwrap();
    let re_time = Regex::new(r"\b\d{1,2}:\d{2}\b").unwrap();
    let re_paren = Regex::new(r"\(\s*\d+\s*/\s*\d+\s*\)").unwrap();
    let re_dash = Regex::new(r"[-\u{2013}]\s*(часть|part)\s*\d+").unwrap();
    let mut s = subject.to_lowercase();
    s = re_date.replace_all(&s, "").to_string();
    s = re_time.replace_all(&s, "").to_string();
    s = re_paren.replace_all(&s, "").to_string();
    s = re_dash.replace_all(&s, "").to_string();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Итоговый ключ серии: seriesMasterId > нормализованная тема.
pub fn resolve_series_key(subject: &str, series_master_id: Option<&str>) -> String {
    match series_master_id {
        Some(id) if !id.is_empty() => format!("series:{id}"),
        _ => format!("subject:{}", normalize_series_key(subject)),
    }
}

fn extract_prefix_issue_key(subject: &str) -> Option<String> {
    let re = Regex::new(r"^\s*\[?([A-Z][A-Z0-9]+-\d+)\]?[:\s\-]").ok()?;
    re.captures(subject)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn find_history(conn: &Connection, series_key: &str) -> Result<Option<MeetingIssueHistoryEntry>, String> {
    conn.query_row(
        "SELECT series_key, issue_key, issue_summary, last_used_at, use_count
         FROM meeting_issue_history WHERE series_key = ?1",
        params![series_key],
        |row| Ok(MeetingIssueHistoryEntry {
            series_key: row.get(0)?,
            issue_key: row.get(1)?,
            issue_summary: row.get(2)?,
            last_used_at: row.get(3)?,
            use_count: row.get(4)?,
        }),
    )
    .map(Some)
    .or_else(|e| {
        if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) }
    })
}

fn list_active_rules(conn: &Connection) -> Result<Vec<MeetingMatchRule>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, pattern, issue_key, priority, is_active
             FROM meeting_match_rules WHERE is_active = 1 ORDER BY priority DESC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok(MeetingMatchRule {
            id: Some(row.get(0)?),
            name: row.get(1)?,
            kind: row.get(2)?,
            pattern: row.get(3)?,
            issue_key: row.get(4)?,
            priority: row.get(5)?,
            is_active: row.get::<_, i64>(6)? != 0,
        }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn rule_matches(rule: &MeetingMatchRule, subject: &str) -> bool {
    match rule.kind.as_str() {
        "regex"   => Regex::new(&rule.pattern).map(|re| re.is_match(subject)).unwrap_or(false),
        "keyword" => subject.to_lowercase().contains(&rule.pattern.to_lowercase()),
        "prefix"  => subject.starts_with(&rule.pattern),
        _         => false,
    }
}

#[tauri::command]
pub fn suggest_issue_for_meeting(
    db: State<'_, WizardDb>,
    subject: String,
    series_master_id: Option<String>,
) -> Result<MatchSuggestion, String> {
    let conn = lock_db(&db)?;
    let series_key = resolve_series_key(&subject, series_master_id.as_deref());

    if let Some(hist) = find_history(&conn, &series_key)? {
        return Ok(MatchSuggestion {
            issue_key: Some(hist.issue_key),
            issue_summary: hist.issue_summary,
            source: "history".to_string(),
            matched_rule_name: None,
        });
    }

    for rule in list_active_rules(&conn)? {
        if rule_matches(&rule, &subject) {
            return Ok(MatchSuggestion {
                issue_key: Some(rule.issue_key.clone()),
                issue_summary: None,
                source: "rule".to_string(),
                matched_rule_name: Some(rule.name),
            });
        }
    }

    if let Some(issue_key) = extract_prefix_issue_key(&subject) {
        return Ok(MatchSuggestion {
            issue_key: Some(issue_key),
            issue_summary: None,
            source: "prefix".to_string(),
            matched_rule_name: None,
        });
    }

    Ok(MatchSuggestion {
        issue_key: None,
        issue_summary: None,
        source: "none".to_string(),
        matched_rule_name: None,
    })
}

#[tauri::command]
pub fn remember_meeting_issue_match(
    db: State<'_, WizardDb>,
    subject: String,
    series_master_id: Option<String>,
    issue_key: String,
    issue_summary: Option<String>,
) -> Result<(), String> {
    let conn = lock_db(&db)?;
    let series_key = resolve_series_key(&subject, series_master_id.as_deref());
    conn.execute(
        "INSERT INTO meeting_issue_history (series_key, issue_key, issue_summary, last_used_at, use_count)
         VALUES (?1, ?2, ?3, datetime('now'), 1)
         ON CONFLICT(series_key) DO UPDATE SET
           issue_key = excluded.issue_key,
           issue_summary = excluded.issue_summary,
           last_used_at = datetime('now'),
           use_count = meeting_issue_history.use_count + 1",
        params![series_key, issue_key, issue_summary],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_meeting_match_rules(db: State<'_, WizardDb>) -> Result<Vec<MeetingMatchRule>, String> {
    let conn = lock_db(&db)?;
    let mut stmt = conn
        .prepare("SELECT id, name, kind, pattern, issue_key, priority, is_active FROM meeting_match_rules ORDER BY priority DESC, id ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(MeetingMatchRule {
        id: Some(row.get(0)?), name: row.get(1)?, kind: row.get(2)?,
        pattern: row.get(3)?, issue_key: row.get(4)?, priority: row.get(5)?,
        is_active: row.get::<_, i64>(6)? != 0,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_meeting_match_rule(db: State<'_, WizardDb>, rule: MeetingMatchRule) -> Result<i64, String> {
    let conn = lock_db(&db)?;
    if let Some(id) = rule.id {
        conn.execute(
            "UPDATE meeting_match_rules SET name=?1,kind=?2,pattern=?3,issue_key=?4,priority=?5,is_active=?6 WHERE id=?7",
            params![rule.name, rule.kind, rule.pattern, rule.issue_key, rule.priority, rule.is_active as i64, id],
        ).map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO meeting_match_rules (name,kind,pattern,issue_key,priority,is_active) VALUES (?1,?2,?3,?4,?5,?6)",
            params![rule.name, rule.kind, rule.pattern, rule.issue_key, rule.priority, rule.is_active as i64],
        ).map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }
}

#[tauri::command]
pub fn delete_meeting_match_rule(db: State<'_, WizardDb>, id: i64) -> Result<(), String> {
    let conn = lock_db(&db)?;
    conn.execute("DELETE FROM meeting_match_rules WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_meeting_issue_history(db: State<'_, WizardDb>) -> Result<Vec<MeetingIssueHistoryEntry>, String> {
    let conn = lock_db(&db)?;
    let mut stmt = conn
        .prepare("SELECT series_key, issue_key, issue_summary, last_used_at, use_count FROM meeting_issue_history ORDER BY last_used_at DESC LIMIT 200")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(MeetingIssueHistoryEntry {
        series_key: row.get(0)?, issue_key: row.get(1)?, issue_summary: row.get(2)?,
        last_used_at: row.get(3)?, use_count: row.get(4)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Округляет длительность до ближайшего шага (15 или 30 мин).
/// Всегда возвращает не менее одного шага.
pub fn round_duration_minutes(duration_minutes: i64, step_minutes: i64) -> i64 {
    if step_minutes <= 0 { return duration_minutes.max(0); }
    let rounded = ((duration_minutes as f64) / (step_minutes as f64)).round() as i64 * step_minutes;
    rounded.max(step_minutes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_dates_and_times() {
        assert_eq!(normalize_series_key("Sprint Planning 12.05 10:00"), "sprint planning");
    }
    #[test]
    fn normalizes_counters() {
        assert_eq!(normalize_series_key("Design Review (2/5)"), "design review");
    }
    #[test]
    fn series_master_id_wins() {
        assert_eq!(resolve_series_key("Sprint Planning", Some("abc123")), "series:abc123");
    }
    #[test]
    fn extracts_bracketed_key() {
        assert_eq!(extract_prefix_issue_key("[PROJ-123] Обсуждение"), Some("PROJ-123".to_string()));
        assert_eq!(extract_prefix_issue_key("PROJ-45: демо"), Some("PROJ-45".to_string()));
        assert_eq!(extract_prefix_issue_key("Обычная встреча"), None);
    }
    #[test]
    fn rounds_to_nearest_step() {
        assert_eq!(round_duration_minutes(20, 15), 15);
        assert_eq!(round_duration_minutes(23, 15), 30);
        assert_eq!(round_duration_minutes(5,  15), 15);
        assert_eq!(round_duration_minutes(50, 30), 60);
    }
}
