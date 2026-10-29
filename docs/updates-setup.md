# Автообновление JiraTime: настройка релизов

Приложение проверяет `latest.json` и ставит только обновления, подписанные вашим ключом.
Пока ключ не настроен, релизы собираются как раньше, а в «Настройки → Обновления»
написано, что новые версии ставятся вручную.

## 1. Ключ подписи (один раз)

На своём компьютере, в папке проекта:

```bash
npx tauri signer generate -w ~/.tauri/jiratime-updater.key
```

Появятся два файла: `jiratime-updater.key` (приватный) и `jiratime-updater.key.pub` (публичный).
Сохраните приватный ключ и пароль в надёжном месте: без них выпустить обновление для уже
установленных копий будет невозможно.

## 2. Секреты и переменные репозитория

GitHub → Settings → Secrets and variables → Actions:

| Тип | Имя | Значение |
|---|---|---|
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | содержимое `jiratime-updater.key` |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | пароль ключа |
| Variable | `TAURI_UPDATER_PUBKEY` | содержимое `jiratime-updater.key.pub` |

## 3. Откуда приложение берёт обновления

Приложение скачивает обновления без авторизации, поэтому они должны лежать в **публичном**
репозитории.

* **Основной репозиторий публичный** — больше ничего не нужно.
* **Основной репозиторий приватный** (как сейчас) — создайте публичный репозиторий только для
  релизов (например, `ayurasov/jiratime-releases`) с README (нужен хотя бы один коммит) и добавьте:

| Тип | Имя | Значение |
|---|---|---|
| Variable | `UPDATES_REPO` | `ayurasov/jiratime-releases` |
| Secret | `UPDATES_REPO_TOKEN` | fine-grained token с правом *Contents: Read and write* на этот репозиторий |

Релизный workflow продублирует туда установщики, подписи и `latest.json`.

## 4. Как это работает при релизе

`Publish release` (workflow_dispatch):

1. `.github/scripts/updater-config.mjs` включает `createUpdaterArtifacts` и вшивает в сборку
   публичный ключ и адрес `https://github.com/<репозиторий>/releases/latest/download/latest.json`.
2. Сборки Windows и macOS подписывают файлы обновления (`*.sig`).
3. Джоба `update-feed` собирает `latest.json` из подписей (`.github/scripts/update-feed.mjs`)
   и при заданном `UPDATES_REPO` копирует обновление в публичный репозиторий.

Версии до 1.0.12 автообновления не содержат — первую версию с ним нужно установить вручную.
Адрес канала зашивается в сборку: если потом сменить `UPDATES_REPO`, уже установленные копии
продолжат проверять старый адрес до следующего обновления.

## 5. Проверки (CI)

Каждый PR проверяют workflows «Checks» (`.github/workflows/checks.yml`: типы, тесты интерфейса
`npm test`, сборка, тесты Rust на Windows и macOS) и «Integration tests» (`integration.yml`).
Прежние «CI» и «Integration Tests (offline-to-sync)» были выключены в настройках репозитория;
файлы перенесены на новые пути, поэтому GitHub считает их новыми, включёнными workflows.
