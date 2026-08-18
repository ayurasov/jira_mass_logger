# Промпт 9 — Интеграция в проект

## Что уже готово (существует в Rust-бэкенде)

| Файл | Что делает |
|------|----------|
| `src-tauri/src/sync_queue.rs` | Очередь SQLite, воркер tokio, exponential backoff, rate-limit |
| `src-tauri/src/network.rs` | Монитор сети, health-check к Jira, события сна/пробуждения |
| `src-tauri/src/logger.rs` | Файловый логгер, ротация 7 дней, `%LOCALAPPDATA%\\JiraTime\\logs` |

## Что добавлено в этом пулл-реквесте

### Руст-сторона

```
src-tauri/src/sync_queue_integration_tests.rs  — интеграционные тесты (3 сценария)
src-tauri/src/sync_queue_helpers.rs            — count_by_status, enqueue_item_raw
src-tauri/src/logger_noop.rs                   — NoopLogger для тестов
.github/workflows/integration-tests.yml        — CI: windows-latest runner
```

### Фронтенд-сторона (Vue)

```
src/components/SyncStatusIndicator.vue   — индикатор сети/синхронизации в шапке
src/composables/usePowerEvents.ts        — обработчик sleep/resume
src/views/LogsView.vue                  — экран логов с фильтром и кнопкой "Открыть папку"
```

## Шаги по интеграции

### 1. Добавить модули в `main.rs`

```rust
// Добавить после остальных mod:
mod sync_queue_helpers;  // count_by_status, enqueue_item_raw
mod logger_noop;         // NoopLogger (только для тестов, не нужно в production)
```

Или поместить `pub use` в `sync_queue.rs`:

```rust
// в sync_queue.rs добавить:
pub use crate::sync_queue_helpers::{count_by_status, enqueue_item_raw};
```

### 2. Добавить `NoopLogger` в `logger.rs`

```rust
// в файл logger.rs добавить в конец:
pub struct NoopLogger;

impl LogSink for NoopLogger {
    fn debug(&self, _: &str, _: &str) {}
    fn info (&self, _: &str, _: &str) {}
    fn warn (&self, _: &str, _: &str) {}
    fn error(&self, _: &str, _: &str) {}
}
```

Или использовать `logger_noop.rs` (уже закоммичен).

### 3. Добавить `SyncStatusIndicator` в шапку

```vue
<!-- в App.vue или компоненте шапки -->
<script setup lang="ts">
import SyncStatusIndicator from '@/components/SyncStatusIndicator.vue'
import { usePowerEvents } from '@/composables/usePowerEvents'

// Инициализация обработчика sleep/resume
usePowerEvents()
</script>

<template>
  <header class="app-header">
    <!-- ваши остальные элементы шапки -->
    <SyncStatusIndicator />
  </header>
</template>
```

### 4. Добавить роут `LogsView` в роутер

```ts
// router/index.ts
import LogsView from '@/views/LogsView.vue'

{
  path: '/logs',
  name: 'logs',
  component: LogsView,
}
```

### 5. Добавить пункт "Логи" в боковую панель

```vue
<RouterLink to="/logs">📄 Логи</RouterLink>
```

## Запуск тестов локально

```bash
cd src-tauri
cargo test --lib --tests -- offline_to_sync --nocapture
```

## Структура CI

Файл `.github/workflows/integration-tests.yml` запускает тесты на `windows-latest`
при каждом push/PR в `main`.

## Описание тестов

| Тест | Сценарий |
|------|----------|
| `test_offline_20_entries_then_sync_all` | 20 offline записей → wake → все synced, порядок сохранён |
| `test_rate_limit_then_retry_success` | 429 + Retry-After:1 → пауза → вторая попытка synced |
| `test_permanent_error_goes_to_failed` | 400 Bad Request → статус failed, не crash |
