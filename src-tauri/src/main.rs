// JiraTime — точка входа Tauri-приложения
mod jira_client;
mod exchange_client;
mod db;
mod scheduler;
mod secrets;

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
        .setup(|app| {
            db::init_db(app.handle())?;

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
            jira_client::test_jira_connection,
            jira_client::submit_worklog,
            exchange_client::test_exchange_connection,
            secrets::save_secret,
            secrets::delete_secret,
        ])
        .run(tauri::generate_context!())
        .expect("error while running JiraTime");
}
