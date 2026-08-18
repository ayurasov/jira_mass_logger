<template>
  <div class="logs-view">
    <div class="logs-toolbar">
      <h2>Диагностика / Логи</h2>

      <div class="toolbar-right">
        <!-- Фильтр уровня -->
        <select v-model="levelFilter" class="level-select">
          <option value="">ALL</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>

        <!-- Автообновление -->
        <label class="auto-refresh-toggle">
          <input type="checkbox" v-model="autoRefresh" />
          <span>Авто</span>
        </label>

        <button class="btn-ghost" @click="loadLogs" :disabled="loading">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"
            :class="{ spin: loading }">
            <path d="M17 10a7 7 0 1 1-2.05-4.95" stroke-linecap="round"/>
            <polyline points="17 3 17 10 10 10" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Обновить
        </button>

        <button class="btn-ghost" @click="copyAll" :title="'Копировать всё'">
          📋 Копировать
        </button>

        <button class="btn-primary" @click="openFolder">
          📂 Открыть папку
        </button>
      </div>
    </div>

    <div class="log-path" v-if="logPath">Папка: <code>{{ logPath }}</code></div>

    <div class="log-terminal" ref="terminalEl">
      <div v-if="filtered.length === 0" class="empty-state">
        <span>Логи пусты</span>
      </div>
      <div
        v-for="(line, i) in filtered"
        :key="i"
        class="log-line"
        :class="lineClass(line)"
      >
        <span class="log-level-badge">{{ extractLevel(line) }}</span>
        <span class="log-content">{{ stripLevel(line) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { invoke } from '@tauri-apps/api/core'

const lines = ref<string[]>([])
const levelFilter = ref('')
const autoRefresh = ref(false)
const loading = ref(false)
const logPath = ref('')
const terminalEl = ref<HTMLElement | null>(null)

const filtered = computed(() => {
  if (!levelFilter.value) return lines.value
  return lines.value.filter(l => l.includes(`[${levelFilter.value}]`))
})

function extractLevel(line: string): string {
  const m = line.match(/\[(DEBUG|INFO|WARN|ERROR)\s*\]/)
  return m ? m[1] : ''
}
function stripLevel(line: string): string {
  return line.replace(/^\S+\s+\[\S+\]\s+/, '')
}
function lineClass(line: string): string {
  const lvl = extractLevel(line)
  return { DEBUG: 'lvl-debug', INFO: 'lvl-info', WARN: 'lvl-warn', ERROR: 'lvl-error' }[lvl] ?? ''
}

async function loadLogs() {
  loading.value = true
  try {
    lines.value = await invoke<string[]>('read_log_tail', { lines: 200 })
    await nextTick()
    if (terminalEl.value) {
      terminalEl.value.scrollTop = terminalEl.value.scrollHeight
    }
  } catch (e) {
    console.error('read_log_tail error', e)
  } finally {
    loading.value = false
  }
}

async function openFolder() {
  try {
    await invoke('open_log_dir_in_explorer')
  } catch (e) {
    console.error('open_log_dir_in_explorer error', e)
  }
}

async function copyAll() {
  try {
    await navigator.clipboard.writeText(lines.value.join('\n'))
  } catch {
    // fallback: create textarea and copy
    const ta = document.createElement('textarea')
    ta.value = lines.value.join('\n')
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

let timer: ReturnType<typeof setInterval> | null = null
watch(autoRefresh, (val) => {
  if (val) {
    timer = setInterval(loadLogs, 10_000)
  } else {
    if (timer) { clearInterval(timer); timer = null }
  }
})

onMounted(async () => {
  await loadLogs()
  try {
    logPath.value = await invoke<string>('get_log_dir_path')
  } catch {}
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.logs-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: var(--space-4, 1rem);
  gap: var(--space-3, 0.75rem);
}
.logs-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2, 0.5rem);
}
.logs-toolbar h2 {
  font-size: var(--text-lg, 1.25rem);
  font-weight: 600;
  margin: 0;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2, 0.5rem);
  flex-wrap: wrap;
}
.level-select {
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--color-border, #d4d1ca);
  background: var(--color-surface, #f9f8f5);
  color: var(--color-text, #28251d);
  font-size: 0.875rem;
}
.auto-refresh-toggle {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.875rem;
  cursor: pointer;
  user-select: none;
}
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--color-border, #d4d1ca);
  background: transparent;
  color: var(--color-text, #28251d);
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-ghost:hover { background: var(--color-surface-offset, #f3f0ec); }
.btn-ghost:disabled { opacity: 0.5; cursor: default; }
.btn-primary {
  padding: 0.25rem 0.75rem;
  border-radius: 6px;
  border: none;
  background: var(--color-primary, #01696f);
  color: #fff;
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-primary:hover { background: var(--color-primary-hover, #0c4e54); }

.log-path {
  font-size: 0.8rem;
  color: var(--color-text-muted, #7a7974);
}
.log-path code {
  user-select: all;
  word-break: break-all;
}

.log-terminal {
  flex: 1;
  overflow-y: auto;
  background: var(--color-bg, #171614);
  color: #c9d1d9;
  border-radius: 8px;
  padding: var(--space-3, 0.75rem);
  font-family: 'Consolas', 'Cascadia Code', 'Fira Mono', monospace;
  font-size: 0.8125rem;
  line-height: 1.55;
  border: 1px solid var(--color-border, #393836);
}

/* Цвета в светлой теме */
[data-theme="light"] .log-terminal,
:root:not([data-theme="dark"]) .log-terminal {
  background: #1e1e1e;
  color: #d4d4d4;
}

.log-line {
  display: flex;
  gap: 0.5rem;
  padding: 1px 0;
}
.log-level-badge {
  flex-shrink: 0;
  font-weight: 700;
  width: 4.5rem;
  opacity: 0.9;
}
.log-content { word-break: break-all; }

.lvl-debug .log-level-badge { color: #8b8b8b; }
.lvl-info  .log-level-badge { color: #56d1e0; }
.lvl-warn  .log-level-badge { color: #f4c542; }
.lvl-error .log-level-badge { color: #f14c4c; }
.lvl-error .log-content     { color: #f97171; }

.empty-state {
  color: #666;
  text-align: center;
  padding: 3rem 0;
}

@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 0.7s linear infinite; }
</style>
