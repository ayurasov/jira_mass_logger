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

