<script setup lang="ts">
/**
 * Экран логов — диагностика для пользователя.
 *
 * Функции:
 *  - Показывает последние N строк текущего лог-файла
 *  - Кнопка "Обновить" и автообновление каждые 5 секунд
 *  - Кнопка "Открыть папку логов" — открывает %LOCALAPPDATA%\JiraTime\logs в Проводнике
 *  - Фильтр по уровню (DEBUG / INFO / WARN / ERROR)
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'

const LOG_LINES = 300
const REFRESH_INTERVAL_MS = 5000

const lines      = ref<string[]>([])
const loading    = ref(false)
const logDirPath = ref('')
const filterLevel = ref<'ALL' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'>('ALL')
const autoScroll  = ref(true)
const logContainer = ref<HTMLPreElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const filteredLines = computed(() => {
  if (filterLevel.value === 'ALL') return lines.value
  return lines.value.filter(l => l.includes(`[${filterLevel.value}]`) || l.includes(`[${filterLevel.value.padEnd(5)}]`))
})

function levelClass(line: string): string {
  if (line.includes('[ERROR]')) return 'log-error'
  if (line.includes('[WARN ]') || line.includes('[WARN]'))  return 'log-warn'
  if (line.includes('[DEBUG]')) return 'log-debug'
  return 'log-info'
}

async function fetchLogs() {
  loading.value = true
  try {
    lines.value = await invoke<string[]>('read_log_tail', { lines: LOG_LINES })
    if (autoScroll.value) {
      await nextTick()
      if (logContainer.value) {
        logContainer.value.scrollTop = logContainer.value.scrollHeight
      }
    }
  } catch (e) {
    lines.value = [`Ошибка чтения логов: ${e}`]
  } finally {
    loading.value = false
  }
}

async function fetchLogDirPath() {
  try {
    logDirPath.value = await invoke<string>('get_log_dir_path')
  } catch {}
}

async function openLogDir() {
  try {
    await invoke('open_log_dir_in_explorer')
  } catch (e) {
    alert(`Не удалось открыть папку: ${e}`)
  }
}

async function nextTick() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

onMounted(async () => {
  await fetchLogDirPath()
  await fetchLogs()
  timer = setInterval(fetchLogs, REFRESH_INTERVAL_MS)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="logs-view">
    <!-- Заголовок -->
    <div class="logs-header">
      <div class="logs-title-row">
        <h2 class="logs-title">Логи приложения</h2>
        <span class="logs-path">{{ logDirPath }}</span>
      </div>

      <div class="logs-controls">
        <!-- Фильтр уровня -->
        <div class="logs-filter">
          <button
            v-for="lvl in ['ALL','DEBUG','INFO','WARN','ERROR']"
            :key="lvl"
            class="filter-btn"
            :class="{ active: filterLevel === lvl, [`filter-${lvl.toLowerCase()}`]: true }"
            @click="filterLevel = lvl as typeof filterLevel.value"
          >
            {{ lvl }}
          </button>
        </div>

        <label class="auto-scroll-toggle">
          <input type="checkbox" v-model="autoScroll" />
          Автоскролл
        </label>

        <button class="logs-action-btn" :disabled="loading" @click="fetchLogs">
          <span v-if="loading">↻ Загрузка...</span>
          <span v-else>↻ Обновить</span>
        </button>

        <button class="logs-action-btn" @click="openLogDir">
          📂 Открыть папку
        </button>
      </div>
    </div>

    <!-- Контент -->
    <pre
      ref="logContainer"
      class="logs-content"
      aria-label="Файл логов"
    >
      <template v-if="filteredLines.length === 0">
        <span class="logs-empty">Логи пусты — приложение только запустилось.</span>
      </template>
      <template v-else>
        <span
          v-for="(line, idx) in filteredLines"
          :key="idx"
          :class="['log-line', levelClass(line)]"
        >{{ line }}\n</span>
      </template>
    </pre>

    <!-- Строк статуса -->
    <div class="logs-footer">
      Показано {{ filteredLines.length }} строк (max {{ LOG_LINES }})
      &bull; Автообновление: каждые 5 секунд
    </div>
  </div>
</template>

<style scoped>
.logs-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0;
  background: var(--color-bg, #f7f6f2);
}

.logs-header {
  padding: 12px 16px 8px;
  border-bottom: 1px solid var(--color-border, #e2e8f0);
  background: var(--color-surface, #fafafa);
  flex-shrink: 0;
}

.logs-title-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
}
.logs-title {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
}
.logs-path {
  font-size: 11px;
  color: var(--color-text-muted, #64748b);
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logs-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.logs-filter {
  display: flex;
  gap: 4px;
}
.filter-btn {
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 4px;
  border: 1px solid var(--color-border, #e2e8f0);
  background: transparent;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.filter-btn.active { background: var(--color-primary, #01696f); color: #fff; border-color: transparent; }
.filter-debug { color: #94a3b8; }
.filter-debug.active { background: #94a3b8; color: #fff; }
.filter-info  { color: var(--color-text, #1e293b); }
.filter-warn  { color: #f59e0b; }
.filter-warn.active  { background: #f59e0b; color: #fff; }
.filter-error { color: #ef4444; }
.filter-error.active { background: #ef4444; color: #fff; }

.auto-scroll-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
  color: var(--color-text-muted, #64748b);
}

.logs-action-btn {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--color-border, #e2e8f0);
  background: var(--color-surface, #fff);
  cursor: pointer;
  transition: background 0.12s;
  white-space: nowrap;
}
.logs-action-btn:hover:not(:disabled) { background: var(--color-surface-offset, #f3f0ec); }
.logs-action-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Содержимое логов */
.logs-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
  padding: 10px 16px;
  margin: 0;
  font-family: 'Consolas', 'Cascadia Code', 'Fira Code', monospace;
  font-size: 11.5px;
  line-height: 1.55;
  background: var(--color-bg, #f7f6f2);
  color: var(--color-text, #1e293b);
  white-space: pre;
  min-height: 0;
}

/* Темная тема */
@media (prefers-color-scheme: dark) {
  .logs-content { background: #0d1117; color: #c9d1d9; }
}
[data-theme="dark"] .logs-content { background: #0d1117; color: #c9d1d9; }

.log-line   { display: block; }
.log-error  { color: #ef4444; }
.log-warn   { color: #f59e0b; }
.log-debug  { color: #94a3b8; }
.log-info   { color: inherit; }

.logs-empty {
  display: block;
  text-align: center;
  margin-top: 48px;
  color: var(--color-text-muted, #94a3b8);
}

.logs-footer {
  padding: 6px 16px;
  font-size: 11px;
  color: var(--color-text-muted, #64748b);
  border-top: 1px solid var(--color-border, #e2e8f0);
  background: var(--color-surface, #fafafa);
  flex-shrink: 0;
}
</style>
