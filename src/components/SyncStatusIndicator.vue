<script setup lang="ts">
/**
 * Индикатор сети/синхронизации в шапке приложения.
 *
 * Состояния:
 *   online    — зелёная точка (Jira доступна)
 *   offline   — серая точка (нет сети)
 *   syncing   — вращающийся индикатор
 *   error     — красный знак предупреждения
 *
 * По клику — выпадающая панель с деталями и кнопкой ручной синхронизации.
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import ActionIcon, { type ActionIconName } from './ActionIcon.vue'

interface SyncIndicator {
  netStatus:    'online' | 'offline' | 'syncing' | 'error'
  pendingCount: number
  failedCount:  number
  lastError:    string | null
}

const indicator = ref<SyncIndicator>({
  netStatus:    'offline',
  pendingCount: 0,
  failedCount:  0,
  lastError:    null,
})

const popupOpen = ref(false)
const syncing   = ref(false)

let unlisten: UnlistenFn | null = null

const statusIcon = computed<ActionIconName>(() => {
  switch (indicator.value.netStatus) {
    case 'online':  return 'dot'
    case 'offline': return 'dot'
    case 'syncing': return 'refresh'
    case 'error':   return 'warning'
    default:        return 'dot'
  }
})

const statusClass = computed(() => ({
  'si-online':  indicator.value.netStatus === 'online',
  'si-offline': indicator.value.netStatus === 'offline',
  'si-syncing': indicator.value.netStatus === 'syncing',
  'si-error':   indicator.value.netStatus === 'error',
}))

const tooltip = computed(() => {
  const { netStatus, pendingCount, failedCount } = indicator.value
  const lines: string[] = []
  if (netStatus === 'online')  lines.push('Сеть: Jira доступна')
  if (netStatus === 'offline') lines.push('Сеть: оффлайн')
  if (netStatus === 'syncing') lines.push('Синхронизация...')
  if (netStatus === 'error')   lines.push('Ошибка синхронизации')
  if (pendingCount > 0)        lines.push(`Очередь: ${pendingCount} записей`)
  if (failedCount > 0)         lines.push(`Ошибок: ${failedCount}`)
  return lines.join('\n')
})

async function fetchStatus() {
  try {
    indicator.value = await invoke<SyncIndicator>('get_sync_indicator')
  } catch (e) {
    // безопасно игнорируем
  }
}

async function triggerSyncNow() {
  syncing.value = true
  try {
    await invoke('trigger_sync_now')
    await new Promise(r => setTimeout(r, 800))
    await fetchStatus()
  } finally {
    syncing.value = false
  }
}

onMounted(async () => {
  await fetchStatus()
  // Слушаем события sync-status-changed от бэкенда
  unlisten = await listen<SyncIndicator>('sync-status-changed', (event) => {
    indicator.value = event.payload
  })

  // Слушаем возможное пробуждение Windows через видимость окна
  window.addEventListener('focus', handleWindowFocus)
})

onUnmounted(() => {
  unlisten?.()
  window.removeEventListener('focus', handleWindowFocus)
})

async function handleWindowFocus() {
  // При получении фокуса сообщаем бэкенду o возможном пробуждении (выход из сна/гибернации)
  try { await invoke('notify_system_resume') } catch {}
  await fetchStatus()
}
</script>

<template>
  <div class="sync-status-indicator" :class="statusClass">
    <!-- Кнопка с иконкой -->
    <button
      class="si-btn"
      :title="tooltip"
      :aria-label="tooltip"
      @click="popupOpen = !popupOpen"
    >
      <span class="si-icon" :class="{ 'si-spin': indicator.netStatus === 'syncing' }">
        <ActionIcon :name="statusIcon" :size="15" />
      </span>
      <span v-if="indicator.pendingCount > 0" class="si-badge">
        {{ indicator.pendingCount }}
      </span>
    </button>

    <!-- Popup с деталями -->
    <Transition name="si-popup">
      <div v-if="popupOpen" class="si-popup" role="dialog" aria-label="Статус синхронизации">
        <div class="si-popup-header">
          <span class="si-popup-title">Синхронизация</span>
          <button class="si-close" @click="popupOpen = false" aria-label="Закрыть"><ActionIcon name="close" :size="14" /></button>
        </div>

        <div class="si-popup-body">
          <div class="si-row">
            <span class="si-label">Сеть:</span>
            <span :class="statusClass">
              {{ indicator.netStatus === 'online'  ? 'Онлайн'      :
                 indicator.netStatus === 'offline' ? 'Оффлайн'     :
                 indicator.netStatus === 'syncing' ? 'Синхронизация' :
                 'Ошибка' }}
            </span>
          </div>
          <div class="si-row">
            <span class="si-label">Очередь:</span>
            <span>{{ indicator.pendingCount }} записей</span>
          </div>
          <div v-if="indicator.failedCount > 0" class="si-row si-row--error">
            <span class="si-label">Ошибок:</span>
            <span>{{ indicator.failedCount }}</span>
          </div>
          <div v-if="indicator.lastError" class="si-error-text">
            {{ indicator.lastError }}
          </div>
        </div>

        <div class="si-popup-footer">
          <button
            class="si-sync-btn"
            :disabled="syncing || indicator.netStatus === 'offline'"
            @click="triggerSyncNow"
          >
            <span v-if="syncing" class="si-sync-btn__inner"><ActionIcon name="refresh" :size="13" /> Синхронизация...</span>
            <span v-else class="si-sync-btn__inner"><ActionIcon name="refresh" :size="13" /> Синхронизировать сейчас</span>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.sync-status-indicator {
  position: relative;
  display: inline-flex;
  align-items: center;
}

/* Кнопка-индикатор */
.si-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 999px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  transition: background 0.15s;
}
.si-icon { display: inline-flex; align-items: center; }
.si-btn:hover { background: rgba(0,0,0,0.07); }

