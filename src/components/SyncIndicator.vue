<script setup lang="ts">
/**
 * Индикатор сети/синхронизации в шапке приложения.
 * Получает данные через invoke('get_sync_indicator') + подписку на событие 'sync-status-changed'.
 * По клику открывает попап с подробностями очереди.
 *
 * Статусы Windows Defender: все данные идут через единый SQLite-файл,
 * чтобы не триггерить эвристику множественных мелких файлов.
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Window as TauriWindow } from '@tauri-apps/api/window'

interface SyncIndicatorData {
  net_status: 'online' | 'offline' | 'syncing' | 'error'
  pending_count: number
  failed_count: number
  last_error: string | null
}

const data = ref<SyncIndicatorData>({
  net_status: 'offline',
  pending_count: 0,
  failed_count: 0,
  last_error: null,
})

const showPopup = ref(false)
let unlisten: UnlistenFn | null = null

const icon = computed(() => {
  switch (data.value.net_status) {
    case 'online':   return '\u2705'  // ✅
    case 'syncing':  return '\uD83D\uDD04'  // 🔄
    case 'offline':  return '\uD83D\uDFE5'  // 🟥
    case 'error':    return '\u26A0\uFE0F'  // ⚠️
    default:         return '\u25CF'
  }
})

const label = computed(() => {
  switch (data.value.net_status) {
    case 'online':   return 'Онлайн'
    case 'syncing':  return 'Синхронизация…'
    case 'offline':  return 'Оффлайн'
    case 'error':    return 'Ошибка синхронизации'
    default:         return ''
  }
})

async function refresh() {
  try {
    data.value = await invoke<SyncIndicatorData>('get_sync_indicator')
  } catch (e) {
    console.error('get_sync_indicator failed', e)
  }
}

// Передаём событие пробуждения Windows в бэкенд
async function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    await invoke('notify_system_resume').catch(() => {})
    await refresh()
  }
}

onMounted(async () => {
  await refresh()
  unlisten = await listen<SyncIndicatorData>('sync-status-changed', (event) => {
    data.value = event.payload
  })
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onUnmounted(() => {
  unlisten?.()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<template>
  <div class="sync-indicator" @click="showPopup = !showPopup">
    <span class="sync-icon" :title="label">{{ icon }}</span>
    <span class="sync-label">{{ label }}</span>
    <span v-if="data.pending_count > 0" class="sync-badge">{{ data.pending_count }}</span>

    <Teleport to="body">
      <div v-if="showPopup" class="sync-popup" @click.stop>
        <h4>Статус синхронизации</h4>
        <p>Сеть: <strong>{{ label }}</strong></p>
        <p>Очередь: <strong>{{ data.pending_count }}</strong> ожидают</p>
        <p v-if="data.failed_count > 0" class="sync-popup-error">
          Ошибок: <strong>{{ data.failed_count }}</strong>
        </p>
        <p v-if="data.last_error" class="sync-popup-error-text">{{ data.last_error }}</p>
        <button class="sync-popup-close" @click="showPopup = false">×</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sync-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 6px;
  user-select: none;
  transition: background 0.15s;
}
.sync-indicator:hover { background: var(--color-surface-offset, rgba(0,0,0,.06)); }
.sync-icon { font-size: 16px; line-height: 1; }
.sync-label { font-size: 12px; color: var(--color-text-muted, #666); }
.sync-badge {
  font-size: 10px;
  background: var(--color-primary, #01696f);
  color: #fff;
  border-radius: 99px;
  padding: 0 5px;
  min-width: 16px;
  text-align: center;
}
.sync-popup {
  position: fixed;
  top: 44px;
  right: 12px;
  z-index: 9999;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #ddd);
  border-radius: 8px;
  padding: 14px 16px 12px;
  min-width: 220px;
  box-shadow: 0 6px 24px rgba(0,0,0,.12);
}
.sync-popup h4 { margin: 0 0 8px; font-size: 13px; }
.sync-popup p  { margin: 4px 0; font-size: 12px; }
.sync-popup-error { color: var(--color-error, #a12c7b); }
.sync-popup-error-text { font-size: 11px; color: var(--color-text-muted); word-break: break-all; margin-top: 6px; }
.sync-popup-close {
  position: absolute; top: 8px; right: 10px;
  background: none; border: none; cursor: pointer;
  font-size: 16px; color: var(--color-text-muted);
}
</style>
