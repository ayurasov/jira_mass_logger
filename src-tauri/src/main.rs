// JiraTime — точка входа Tauri-приложения
mod jira_client;
mod exchange_client;
mod db;
mod scheduler;
mod secrets;
mod bulk_wizard;

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

            scheduler::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            jira_client::test_connection,
            jira_client::get_projects,
            jira_client::get_issues_by_jql,
            jira_client::get_worklog,
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
            exchange_client::test_exchange_connection,
            secrets::save_secret,
            secrets::delete_secret,
        ])
        .run(tauri::generate_context!())
        .expect("error while running JiraTime");
}
