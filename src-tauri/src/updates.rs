//! Канал автообновления: настроен ли он в этой сборке и откуда берутся обновления.
//!
//! Публичный ключ подписи и адрес `latest.json` подставляет релизный workflow
//! (`tauri build --config …`, см. .github/workflows/release.yml). В локальной сборке ключ
//! пуст — тогда приложение не предлагает проверку обновлений, а честно пишет, что новые
//! версии ставятся вручную.
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannelInfo {
    /// Есть и ключ, и адрес — проверять обновления имеет смысл.
    pub configured: bool,
    /// Адрес `latest.json` (для показа в настройках).
    pub endpoint: Option<String>,
}

/// Разбор секции `plugins.updater` конфигурации.
fn channel_from(updater: Option<&Value>) -> UpdateChannelInfo {
    let pubkey = updater
        .and_then(|c| c.get("pubkey"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let endpoint = updater
        .and_then(|c| c.get("endpoints"))
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    UpdateChannelInfo { configured: !pubkey.is_empty() && endpoint.is_some(), endpoint }
}

#[tauri::command]
pub fn update_channel_info(app: tauri::AppHandle) -> UpdateChannelInfo {
    channel_from(app.config().plugins.0.get("updater"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_pubkey_means_not_configured() {
        let cfg = json!({ "pubkey": "", "endpoints": ["https://example.com/latest.json"] });
        let info = channel_from(Some(&cfg));
        assert!(!info.configured);
        assert_eq!(info.endpoint.as_deref(), Some("https://example.com/latest.json"));
    }

    #[test]
    fn key_and_endpoint_mean_configured() {
        let cfg = json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ=", "endpoints": ["https://example.com/latest.json"] });
        assert!(channel_from(Some(&cfg)).configured);
    }

    #[test]
    fn missing_section_or_endpoint_is_safe() {
        assert_eq!(channel_from(None), UpdateChannelInfo { configured: false, endpoint: None });
        let cfg = json!({ "pubkey": "abc", "endpoints": [] });
        assert!(!channel_from(Some(&cfg)).configured);
    }
}
