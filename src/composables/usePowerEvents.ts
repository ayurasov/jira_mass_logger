/**
 * usePowerEvents — обработчик событий сна/пробуждения Windows.
 *
 * Механизм:
 *  1. document.addEventListener('visibilitychange') — срабатывает после пробуждения
 *  2. window.addEventListener('focus')             — дополнительный триггер
 *  3. Tauri event 'tauri://focus'                  — нативный сигнал окна
 *
 * При любом событии вызывается notify_system_resume (бэкенд) +
 * рефреш индикатора синхронизации.
 */
import { onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export function usePowerEvents(onResume?: () => void) {
  let unlistenFocus: UnlistenFn | null = null
  let lastResumeTs = 0
  const DEBOUNCE_MS = 2000  // дебаунс: игнорируем срабатывания чаще каждых 2 секунд

  async function handleResume() {
    const now = Date.now()
    if (now - lastResumeTs < DEBOUNCE_MS) return
    lastResumeTs = now
    try {
      await invoke('notify_system_resume')
    } catch {}
    onResume?.()
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') handleResume()
  }

  function onWindowFocus() { handleResume() }

  onMounted(async () => {
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onWindowFocus)

    // Tauri-нативное событие получения фокуса окном
    try {
      unlistenFocus = await listen('tauri://focus', () => handleResume())
    } catch {}
  })

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('focus', onWindowFocus)
    unlistenFocus?.()
  })

  return { handleResume }
}
