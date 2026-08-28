/**
 * usePowerEvents — обработчик событий сна/пробуждения Windows.
 *
 * Используется ТОЛЬКО visibilitychange, потому что:
 *  - window.focus и tauri://focus срабатывают при каждом переходе между
 *    экранами внутри приложения, вызывая notify_system_resume → HTTP health-check
 *    к Jira → мигание консольного окна на Windows.
 *  - visibilitychange (hidden → visible) — единственный надёжный сигнал
 *    реального пробуждения системы из сна/гибернации и возврата из свёрнутого
 *    состояния; внутренняя навигация его не триггерит.
 *
 * Дебаунс 5 с защищает от множественных срабатываний при медленном пробуждении.
 */
import { onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'

export function usePowerEvents(onResume?: () => void) {
  let lastResumeTs = 0
  const DEBOUNCE_MS = 5000

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

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  return { handleResume }
}
