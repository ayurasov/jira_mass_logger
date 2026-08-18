<script setup lang="ts">
/**
 * Экран диагностики. Показывает последние N строк текущего лог-файла
 * и кнопку "Открыть папку логов в Проводнике".
 * Строки подсвечиваются: ERROR → красный, WARN → оранжевый, INFO → обычный.
 */
import { ref, onMounted, nextTick } from 'vue'
import { invoke } from '@tauri-apps/api/core'

const lines = ref<string[]>([])
const logDir = ref('')
const loading = ref(false)
const linesCount = ref(200)
const logsEl = ref<HTMLPreElement | null>(null)

async function load() {
  loading.value = true
  try {
    lines.value = await invoke<string[]>('read_log_tail', { lines: linesCount.value })
    logDir.value = await invoke<string>('get_log_dir_path')
    await nextTick()
    logsEl.value?.scrollTo({ top: logsEl.value.scrollHeight })
  } catch (e) {
    lines.value = [`Ошибка загрузки логов: ${e}`]
  } finally {
    loading.value = false
  }
}

async function openFolder() {
  await invoke('open_log_dir_in_explorer').catch(console.error)
}

function lineClass(line: string) {
  if (line.includes('[ERROR]')) return 'log-error'
  if (line.includes('[WARN ]')) return 'log-warn'
  if (line.includes('[DEBUG]')) return 'log-debug'
  return ''
}

onMounted(load)
</script>

<template>
  <div class="logs-view">
    <div class="logs-toolbar">
      <h2>Диагностика / Логи</h2>
      <div class="logs-toolbar-actions">
        <label>
          Последние
          <select v-model="linesCount" @change="load">
            <option :value="100">100 строк</option>
            <option :value="200">200 строк</option>
            <option :value="500">500 строк</option>
            <option :value="1000">1000 строк</option>
          </select>
        </label>
        <button class="btn-secondary" :disabled="loading" @click="load">
          {{ loading ? 'Загрузка…' : '↓ Обновить' }}
        </button>
        <button class="btn-secondary" @click="openFolder">
          📂 Открыть папку логов
        </button>
      </div>
    </div>

    <p v-if="logDir" class="logs-dir">
      <span class="text-muted">Путь: </span>{{ logDir }}
    </p>

    <pre
      ref="logsEl"
      class="logs-output"
    >
      <span
        v-for="(line, i) in lines"
        :key="i"
        :class="['log-line', lineClass(line)]"
      >{{ line }}&#10;</span>
      <span v-if="lines.length === 0" class="text-muted">Лог-файл пуст</span>
    </pre>
  </div>
</template>

<style scoped>
.logs-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  gap: 10px;
}
.logs-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.logs-toolbar h2 { margin: 0; font-size: 16px; }
.logs-toolbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.logs-toolbar-actions label { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.logs-dir { font-size: 11px; color: var(--color-text-muted); margin: 0; word-break: break-all; }

.logs-output {
  flex: 1;
  overflow-y: auto;
  background: var(--color-bg, #0d0d0d);
  color: var(--color-text, #ccc);
  font-family: 'Consolas', 'Cascadia Code', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  border-radius: 6px;
  padding: 10px 12px;
  white-space: pre-wrap;
  word-break: break-all;
  border: 1px solid var(--color-border, #333);
}

.log-line { display: block; }
.log-error { color: var(--color-error, #f87171); }
.log-warn  { color: var(--color-orange, #fb923c); }
.log-debug { color: var(--color-text-muted, #888); }
.text-muted { color: var(--color-text-muted, #888); }

.btn-secondary {
  padding: 5px 12px;
  font-size: 13px;
  border: 1px solid var(--color-border, #ccc);
  border-radius: 6px;
  background: none;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-secondary:hover { background: var(--color-surface-offset, rgba(0,0,0,.06)); }
.btn-secondary:disabled { opacity: 0.5; cursor: default; }
</style>