/* Цвета статусов */
.si-online  .si-icon { color: #22c55e; }
.si-offline .si-icon { color: #94a3b8; }
.si-syncing .si-icon { color: #3b82f6; }
.si-error   .si-icon { color: #ef4444; }

/* Адаптация под дарк тему */
@media (prefers-color-scheme: dark) {
  .si-btn:hover { background: rgba(255,255,255,0.1); }
}
[data-theme="dark"] .si-btn:hover { background: rgba(255,255,255,0.1); }

/* Вращение при syncing */
@keyframes si-spin {
  from { display: inline-block; transform: rotate(0deg); }
  to   { display: inline-block; transform: rotate(360deg); }
}
.si-spin { animation: si-spin 1s linear infinite; display: inline-block; }

/* Бадж количества */
.si-badge {
  font-size: 10px;
  font-weight: 700;
  background: #ef4444;
  color: #fff;
  border-radius: 999px;
  padding: 1px 5px;
  line-height: 1.4;
  min-width: 16px;
  text-align: center;
}

/* Popup */
.si-popup {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 260px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  z-index: 9999;
  overflow: hidden;
}

.si-popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--color-divider, #e2e8f0);
}
.si-popup-title { font-weight: 600; font-size: 13px; }
.si-close {
  border: none; background: none; cursor: pointer;
  font-size: 18px; line-height: 1; color: var(--color-text-muted, #64748b);
  padding: 0 2px;
  display: inline-flex; align-items: center;
}

.si-popup-body { padding: 10px 14px; }
.si-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  padding: 3px 0;
  color: var(--color-text, #1e293b);
}
.si-row--error { color: #ef4444; }
.si-label { color: var(--color-text-muted, #64748b); }
.si-error-text {
  font-size: 11px;
  color: #ef4444;
  margin-top: 6px;
  word-break: break-all;
  max-height: 60px;
  overflow-y: auto;
}

.si-popup-footer {
  padding: 8px 14px 12px;
  border-top: 1px solid var(--color-divider, #e2e8f0);
}
.si-sync-btn {
  width: 100%;
  padding: 7px 12px;
  border-radius: 6px;
  border: none;
  background: var(--color-primary, #01696f);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
}
.si-sync-btn__inner { display: inline-flex; align-items: center; gap: 5px; }
.si-sync-btn:hover:not(:disabled) { background: var(--color-primary-hover, #0c4e54); }
.si-sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Popup transition */
.si-popup-enter-active,
.si-popup-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.si-popup-enter-from,
.si-popup-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
