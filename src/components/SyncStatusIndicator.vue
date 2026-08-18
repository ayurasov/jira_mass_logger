<template>
  <div class="sync-indicator" @click="togglePopover" :title="statusLabel">
    <!-- Иконка статуса -->
    <span class="sync-icon" :class="iconClass" aria-label="Статус синхронизации">
      <svg v-if="status === 'online'" viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
        <circle cx="10" cy="10" r="4" />
        <path d="M3.5 14.5a9 9 0 0 1 13 0M6 11a6 6 0 0 1 8 0M1 17.5a13 13 0 0 1 18 0" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <svg v-else-if="status === 'offline'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
        <line x1="2" y1="2" x2="18" y2="18" />
        <path d="M6 11a6 6 0 0 1 8 0M3.5 14.5a9 9 0 0 1 2-1.5M1 17.5a13 13 0 0 1 5-3"/>
      </svg>
      <svg v-else-if="status === 'syncing'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18" class="spin">
        <path d="M17 10a7 7 0 1 1-2.05-4.95" stroke-linecap="round"/>
        <polyline points="17 3 17 10 10 10" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <svg v-else viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
        <path d="M10 2a8 8 0 1 0 0 16A8 8 0 0 0 10 2zm0 5v4m0 3h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </span>

    <!-- Бейдж ошибок -->
    <span v-if="indicator.failed_count > 0" class="badge-error">{{ indicator.failed_count }}</span>
    <span v-else-if="indicator.pending_count > 0" class="badge-pending">{{ indicator.pending_count }}</span>
  </div>

  <!-- Поповер деталей -->
  <Teleport to="body">
    <div v-if="popoverOpen" class="sync-popover" @click.stop>
      <div class="popover-header">
        <strong>Синхронизация</strong>
        <button class="close-btn" @click="popoverOpen = false" aria-label="Закрыть">×</button>
      </div>
      <dl class="popover-body">
        <dt>Статус</dt>
        <dd :class="statusClass">{{ statusLabel }}</dd>
        <dt>Ожидают отправки</dt>
        <dd>{{ indicator.pending_count }}</dd>
        <dt>Ошибок</dt>
        <dd>{{ indicator.failed_count }}</dd>
        <template v-if="indicator.last_error">
          <dt>Последняя ошибка</dt>
          <dd class="error-text">{{ indicator.last_error }}</dd>
        </template>
      </dl>
    </div>
    <div v-if="popoverOpen" class="sync-popover-backdrop" @click="popoverOpen = false" />
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

interface SyncIndicator {
  net_status: 'online' | 'offline' | 'syncing' | 'error'
  pending_count: number
  failed_count: number
  last_error: string | null
}

const indicator = ref<SyncIndicator>({
  net_status: 'offline',
  pending_count: 0,
  failed_count: 0,
  last_error: null,
})
const popoverOpen = ref(false)

const status = computed(() => indicator.value.net_status)
const statusLabel = computed(() => ({
  online:  'Онлайн',
  offline: 'Оффлайн',
  syncing: 'Синхронизация…',
  error:   'Ошибка синхронизации',
}[status.value] ?? status.value))
const statusClass = computed(() => ({
  online: 'ok', offline: 'warn', syncing: 'info', error: 'err',
}[status.value]))
const iconClass = computed(() => `icon-${status.value}`)

function togglePopover() { popoverOpen.value = !popoverOpen.value }

async function refresh() {
  try {
    indicator.value = await invoke<SyncIndicator>('get_sync_indicator')
  } catch {}
}

let unlisten: UnlistenFn | null = null
let timer: ReturnType<typeof setInterval>

onMounted(async () => {
  await refresh()
  timer = setInterval(refresh, 5_000)
  unlisten = await listen<SyncIndicator>('sync-status-changed', (e) => {
    indicator.value = e.payload
  })
  // Сообщаем backend о возможном пробуждении при получении фокуса
  window.addEventListener('focus', onWindowFocus)
})
onUnmounted(() => {
  clearInterval(timer)
  unlisten?.()
  window.removeEventListener('focus', onWindowFocus)
})

async function onWindowFocus() {
  try { await invoke('notify_system_resume') } catch {}
  await refresh()
}
</script>

<style scoped>
.sync-indicator {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  transition: background 0.15s;
}
.sync-indicator:hover {
  background: var(--color-surface-offset, rgba(0,0,0,.06));
}
.icon-online  { color: var(--color-success, #437a22); }
.icon-offline { color: var(--color-text-muted, #7a7974); }
.icon-syncing { color: var(--color-primary, #01696f); }
.icon-error   { color: var(--color-error, #a12c7b); }

@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 1s linear infinite; }

.badge-error, .badge-pending {
  position: absolute;
  top: 0; right: 0;
  min-width: 16px;
  height: 16px;
  border-radius: 9999px;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  padding: 0 4px;
  font-weight: 600;
}
.badge-error   { background: var(--color-error, #a12c7b); color: #fff; }
.badge-pending { background: var(--color-gold, #d19900); color: #fff; }

/* Поповер */
.sync-popover-backdrop {
  position: fixed; inset: 0; z-index: 999;
}
.sync-popover {
  position: fixed;
  top: 3rem; right: 1rem;
  z-index: 1000;
  background: var(--color-surface, #f9f8f5);
  border: 1px solid var(--color-border, #d4d1ca);
  border-radius: 10px;
  box-shadow: var(--shadow-lg, 0 12px 32px rgba(0,0,0,.12));
  padding: 1rem;
  min-width: 240px;
  max-width: 360px;
}
.popover-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: .75rem;
}
.close-btn {
  background: none; border: none; cursor: pointer;
  font-size: 1.2rem; color: var(--color-text-muted);
  line-height: 1; padding: 0;
}
.popover-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: .35rem .5rem;
  font-size: .875rem;
}
.popover-body dt { color: var(--color-text-muted); }
.popover-body dd { font-weight: 500; }
.ok   { color: var(--color-success); }
.warn { color: var(--color-warning, #964219); }
.info { color: var(--color-primary); }
.err  { color: var(--color-error); }
.error-text {
  grid-column: 1 / -1;
  font-size: .8rem;
  word-break: break-word;
  color: var(--color-error);
}
</style>
