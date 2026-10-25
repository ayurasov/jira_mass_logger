## v1.0.8 - 2026-10-25

- feat: «Собрать день» v2 — полная автоматика и правка на шкале; незаполненное для чата (0b677ec)
- chore: release v1.0.7 — bump version + changelog (a79fa86)

## v1.0.7 - 2026-10-24

- feat(digest): «Главное за период», свой JQL, просрочка, активность по дням (d607c42)
- fix: лицензия на бэкенде, конфликты мастера по своим записям, без автообновления (5f1140b)
- feat: «Собрать день» и «Дайджест» изменений в Jira (732260f)
- fix: версия 1.0.7; календарь без целодневных и отменённых событий, мелкие ошибки (0bb06f5)
- fix(ui): ревизия вёрстки и тёмной темы, рабочие напоминания, настройки графика (ce668aa)
- feat: экран «Команда» — worklog коллег и проверка заполнения (790320e)
- fix(ui): ревизия логики дат, синхронизации, мастера и вёрстки (69a6478)
- fix(windows): убрать мигание консоли при обращениях к Jira; исправления бэкенда (a137789)
- chore: версия 1.0.6, .gitignore для node_modules/target/dist (29a2025)
- chore: release v1.0.5 — bump version + changelog (4869c18)

## v1.0.5 - 2026-08-28

- Update package.json (c845897)
- fix: скрыть окно при старте (visible:false) — показывать только после загрузки WebView, чтобы убрать мигание окна на Windows (df54118)
- fix: убрать мигание при переходе между экранами — убран on_window_event(Focused) из main.rs, usePowerEvents оставляет только visibilitychange (c5d1795)
- chore: release v1.0.4 — bump version + changelog (e536da8)

## v1.0.4 - 2026-08-28

- Update package.json (9e294d7)
- fix: убрать мигание окна — переиспользуемый reqwest::Client, убран дублирующий invoke в SyncStatusIndicator (0324a8b)
- chore: release v1.0.3 — bump version + changelog (56399ad)

## v1.0.3 - 2026-08-28

- Update package.json (34db946)
- feat(dashboard): show calendar import row in time-saving metric widget (def4580)
- feat(calendar): track calendar import entries in time-saving analytics (9b36324)
- feat(analytics): track calendar import entries in time-saving metric (607ef5b)
- feat(dashboard): add green 'sufficient fill' legend entry to hours-by-day chart (30551de)
- fix(dashboard): compact one-line date range picker in Breakdown widget (0992bcb)
- chore: release v1.0.2 — bump version + changelog (7a8726d)

## v1.0.2 - 2026-08-28

- Update package.json (d82b933)
- feat(onboarding): reuse OWA->EWS URL autofill logic from Profiles.vue in EWS onboarding step (cfc721e)
- fix(onboarding): skip onboarding on first launch if profiles already exist in DB (e.g. after reinstall) (4f44fa9)
- feat: add has_any_profiles command to detect pre-existing profiles and skip onboarding (efa9133)
- fix: hide console window in release builds (windows_subsystem) (4e931f0)
- chore: release v1.0.1 — bump version + changelog (3de7226)

# Changelog

## v1.0.1 - 2026-08-28

- fix(release): rename workflow to 'Publish release', move TAG_NAME/RELEASE_NAME to job-level env (top-level env can't reference needs context) (66815e7)
- Update package.json (2d87a88)
- feat(release): derive version from manifest on manual run + auto-generate CHANGELOG.md from commits since last release (ace7341)
- NEW KEY (7002739)
- docs(license-codegen): document history/comment fields + Windows .exe build via PyInstaller (24ada9b)
- chore(license-codegen): add pyinstaller to requirements for Windows .exe build (e4ddc35)
- chore(license-codegen): ignore local code history + pyinstaller build artifacts (d8177ec)
- feat(license-codegen): persistent code history + comment field in GUI generator (4f5f8f1)
- fix(license-codegen): factor grant_id out of generate_code for history persistence + comment support (ac67ec3)
- fix: date picker inline width + remove double border on Day from calendar page (7648ec0)
- fix: remove double border on date filters; template tags 2-column grid (7aeacd7)
- fix: filters date pickers inline + template tags slim column layout (4a9a6ab)
- fix: 4 UI правки — ширина лицензии +20%, убран JSON-импорт календаря, исправлена двойная обводка дат, элегантнее теги шаблонов (e8f35fc)
- ui: wider license modal, remove holiday import, fix datepicker border, elegant template tags (828a8e8)
- feat: license guard on MyWorklog inline edit; remove Exchange section from Settings; fix weekday chips layout in BulkLogWizard (89c25b8)
- feat: enforce license guards on all write operations + wider license modal (ed1804f)
- feat: license enforcement — modal on write ops, wider AboutPanel (2364f67)
- fix: remove guardedInvoke license guard from frontend (502a738)
- fix: remove license enforcement — write operations always allowed (5bbf40e)
- ci: fix workflow — add Tauri deps, scope tests to unit-only (b83d7ee)
- public key (438d6ed)
- license: README, requirements.txt и .gitignore для tools/license-codegen (97148e4)
- fix: исправлена синтаксическая ошибка в license_gui.py (_copy_last) (0222c86)
- license: GUI-генератор кодов (Tkinter, license_gui.py) взамен только-CLI скриптов (fb5d200)
- license: CLI generate_key.py и generate_code.py поверх общей логики (66e60fe)
- license: общая логика генерации кодов (license_core.py) для CLI и GUI генераторов (a1dff76)
- license(step4): tauriApi license types + AboutPanel license block + LICENSE_REQUIRED interceptor (760f1e1)
- license(step3b): register license module, LicenseDb state and Tauri commands in main.rs (d624270)
- license(step3a): init license tables in db.rs (c59f1a7)
- license(step2): add license.rs — Ed25519 offline code verification, accumulation, DB state (8ce9917)
- license(step1): add ed25519-dalek + data-encoding deps for offline license codes (db2d37b)
- feat: auto-bump version in package.json/tauri.conf.json/Cargo.toml on manual release run (24f13a6)

