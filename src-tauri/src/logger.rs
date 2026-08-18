//! Файловый логгер с ротацией. Стратегия хранения:
//!   %LOCALAPPDATA%\JiraTime\logs\jiratime_YYYY-MM-DD.log
//!
//! Ротация: храним 7 суток логов, более старые удаляем.
//! Запись во всегда единый SQLite-файл + ежедневные лог-файлы —
//! это минимизирует риск срабатывания эвристики Windows Defender
//! «множество мелких файлов».

use chrono::Local;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

pub struct AppLogger {
    log_dir: PathBuf,
    file:    Mutex<Option<std::fs::File>>,
    current_date: Mutex<String>,
}

impl AppLogger {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        // Используем LOCALAPPDATA (не APPDATA), чтобы логи не мигрировали при roaming-профилях
        let local_app_data = app.path().app_local_data_dir()
            .map_err(|e| format!("cannot resolve LOCALAPPDATA: {e}"))?;
        let log_dir = local_app_data.join("logs");
        fs::create_dir_all(&log_dir)?;

        let logger = Self {
            log_dir,
            file:         Mutex::new(None),
            current_date: Mutex::new(String::new()),
        };
        logger.rotate_if_needed();
        logger.cleanup_old_logs();
        Ok(logger)
    }

    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }

    fn today_str() -> String {
        Local::now().format("%Y-%m-%d").to_string()
    }

    fn current_log_path(&self) -> PathBuf {
        self.log_dir.join(format!("jiratime_{}.log", Self::today_str()))
    }

    fn rotate_if_needed(&self) {
        let today = Self::today_str();
        let mut cur = self.current_date.lock().unwrap();
        if *cur == today {
            return;
        }
        *cur = today.clone();
        let path = self.log_dir.join(format!("jiratime_{today}.log"));
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(f) => *self.file.lock().unwrap() = Some(f),
            Err(e) => eprintln!("[AppLogger] failed to open log file {:?}: {e}", path),
        }
    }

    fn cleanup_old_logs(&self) {
        let Ok(entries) = fs::read_dir(&self.log_dir) else { return };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map_or(false, |e| e == "log"))
            .collect();
        files.sort();
        if files.len() > 7 {
            for old in &files[..files.len() - 7] {
                let _ = fs::remove_file(old);
            }
        }
    }

    fn write(&self, level: &str, module: &str, msg: &str) {
        self.rotate_if_needed();
        let ts = Local::now().format("%Y-%m-%dT%H:%M:%S%.3f");
        let line = format!("{ts} [{level:<5}] [{module}] {msg}\n");
        // Вывод в stderr для отладки в dev-режиме
        eprint!("{line}");
        if let Ok(mut guard) = self.file.lock() {
            if let Some(ref mut f) = *guard {
                let _ = f.write_all(line.as_bytes());
            }
        }
    }

    pub fn debug(&self, module: &str, msg: &str) { self.write("DEBUG", module, msg); }
    pub fn info (&self, module: &str, msg: &str) { self.write("INFO",  module, msg); }
    pub fn warn (&self, module: &str, msg: &str) { self.write("WARN",  module, msg); }
    pub fn error(&self, module: &str, msg: &str) { self.write("ERROR", module, msg); }
}

// ──────────────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────────────

use std::sync::Arc;

/// Прочитать последние N строк из актуального лог-файла
#[tauri::command]
pub fn read_log_tail(
    logger: tauri::State<'_, Arc<AppLogger>>,
    lines: usize,
) -> Result<Vec<String>, String> {
    let path = logger.current_log_path();
    let content = std::fs::read_to_string(&path)
        .unwrap_or_default();
    let all: Vec<&str> = content.lines().collect();
    let start = all.len().saturating_sub(lines);
    Ok(all[start..].iter().map(|s| s.to_string()).collect())
}

/// Вернуть путь к папке логов (для кнопки "Открыть в Проводнике")
#[tauri::command]
pub fn get_log_dir_path(
    logger: tauri::State<'_, Arc<AppLogger>>,
) -> String {
    logger.log_dir().to_string_lossy().to_string()
}

/// Открыть папку логов в Windows Explorer
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn open_log_dir_in_explorer(
    logger: tauri::State<'_, Arc<AppLogger>>,
) -> Result<(), String> {
    let path = logger.log_dir();
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn open_log_dir_in_explorer(
    logger: tauri::State<'_, Arc<AppLogger>>,
) -> Result<(), String> {
    let path = logger.log_dir();
    let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    Ok(())
}
