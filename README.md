# JiraTime

Десктопное приложение для массового логирования времени (worklog) в Jira.

## Стек

- **Backend**: Tauri 2 (Rust)
- **Frontend**: Vue 3 + Vite + Pinia + TypeScript
- **БД**: SQLite (tauri-plugin-sql / rusqlite)
- **Секреты**: OS keychain через `keyring` (Rust)

## Структура проекта

```
jira_mass_logger/
├── src/                        # Vue-приложение
│   ├── main.ts
│   ├── App.vue
│   ├── router/index.ts
│   ├── store/                  # Pinia stores
│   │   ├── settings.ts
│   │   └── jiraProfiles.ts
│   ├── views/                  # Dashboard, Profiles, Templates, Settings
│   └── styles/theme.css        # светлая/тёмная тема
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── main.rs             # точка входа, трей, меню, invoke_handler
│   │   ├── jira_client.rs      # Jira REST API (auth, worklog)
│   │   ├── exchange_client.rs  # Exchange EWS (рабочие дни/встречи)
│   │   ├── db.rs               # инициализация SQLite
│   │   ├── scheduler.rs        # фоновые задачи/напоминания
│   │   └── secrets.rs          # OS keychain (keyring)
│   ├── capabilities/default.json
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Ключевые зависимости

**npm**: vue, vue-router, pinia, @tauri-apps/api, @tauri-apps/plugin-sql, @tauri-apps/plugin-autostart, @tauri-apps/plugin-notification, @tauri-apps/plugin-shell, @tauri-apps/cli, vite, typescript, vue-tsc

**Cargo**: tauri (tray-icon), tauri-plugin-sql (sqlite), tauri-plugin-autostart, tauri-plugin-notification, tauri-plugin-shell, keyring, rusqlite (bundled), reqwest (rustls-tls), tokio (full), serde/serde_json, chrono, anyhow, thiserror

## Хранимые данные (SQLite)

- `jira_profiles` — профили подключения к Jira (base_url, email, type; сам токен — в keychain, тут только `secret_ref`)
- `exchange_profiles` — профили Exchange/EWS
- `templates` — шаблоны массового трекинга (issue_key, описание, часы, дни недели, период)
- `worklog_cache` — кэш последних worklog-записей
- `settings` — таймзона, рабочие часы, праздники/выходные

## Особенности

- Секреты (API-токены/PAT) никогда не хранятся в БД в открытом виде — только ссылка (`secret_ref`) на запись в OS keychain (`keyring` crate).
- Системный трей с пунктом меню «Залогировать сегодня», отправляющим событие `tray:log_today` во фронтенд.
- Автозапуск при старте системы через `tauri-plugin-autostart`.
- Светлая/тёмная тема управляется Pinia store `settings` и сохраняется в `localStorage`.
