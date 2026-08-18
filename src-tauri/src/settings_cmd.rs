//! Команды Tauri для системной темы и рабочего графика.

use serde::Serialize;

/// Определяет тему Windows 10/11 из реестра HKCU.
/// Возвращает "dark" | "light".
#[tauri::command]
pub fn get_system_theme() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // Читаем AppsUseLightTheme из реестра через reg.exe — не требует
        // зависимостей winreg/windows-rs для простого случая.
        let output = Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "/v",
                "AppsUseLightTheme",
            ])
            .output();

        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            // Значение 0x1 = светлая тема, 0x0 = тёмная
            if stdout.contains("0x1") {
                return "light".to_string();
            } else if stdout.contains("0x0") {
                return "dark".to_string();
            }
        }
    }
    // macOS / Linux fallback (или если реестр недоступен)
    "light".to_string()
}

#[derive(serde::Deserialize)]
pub struct WorkScheduleArgs {
    pub workday_hours: f32,
    pub workdays: Vec<u8>,
    pub timezone: String,
}

/// Сохраняет рабочий график в таблицу settings (SQLite).
/// Вызывается из Vue settings store при onboarding/изменении настроек.
#[tauri::command]
pub async fn save_work_schedule(
    state: tauri::State<'_, crate::AppState>,
    workday_hours: f32,
    workdays: Vec<u8>,
    timezone: String,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let workdays_json = serde_json::to_string(&workdays).map_err(|e| e.to_string())?;

    db.execute(
        "INSERT INTO settings (key, value) VALUES ('workday_hours', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![workday_hours.to_string()],
    )
    .map_err(|e| e.to_string())?;

    db.execute(
        "INSERT INTO settings (key, value) VALUES ('workdays', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![workdays_json],
    )
    .map_err(|e| e.to_string())?;

    db.execute(
        "INSERT INTO settings (key, value) VALUES ('timezone', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![timezone],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
