# JiraTime — Подробная инструкция по запуску на Windows 10/11

> Актуально для версии **0.1.0+**. Охватывает: установку готового релиза, сборку из исходников, решение типичных проблем.

---

## Содержание

1. [Системные требования](#1-системные-требования)
2. [Установка готового релиза](#2-установка-готового-релиза)
   - [NSIS-инсталлятор (рекомендуется)](#21-nsis-инсталлятор-рекомендуется)
   - [MSI-пакет (корпоративный деплой)](#22-msi-пакет-корпоративный-деплой)
3. [Первый запуск и онбординг](#3-первый-запуск-и-онбординг)
   - [Шаг 1: Подключение к Jira](#31-шаг-1-подключение-к-jira)
   - [Шаг 2: Подключение к Exchange / Microsoft Graph](#32-шаг-2-подключение-к-exchange--microsoft-graph)
   - [Шаг 3: Рабочий график](#33-шаг-3-рабочий-график)
   - [Шаг 4: Интерактивный тур](#34-шаг-4-интерактивный-тур)
4. [Ежедневное использование](#4-ежедневное-использование)
5. [Сборка из исходников](#5-сборка-из-исходников)
   - [Установка зависимостей](#51-установка-зависимостей)
   - [Запуск в dev-режиме](#52-запуск-в-dev-режиме)
   - [Production-сборка](#53-production-сборка)
6. [Решение типичных проблем](#6-решение-типичных-проблем)
7. [Полезные пути и файлы](#7-полезные-пути-и-файлы)

---

## 1. Системные требования

| Компонент | Минимум | Рекомендуется |
|-----------|---------|---------------|
| ОС | Windows 10 версия 1903 (май 2019) | Windows 11 22H2+ |
| Архитектура | x86-64 | x86-64 или ARM64 (Copilot+ PC) |
| ОЗУ | 4 ГБ | 8 ГБ |
| Диск | 200 МБ свободного места | 500 МБ |
| WebView2 Runtime | Обязателен (устанавливается автоматически) | Evergreen версия |
| Разрешение экрана | 1024×600 | 1920×1080 |
| Масштабирование Windows | 100–200% | 125% или 150% |

> **WebView2** — это движок Chromium от Microsoft, встроенный в Windows 11.  
> На Windows 10 инсталлятор JiraTime автоматически скачивает и устанавливает WebView2 Runtime.
> На машинах без интернета используется офлайн-установщик, включённый в MSI-пакет.

---

## 2. Установка готового релиза

### 2.1 NSIS-инсталлятор (рекомендуется)

**Подходит для**: обычных пользователей, домашних и рабочих ПК без GPO-ограничений.

1. Откройте страницу [Releases](https://github.com/ayurasov/jira_mass_logger/releases/latest).
2. Скачайте файл:
   - **x64 (Intel/AMD)** → `JiraTime_x.y.z_x64-setup.exe`
   - **ARM64 (Surface Pro X, Copilot+ PC)** → `JiraTime_x.y.z_arm64-setup.exe`
3. Запустите скачанный `.exe`.
4. **Если появилось окно SmartScreen «Защитник Windows предотвратил запуск»:**
   - Нажмите **«Подробнее»** (ссылка под предупреждением).
   - Нажмите **«Выполнить в любом случае»**.
   - Это нормально для нового сертификата — репутация нарастает с числом установок.
5. Следуйте шагам инсталлятора. По умолчанию приложение устанавливается в:
   ```
   %LOCALAPPDATA%\Programs\JiraTime
   ```
   **Права администратора не нужны** — установка идёт в профиль пользователя.
6. После установки иконка JiraTime появится на рабочем столе и в меню «Пуск».

---

### 2.2 MSI-пакет (корпоративный деплой)

**Подходит для**: IT-отделов, деплоя через GPO, SCCM, Intune.

```powershell
# Тихая установка для текущего пользователя
msiexec /i JiraTime_x.y.z_x64_ru-RU.msi /quiet /norestart

# Тихая установка для всех пользователей (требует прав администратора)
msiexec /i JiraTime_x.y.z_x64_ru-RU.msi /quiet /norestart ALLUSERS=1

# Тихое удаление
msiexec /x JiraTime_x.y.z_x64_ru-RU.msi /quiet /norestart
```

> При установке с `ALLUSERS=1` автообновление без UAC недоступно — обновление потребует прав администратора.  
> Для автообновления без UAC используйте установку в `%LOCALAPPDATA%` (NSIS-инсталлятор без `ALLUSERS`).

**Проверка установки через Intune (`.intunewin`):**
```
Имя приложения: JiraTime
Команда установки: msiexec /i JiraTime.msi /quiet /norestart
Команда удаления:  msiexec /x {PRODUCT-GUID} /quiet
Проверка наличия: %LOCALAPPDATA%\Programs\JiraTime\JiraTime.exe
```

---

## 3. Первый запуск и онбординг

При первом запуске открывается **мастер первоначальной настройки** из 4 шагов.  
Мастер не закроется, пока не будет завершён или пока не появится хотя бы один Jira-профиль.

### 3.1 Шаг 1: Подключение к Jira

**Jira Cloud (atlassian.net):**

1. Перейдите на [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Нажмите **Create API token** → введите имя (например `JiraTime`) → **Create**.
3. **Скопируйте токен немедленно** — он отображается только один раз.
4. В мастере JiraTime заполните:
   | Поле | Значение |
   |------|----------|
   | Jira URL | `https://yourcompany.atlassian.net` |
   | Email | ваш email в Atlassian |
   | Токен / Пароль | скопированный API-токен |
   | Тип | Bearer (Cloud) |
5. Нажмите **«Проверить соединение»** — должна появиться зелёная галочка.

**Jira Server / Data Center (on-premise):**

1. В Jira: **Профиль → Personal Access Tokens → Create token**.
2. Укажите срок действия. Скопируйте токен.
3. В мастере JiraTime:
   | Поле | Значение |
   |------|----------|
   | Jira URL | `https://jira.yourcompany.ru` |
   | Токен | Personal Access Token |
   | Тип | Bearer (Server/DC) |

> **Минимальные права токена**: `Work On Issues` на нужных проектах. Без этого разрешения логирование времени вернёт ошибку 403 рядом с задачей.

---

### 3.2 Шаг 2: Подключение к Exchange / Microsoft Graph

> Этот шаг **опциональный** — нажмите «Пропустить», если интеграция с календарём не нужна.

**Microsoft 365 / Exchange Online (через Microsoft Graph):**

*Предварительно* (один раз, делает IT-администратор или вы, если есть права Azure AD):

1. Откройте [portal.azure.com](https://portal.azure.com) → **Azure Active Directory → Регистрация приложений → Новая регистрация**.
2. Название: `JiraTime`, тип: **Общедоступный клиент (мобильный и рабочий стол)**.
3. URI перенаправления (тип **Public client/native**):
   ```
   http://localhost:37842/oauth/callback
   ```
4. Запишите **Application (client) ID** и **Directory (tenant) ID**.
5. **Разрешения API → Добавить → Microsoft Graph → Делегированные**:
   - `Calendars.Read`
   - `User.Read`
6. Нажмите **Предоставить согласие администратора**.

В мастере JiraTime:
| Поле | Значение |
|------|----------|
| Tenant ID | Directory (tenant) ID из Azure Portal |
| Client ID | Application (client) ID из Azure Portal |
| Тип | Microsoft Graph (OAuth2) |

При первой синхронизации откроется браузер — войдите под корпоративным аккаунтом Microsoft.

**Exchange On-Premise (EWS):**

| Поле | Значение |
|------|----------|
| URL EWS | `https://mail.yourcompany.ru/EWS/Exchange.asmx` |
| Тип аутентификации | NTLM (Windows Integrated) или Basic |
| Логин / Пароль | корпоративные учётные данные |

---

### 3.3 Шаг 3: Рабочий график

Настройте расписание — оно используется для:
- Подсветки «дырок» в worklog на дашборде.
- Расчёта нормы часов (план vs факт).
- Исключения праздников из периода в мастере.

| Поле | Рекомендуемое значение |
|------|------------------------|
| Рабочие дни | Пн–Пт |
| Часов в день | 8 |
| Часовой пояс | Ваш локальный (например `Europe/Moscow`) |
| Праздники | загружаются автоматически по локали или вводятся вручную |

> Часовой пояс критичен для корректной передачи поля `started` в Jira API.  
> JiraTime передаёт время в формате ISO 8601 с явным offset (`2026-01-15T10:00:00+03:00`),  
> что правильно обрабатывает переходы летнее/зимнее время.

---

### 3.4 Шаг 4: Интерактивный тур

Четыре слайда — краткое знакомство с ключевыми функциями:
1. **Ctrl+N** — быстрое открытие мастера массового трекинга
2. **Дашборд** — heatmap и аналитика по неделям
3. **Ctrl+L** — журнал worklog, inline-редактирование
4. **Напоминания** — уведомление в конце рабочего дня

Нажмите **«Начать работу 🚀»** — откроется главный экран.

---

## 4. Ежедневное использование

### Горячие клавиши

| Сочетание | Действие |
|-----------|----------|
| `Ctrl+N` | Открыть мастер массового трекинга |
| `Ctrl+L` | Перейти к таблице worklog (Мой журнал) |
| `Ctrl+M` | Свернуть в системный трей |
| `Enter` | Сохранить inline-редактирование |
| `Esc` | Отменить редактирование / закрыть диалог |

### Системный трей

После сворачивания JiraTime живёт в системном трее (правый нижний угол экрана).

- **Один клик по иконке** → разворачивает окно.
- **Правый клик** → контекстное меню:
  - «Залогировать сегодня» → открывает мастер с сегодняшней датой.
  - «Выход» → полностью завершает процесс.

### Автозапуск

**Настройки → Автозапуск → Запускать при старте Windows.**  
Записывается в `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` — **не требует прав администратора**.

### Автообновление

При запуске приложение через 5 секунд проверяет `latest.json` на GitHub Releases.  
Если доступна новая версия — появляется диалог с предложением обновиться.  
Обновление устанавливается в `%LOCALAPPDATA%` — **без UAC-запроса**.

---

## 5. Сборка из исходников

### 5.1 Установка зависимостей

**1. Microsoft C++ Build Tools (MSVC)**

```powershell
# Скачайте Build Tools с официального сайта Microsoft:
# https://visualstudio.microsoft.com/visual-cpp-build-tools/
# При установке выберите workload: "Desktop development with C++"
```

Или через winget:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**2. Rust (stable)**

```powershell
# Скачайте rustup-init.exe с https://rustup.rs/ или:
winget install Rustlang.Rustup

# После установки добавьте target:
rustup target add x86_64-pc-windows-msvc

# Для ARM64 (опционально):
rustup target add aarch64-pc-windows-msvc

# Проверьте:
rustc --version   # rustc 1.78.0 или новее
cargo --version
```

**3. Node.js 20+**

```powershell
winget install OpenJS.NodeJS.LTS
# Проверьте:
node --version    # v20.x.x или новее
npm --version
```

**4. Tauri CLI**

```powershell
cargo install tauri-cli --version "^2.0"
# Или через npm (быстрее, без компиляции):
npm install -g @tauri-apps/cli@^2.0
```

**5. Клонирование репозитория**

```powershell
git clone https://github.com/ayurasov/jira_mass_logger.git
cd jira_mass_logger
npm install
```

---

### 5.2 Запуск в dev-режиме

```powershell
npm run tauri dev
```

Что происходит:
1. Vite запускает dev-сервер на `http://localhost:5173`.
2. Tauri компилирует Rust-бэкенд (первый раз — 3–7 минут).
3. Открывается окно приложения с hot-reload фронтенда.

> **Первая компиляция Rust** занимает значительное время — это нормально.  
> Последующие запуски — 10–30 секунд (инкрементальная сборка).

**Полезные флаги:**
```powershell
# Подробный вывод Rust-компилятора:
$env:RUST_BACKTRACE=1; npm run tauri dev

# Только фронтенд (без Tauri, для работы с UI):
npm run dev
# Откройте http://localhost:5173 в браузере
```

---

### 5.3 Production-сборка

```powershell
# x64 (Intel/AMD):
npm run tauri build -- --target x86_64-pc-windows-msvc

# ARM64 (Windows on ARM):
npm run tauri build -- --target aarch64-pc-windows-msvc
```

**Артефакты** появятся в:
```
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
├── nsis/
│   └── JiraTime_0.1.0_x64-setup.exe     ← NSIS-инсталлятор
└── msi/
    └── JiraTime_0.1.0_x64_ru-RU.msi     ← MSI-пакет
```

**Code signing (локально):**

```powershell
# Установите переменные окружения перед сборкой:
$env:CODESIGN_PFX_PATH     = "C:\certs\jiratime.pfx"
$env:CODESIGN_PFX_PASSWORD = "your-pfx-password"
$env:TAURI_SIGNING_PRIVATE_KEY          = "<base64-ключ>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<пароль>"

npm run tauri build -- --target x86_64-pc-windows-msvc
```

Сгенерировать ключ подписи updater:
```powershell
cargo tauri signer generate -w $env:USERPROFILE\.tauri\jiratime.key
# Публичный ключ — вставьте в tauri.conf.json > plugins > updater > pubkey
# Приватный ключ — в TAURI_SIGNING_PRIVATE_KEY (base64)
```

---

## 6. Решение типичных проблем

### ❌ SmartScreen: «Защитник Windows предотвратил запуск»

**Причина:** новый сертификат, репутация ещё не накоплена.

**Решение:**
- Нажмите **«Подробнее»** → **«Выполнить в любом случае»**.
- Репутация нарастает автоматически (~2–4 недели, ~1000+ установок).

**Для IT-администраторов** (корпоративный деплой):
```
GPO: Computer Configuration → Windows Settings → Security Settings
     → Public Key Policies → Trusted Publishers
     → Импортировать сертификат издателя
```

---

### ❌ Белый экран или ошибка «WebView2 Runtime not found»

**Причина:** WebView2 Runtime не установлен или заблокирован GPO.

**Шаг 1** — проверьте наличие:
```powershell
# Проверить установленные версии WebView2:
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
# Если пусто — WebView2 не установлен
```

**Шаг 2** — установите вручную:
```powershell
# Онлайн-установка (Evergreen Bootstrapper):
Start-Process "MicrosoftEdgeWebview2Setup.exe" -ArgumentList "/silent /install" -Wait

# Офлайн-установка (из папки с MSI-пакетом JiraTime):
.\MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install
```

**Шаг 3** — если GPO блокирует Edge-компоненты:
```
GPO: Computer Configuration → Administrative Templates
     → Microsoft Edge WebView2 → Allow installation of WebView2
     → Enabled
```

---

### ❌ Не удаётся подключиться к Jira (ошибка 407 или «Proxy auth required»)

**Причина:** корпоративный прокси требует аутентификации.

**Решение:**
1. Убедитесь, что прокси прописан в **Параметры Windows → Сеть → Прокси** или в настройках Internet Explorer.
2. JiraTime автоматически читает системные настройки прокси (`WinInet`/`WPAD`).
3. Если автоопределение не работает — задайте переменную окружения:
   ```powershell
   # Установить постоянно для текущего пользователя:
   [System.Environment]::SetEnvironmentVariable("HTTPS_PROXY", "http://proxy.corp.ru:3128", "User")
   # Перезапустите JiraTime
   ```
4. Если прокси использует NTLM-аутентификацию — убедитесь, что учётные данные Windows актуальны.

---

### ❌ Ошибка TLS / «certificate verify failed»

**Причина:** корпоративный файрвол подменяет TLS-сертификаты (SSL Inspection / MitM).

**Решение:**
```powershell
# 1. Получите корпоративный CA-сертификат у IT-отдела (файл .cer или .crt)
# 2. Импортируйте его в хранилище компьютера:
CertUtil -addstore "Root" C:\path\to\corporate-ca.cer
# Или через GUI: Win+R → certmgr.msc → Доверенные корневые центры → Импорт
```

---

### ❌ Ошибка сборки: «LINK : fatal error LNK1181»

**Причина:** не установлены MSVC Build Tools или выбрана неверная архитектура.

**Решение:**
```powershell
# Убедитесь, что rustup использует MSVC toolchain:
rustup show
# Должно быть: stable-x86_64-pc-windows-msvc

# Если установлен GNU toolchain — переключитесь:
rustup default stable-msvc
```

---

### ❌ «Cannot find module '@tauri-apps/api'» при сборке

```powershell
# Удалите node_modules и переустановите:
Remove-Item -Recurse -Force node_modules
npm install
```

---

### ❌ Приложение не обновляется (нет диалога обновления)

1. Проверьте, что `latest.json` доступен:
   ```
   https://github.com/ayurasov/jira_mass_logger/releases/latest/download/latest.json
   ```
2. Убедитесь, что версия в `latest.json` **выше** текущей установленной.
3. Проверьте правильность публичного ключа в `tauri.conf.json → plugins → updater → pubkey`.
4. Логи обновления: `%LOCALAPPDATA%\JiraTime\logs\jiratime.log`

---

## 7. Полезные пути и файлы

| Назначение | Путь |
|------------|------|
| Исполняемый файл | `%LOCALAPPDATA%\Programs\JiraTime\JiraTime.exe` |
| База данных SQLite | `%LOCALAPPDATA%\ru.ayurasov.jiratime\jiratime.db` |
| Логи приложения | `%LOCALAPPDATA%\JiraTime\logs\jiratime.log` |
| Автозапуск (реестр) | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\JiraTime` |
| Удаление (NSIS) | **Параметры → Приложения → JiraTime → Удалить** |
| Удаление (MSI) | `msiexec /x {GUID}` или через «Программы и компоненты» |
| Сброс онбординга | Удалить строку `onboarding_done` из `jiratime.db` (таблица `settings`) |

---

> Если ваша проблема не описана выше — откройте issue на GitHub:  
> [https://github.com/ayurasov/jira_mass_logger/issues](https://github.com/ayurasov/jira_mass_logger/issues)  
> Приложите содержимое `%LOCALAPPDATA%\JiraTime\logs\jiratime.log`.
