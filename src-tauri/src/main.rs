// JiraTime — точка входа Tauri-приложения
// В release-сборке под Windows скрываем консольное окно cmd.exe, которое
// иначе остаётся открытым рядом с приложением на всё время его работы.
// В debug-сборке консоль оставляем — там она нужна для вывода println!/логов.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod jira_client;
mod jira_profiles;
mod exchange_client;
mod db;
mod scheduler;
mod secrets;
mod bulk_wizard;
mod sync_queue;
mod sync_queue_helpers;
mod meeting_rules;
mod network;
mod logger;
mod logger_noop;
mod license;

use std::sync::{Arc, Mutex};
use tauri::{Manager, Emitter, tray::TrayIconBuilder, menu::{Menu, MenuItem}};
use crate::logger::AppLogger;
use crate::network::NetworkMonitor;
use crate::sync_queue::WakeSignal;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Открытие системного браузера/файлов (используется в Profiles.vue для Graph OAuth)
        .plugin(tauri_plugin_opener::init())
        // Автообновление через GitHub Releases (Промпт 10)
        // installMode: quiet — обновление ставится в %LOCALAPPDATA% без UAC
        // если NSIS установил приложение в currentUser режиме
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            db::init_db(app.handle())?;

            // ── LicenseDb state ────────────────────────────────────────────────────────────
            {
                let app_data_dir = app.path().app_data_dir()
                    .expect("failed to get app data dir");
                let db_path = app_data_dir.join("jiratime.db");
                let lic_conn = rusqlite::Connection::open(&db_path)
                    .expect("failed to open license db");
                app.manage(license::LicenseDb(Arc::new(Mutex::new(lic_conn))));
            }

            bulk_wizard::setup(app.handle())?;

            // ── Подсистема логирования ──────────────────────────────────────────────
            let app_logger = Arc::new(
                AppLogger::new(app.handle())
                    .expect("failed to init AppLogger"),
            );
            app.manage(app_logger.clone());

            // ── WakeSignal для воркера очереди ─────────────────────────────────────────
            let wake: WakeSignal = Arc::new(tokio::sync::Notify::new());
            app.manage(wake.clone());

            // ── Монитор сети ───────────────────────────────────────────────────────────
            let net_monitor = Arc::new(NetworkMonitor::new());
            app.manage(net_monitor.clone());

            network::start_network_monitor(
                net_monitor.clone(),
                wake.clone(),
                app.handle().clone(),
                app_logger.clone(),
            );

            // ── Воркер очереди синхронизации ───────────────────────────────────────
            let wizard_db = app.state::<bulk_wizard::WizardDb>();
            let db_arc: Arc<Mutex<rusqlite::Connection>> = wizard_db.0.clone();
            sync_queue::start_worker(db_arc, wake.clone(), app_logger.clone());

            // ── Планировщик (напоминания, автосинхронизация) ───────────────────────
            let sched_state = scheduler::init_scheduler(app.handle(), &wizard_db);
            app.manage(sched_state);

            // ── Системный трей ───────────────────────────────────────────────────────────
            let log_today = MenuItem::with_id(app, "log_today", "Залогировать сегодня", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&log_today, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("JiraTime")
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "log_today" => { let _ = app.emit("tray:log_today", ()); }
                        "quit" => { app.exit(0); }
                        _ => {}
                    }
                })
                .build(app)?;

            // ВАЖНО: on_window_event(Focused) намеренно НЕ используется.
            // Ретрансляция фокуса через Rust вызывала мигание на Windows при каждом
            // переходе между экранами (каждый Focused(true) → system:possible_resume →
            // notify_system_resume → HTTP health-check к Jira).
            // Обнаружение пробуждения системы выполняется исключительно через
            // visibilitychange в usePowerEvents.ts — это надёжнее и без побочных эффектов.

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Jira
            jira_client::test_connection,
            jira_client::get_projects,
            jira_client::get_issues_by_jql,
            jira_client::get_worklog,
            jira_client::get_worklog_by_id,
            jira_client::get_worklogs_since,
            jira_client::add_worklog,
            jira_client::update_worklog,
            jira_client::delete_worklog,
            jira_client::bulk_add_worklogs,
            // Jira profiles CRUD
            jira_profiles::list_jira_profiles,
            jira_profiles::save_jira_profile,
            jira_profiles::delete_jira_profile,
            jira_profiles::test_jira_connection,
            jira_profiles::reset_app_data,
            jira_profiles::has_any_profiles,
            // Exchange
            exchange_client::test_exchange_connection,
            exchange_client::get_calendar_events,
            exchange_client::start_graph_oauth_embedded,
            exchange_client::complete_graph_oauth_loopback,
            exchange_client::list_exchange_profiles,
            exchange_client::save_exchange_profile,
            exchange_client::delete_exchange_profile,
            // Bulk wizard
            bulk_wizard::save_wizard_template,
            bulk_wizard::list_wizard_templates,
            bulk_wizard::delete_wizard_template,
            bulk_wizard::save_template,
            bulk_wizard::list_templates,
            bulk_wizard::delete_template,
            bulk_wizard::increment_template_usage,
            bulk_wizard::touch_recent_issue,
            bulk_wizard::set_issue_favorite,
            bulk_wizard::get_recent_issues,
            bulk_wizard::get_custom_holidays,
            bulk_wizard::import_holidays,
            bulk_wizard::write_export_file,
            bulk_wizard::write_export_file_utf8_bom,
            // Sync queue & cached worklogs
            sync_queue::enqueue_sync_operation,
            sync_queue::list_sync_queue,
            sync_queue::mark_sync_attempt_failed,
            sync_queue::remove_sync_queue_item,
            sync_queue::clear_sync_queue,
            sync_queue::upsert_cached_worklog,
            sync_queue::delete_cached_worklog,
            sync_queue::list_cached_worklogs,
            sync_queue::replace_cached_worklogs_range,
            // Network / sync status indicator
            network::get_sync_indicator,
            network::notify_system_resume,
            // Logger
            logger::read_log_tail,
            logger::get_log_dir_path,
            logger::open_log_dir_in_explorer,
            // Secrets
            secrets::save_secret,
            secrets::delete_secret,
            // Meeting rules
            meeting_rules::suggest_issue_for_meeting,
            meeting_rules::remember_meeting_issue_match,
            meeting_rules::list_meeting_match_rules,
            meeting_rules::save_meeting_match_rule,
            meeting_rules::delete_meeting_match_rule,
            meeting_rules::get_meeting_issue_history,
            // Scheduler
            scheduler::get_scheduler_settings,
            scheduler::save_scheduler_settings,
            scheduler::trigger_sync_now,
            // License
            license::get_license_status,
            license::activate_license_code,
        ])
        .run(tauri::generate_context!())
        .expect("error while running JiraTime");
}
