# JiraTime

Десктопное Windows-приложение для массового логирования времени (worklog) в Jira.
Поддерживает интеграцию с Microsoft Exchange/Graph для автозаполнения из календаря,
offline-очередь синхронизации, аналитический дашборд и тёмную/светлую тему.

---

## Содержание

1. [Требования](#требования)
2. [Установка](#установка)
3. [Получение Jira API-токена](#получение-jira-api-токена)
4. [Настройка Azure AD (Microsoft Graph)](#настройка-azure-ad-microsoft-graph)
5. [Первый запуск на Windows 10/11](#первый-запуск-на-windows-1011)
6. [Горячие клавиши](#горячие-клавиши)
7. [Типичные проблемы](#типичные-проблемы)
8. [Сборка из исходников](#сборка-из-исходников)
9. [Стек технологий](#стек-технологий)

---

## Требования

- Windows 10 (1903+) или Windows 11
- [WebView2 Runtime](https://developer.microsoft.com/ru-ru/microsoft-edge/webview2/) — устанавливается автоматически инсталлятором
- Доступ к Jira Cloud или Jira Server (версия ≥ 8.x)
- Опционально: Microsoft Exchange 2016+ или Microsoft 365 для интеграции с календарём

---

## Установка

1. Скачайте последний релиз со страницы [Releases](https://github.com/ayurasov/jira_mass_logger/releases):
   - `JiraTime_x.y.z_x64-setup.exe` — NSIS-инсталлятор для x64 (рекомендуется)
   - `JiraTime_x.y.z_x64_ru-RU.msi` — MSI-пакет (для корпоративного деплоя через GPO/SCCM)
   - `JiraTime_x.y.z_arm64-setup.exe` — для Windows on ARM (Surface Pro X, Copilot+ PC)
2. Запустите инсталлятор. NSIS по умолчанию устанавливает в `%LOCALAPPDATA%\Programs\JiraTime` — **не требует прав администратора** и поддерживает автообновление без UAC.
3. При первом запуске Windows SmartScreen может показать предупреждение «Неизвестный издатель» — нажмите «Подробнее» → «Выполнить» (см. [раздел SmartScreen](#smartscreen-неизвестный-издатель)).

---

## Получение Jira API-токена

### Jira Cloud

1. Войдите в [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Нажмите **Create API token**.
3. Дайте токену имя (например, `JiraTime`) и нажмите **Create**.
4. **Скопируйте токен сразу** — он показывается только один раз.
5. В JiraTime при настройке профиля:
   - **Jira URL** — например `https://yourcompany.atlassian.net`
   - **Email** — ваш email в Atlassian
   - **Token** — скопированный API-токен
   - **Тип аутентификации** — `Bearer` (Cloud)

### Jira Server / Data Center

1. В Jira откройте **Профиль** → **Personal Access Tokens**.
2. Нажмите **Create token**, задайте срок действия.
3. Скопируйте токен.
4. В JiraTime:
   - **Jira URL** — например `https://jira.yourcompany.ru`
   - **Token** — Personal Access Token
   - **Тип аутентификации** — `Bearer` (Server/DC)

> **Права токена**: для записи worklog токен должен иметь разрешение `Work On Issues` на соответствующие проекты.

---

## Настройка Azure AD (Microsoft Graph)

Нужно только если вы хотите импортировать встречи из **Microsoft 365 / Exchange Online** (не Exchange On-Premise с EWS).

### 1. Регистрация приложения в Azure AD

1. Откройте [Azure Portal](https://portal.azure.com) → **Azure Active Directory** → **Регистрация приложений** → **Новая регистрация**.
2. Название: `JiraTime`
3. Поддерживаемые типы учётных записей: **Только учётные записи в этом каталоге** (одиночный тенант).
4. **URI перенаправления**: выберите тип **Общедоступный клиент/машинный код (мобильный и рабочий стол)**, введите:
   ```
   http://localhost:37842/oauth/callback
   ```
   > Порт 37842 — дефолтный loopback-порт JiraTime. Если он занят, приложение подберёт следующий свободный.
5. Нажмите **Зарегистрировать**. Запишите **Application (client) ID** и **Directory (tenant) ID**.

### 2. Разрешения API

1. В зарегистрированном приложении перейдите в **Разрешения API** → **Добавить разрешение** → **Microsoft Graph** → **Делегированные разрешения**.
2. Добавьте:
   - `Calendars.Read` — чтение событий календаря
   - `User.Read` — базовая информация о пользователе (нужна для OIDC)
3. Нажмите **Предоставить согласие администратора** (если у вас есть права) или попросите IT-администратора.

### 3. Настройка в JiraTime

В разделе **Профили → Exchange/Graph** введите:
- **Tenant ID** — Directory (tenant) ID из Azure Portal
- **Client ID** — Application (client) ID из Azure Portal
- **Тип** — `Microsoft Graph (OAuth2)`

При первой синхронизации откроется браузер для авторизации Microsoft — войдите под корпоративным аккаунтом.

### Exchange On-Premise (EWS)

Для Exchange 2016/2019 On-Premise интеграция работает через EWS без Azure AD:
- **URL EWS** — например `https://mail.yourcompany.ru/EWS/Exchange.asmx`
- **Аутентификация** — `NTLM` (Windows Integrated) или `Basic` + логин/пароль

---

## Первый запуск на Windows 10/11

1. **Онбординг**: при первом запуске откроется мастер настройки из 4 шагов:
   - Шаг 1: Подключение к Jira (URL, токен, тест соединения)
   - Шаг 2: Подключение к Exchange/Graph (можно пропустить)
   - Шаг 3: Настройка рабочего графика (часы в день, рабочие дни, часовой пояс)
   - Шаг 4: Интерактивный тур по мастеру массового трекинга

2. **Автозапуск**: при желании включите «Запускать при старте Windows» в разделе **Настройки** — использует `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (не требует прав администратора).

3. **Системный трей**: после запуска JiraTime появляется в трее. Правый клик → «Залогировать сегодня» быстро открывает мастер трекинга.

4. **Автообновление**: JiraTime автоматически проверяет обновления на GitHub Releases при каждом запуске. Обновление устанавливается в фоне без перезапуска с правами администратора (установка в `%LOCALAPPDATA%`).

---

## Горячие клавиши

| Сочетание | Действие |
|-----------|----------|
| `Ctrl+N` | Открыть мастер массового трекинга |
| `Ctrl+L` | Перейти к таблице worklog (Мой журнал) |
| `Ctrl+M` | Свернуть в системный трей |
| `Enter` | Сохранить inline-редактирование |
| `Esc` | Отменить редактирование / закрыть диалог |

---

## Типичные проблемы

### SmartScreen «Неизвестный издатель»

**Причина**: приложение подписано OV/EV-сертификатом, но репутация нового сертификата ещё не накоплена у Microsoft.

**Решение**: нажмите «Подробнее» → «Выполнить». Репутация нарастает с количеством установок (обычно 2–4 недели).

**IT-администратор**: для корпоративного деплоя добавьте сертификат издателя в доверенные через GPO: `Computer Configuration → Windows Settings → Security Settings → Public Key Policies → Trusted Publishers`.

### Блокировка WebView2 корпоративной политикой

**Симптом**: при запуске приложение показывает белый экран или ошибку `WebView2 runtime not found`.

**Причины**:
- WebView2 Runtime не установлен (корпоративная политика запрещает его деплой)
- Политика GPO запрещает Edge-компоненты

**Решение**:
1. Запросите у IT-отдела установку WebView2 Runtime (офлайн-инсталлятор включён в пакет MSI как `MicrosoftEdgeWebView2RuntimeInstallerX64.exe`).
2. GPO-политика для разрешения WebView2: `Computer Configuration → Administrative Templates → Microsoft Edge WebView2 → Allow installation`.
3. Если WebView2 заблокирован полностью — обратитесь к администратору с запросом на whitelist `msedgewebview2.exe`.

### Корпоративный прокси

**Симптом**: JiraTime не может подключиться к Jira или GitHub при наличии прокси.

**Решение**: JiraTime использует `reqwest` с `rustls-tls` и автоматически читает системные настройки прокси Windows (`WinInet`/`WPAD`). Если прокси требует аутентификации NTLM:
1. Убедитесь что прокси прописан в **Параметры Windows → Прокси** или в `Internet Explorer → Настройки LAN`.
2. Если прокси требует сертификат корпоративного CA — добавьте его в **Сертификаты компьютера → Доверенные корневые центры сертификации** (через `certmgr.msc`).
3. Переменная окружения как fallback: `HTTPS_PROXY=http://proxy.corp:3128`.

### SSL Inspection / корпоративный MitM

**Симптом**: ошибка `certificate verify failed` или `InvalidCertificate` в логах.

**Причина**: корпоративный файрвол подменяет TLS-сертификаты.

**Решение**: импортируйте корпоративный CA-сертификат в хранилище Windows (`certmgr.msc → Доверенные корневые...`). `reqwest` с `rustls-tls` на Windows использует системное хранилище сертификатов.

### Логи для диагностики

Файлы логов находятся в `%LOCALAPPDATA%\JiraTime\logs\`. Открыть папку можно через **Настройки → Диагностика → Открыть папку логов** или перейти по маршруту `/logs` в приложении. Уровни логирования: `DEBUG`, `INFO`, `WARN`, `ERROR`. Для диагностики проблем передайте в поддержку файл `jiratime.log`.

---

## Сборка из исходников

### Требования к окружению

- Windows 10/11 с MSVC Build Tools (C++ workload)
- [Rust](https://rustup.rs/) stable (`rustup target add x86_64-pc-windows-msvc`)
- Node.js 20+
- [Tauri CLI](https://tauri.app/v2/guides/getting-started/prerequisites/): `cargo install tauri-cli`

### Запуск в режиме разработки

```powershell
npm install
npm run tauri dev
```

### Production-сборка

```powershell
npm run tauri build -- --target x86_64-pc-windows-msvc
# ARM:
npm run tauri build -- --target aarch64-pc-windows-msvc
```

Артефакты появятся в `src-tauri/target/<target>/release/bundle/`.

### Переменные окружения для code signing

| Переменная | Описание |
|---|---|
| `CODESIGN_PFX_PATH` | Путь к PFX-файлу сертификата |
| `CODESIGN_PFX_PASSWORD` | Пароль PFX |
| `TAURI_SIGNING_PRIVATE_KEY` | Приватный ключ для tauri-plugin-updater |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Пароль приватного ключа updater |

Генерация ключа updater: `cargo tauri signer generate -w ~/.tauri/jiratime.key`

---

## Стек технологий

| Слой | Технология |
|---|---|
| Frontend | Vue 3 + Vite + TypeScript + Pinia |
| Backend | Tauri 2 (Rust) + tokio async |
| БД | SQLite (rusqlite bundled) |
| HTTP | reqwest + rustls-tls |
| Графики | Apache ECharts 5 |
| Сборка | tauri-bundler → MSI (WiX) + NSIS |
| CI/CD | GitHub Actions (windows-latest + ubuntu-latest) |
| Секреты | Windows Credential Manager (keyring crate) |
| Логи | Файловый логгер с ротацией в %LOCALAPPDATA%\JiraTime\logs |

---

## Лицензия

[GPL-3.0](./LICENSE) © 2026 Alexander Yurasov
