// JiraTime — точка входа Tauri-приложения
mod jira_client;
mod exchange_client;
mod db;
mod scheduler;
mod secrets;
mod bulk_wizard;
mod sync_queue;

use tauri::{Manager, tray::TrayIconBuilder, menu::{Menu, MenuItem}};

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
        .setup(|app| {
            db::init_db(app.handle())?;
            bulk_wizard::setup(app.handle())?;

            let log_today = MenuItem::with_id(app, "log_today", "Залогировать сегодня", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&log_today, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("JiraTime")
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "log_today" => {
                            let _ = app.emit("tray:log_today", ());
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Windows может резко переводить ноутбук в спящий режим; при выходе из
            // сна окно получает Focused(true) после долгого простоя — используем
            // это как best-effort триггер форс-ресинхронизации на фронтенде
            // (там сравнивается время последнего sync с текущим, и если разрыв
            // большой — считаем это пробуждением системы, а не обычным alt-tab).
            let app_handle_for_resume = app.handle().clone();
            if let Some(main_window) = app.get_webview_window("main") {
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(true) = event {
                        let _ = app_handle_for_resume.emit("system:possible_resume", ());
                    }
                });
            }

            scheduler::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            bulk_wizard::save_wizard_template,
            bulk_wizard::list_wizard_templates,
            bulk_wizard::delete_wizard_template,
            bulk_wizard::touch_recent_issue,
            bulk_wizard::set_issue_favorite,
            bulk_wizard::get_recent_issues,
            bulk_wizard::get_custom_holidays,
            bulk_wizard::import_holidays,
            bulk_wizard::write_export_file,
            bulk_wizard::write_export_file_utf8_bom,
            sync_queue::enqueue_sync_operation,
            sync_queue::list_sync_queue,
            sync_queue::mark_sync_attempt_failed,
            sync_queue::remove_sync_queue_item,
            sync_queue::clear_sync_queue,
            sync_queue::upsert_cached_worklog,
            sync_queue::delete_cached_worklog,
            sync_queue::list_cached_worklogs,
            exchange_client::test_exchange_connection,
            secrets::save_secret,
            secrets::delete_secret,
        ])
        .run(tauri::generate_context!())
        .expect("error while running JiraTime");
}
