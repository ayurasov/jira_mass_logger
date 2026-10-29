//! Команды Tauri для системной темы и рабочего графика.

/// Определяет тему Windows 10/11 из реестра HKCU.
/// Возвращает "dark" | "light".
#[tauri::command]
pub fn get_system_theme() -> String {
    #[cfg(target_os = "windows")]
    {
        // Читаем AppsUseLightTheme напрямую из реестра (без reg.exe — иначе мелькает
        // консольное окно). 1 = светлая тема, 0 = тёмная.
        match crate::win_registry::hkcu_dword(
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "AppsUseLightTheme",
        ) {
            Some(0) => return "dark".to_string(),
            Some(_) => return "light".to_string(),
            None => {}
        }
    }
    // macOS / Linux fallback (или если реестр недоступен)
    "light".to_string()
}

/// Сохраняет рабочий график в таблицу settings (SQLite).
/// Вызывается из Vue settings store при onboarding/изменении настроек.
/// Чтение файла, выбранного пользователем в диалоге открытия (импорт настроек).
/// Файл настроек маленький — больше 5 МБ не читаем, чтобы случайно выбранный
/// большой файл не повесил приложение.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 5 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(|e| format!("Не удалось открыть файл: {e}"))?;
    if meta.len() > MAX_BYTES {
        return Err("Файл слишком большой для файла настроек (больше 5 МБ).".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))
}

#[tauri::command]
pub fn save_work_schedule(
    db: tauri::State<'_, crate::bulk_wizard::WizardDb>,
    workday_hours: f32,
    workdays: Vec<u8>,
    timezone: String,
) -> Result<(), String> {
    let workdays_json = serde_json::to_string(&workdays).map_err(|e| e.to_string())?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (key, value) in [
        ("workday_hours", workday_hours.to_string()),
        ("workdays", workdays_json),
        ("timezone", timezone),
    ] {
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
