import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Глобальные горячие клавиши в Windows-стиле.
 *
 * Ctrl+N  — быстрое открытие мастера массового трекинга (route: bulk)
 * Ctrl+L  — переход на страницу «Мой worklog» (route: worklog)
 * Ctrl+,  — переход в настройки (route: settings)
 * Ctrl+M  — свернуть в системный трей
 * F1      — экран логов (route: logs)
 * Enter   — сабмит inline-редактирование (обрабатывается каждым компонентом самостоятельно)
 * Esc     — отменяет редактирование / закрывает диалог
 *
 * ВАЖНО: имена маршрутов здесь должны точно совпадать с именами в router/index.ts —
 * ранее использовались несуществующие имена ('bulk-log', 'my-worklog'), из-за чего
 * router.push() не находил маршрут и молча ничего не делал.
 */
export function useHotkeys() {
  const router = useRouter();

  function isTypingInField(): boolean {
    const active = document.activeElement as HTMLElement | null;
    return !!active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      active.isContentEditable
    );
  }

  async function handler(e: KeyboardEvent) {
    // --- Ctrl+N: Мастер массового трекинга ---
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      await router.push({ name: 'bulk' });
      return;
    }

    // --- Ctrl+L: Таблица worklog ---
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      await router.push({ name: 'worklog' });
      return;
    }

    // --- Ctrl+, : Настройки ---
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === ',') {
      e.preventDefault();
      await router.push({ name: 'settings' });
      return;
    }

    // --- F1: Экран логов ---
    if (e.key === 'F1') {
      e.preventDefault();
      await router.push({ name: 'logs' });
      return;
    }

    // --- Ctrl+M: Свернуть в трей ---
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      try {
        const win = getCurrentWindow();
        await win.hide();
      } catch {
        // WebView2-сессия без Tauri-контекста (напр., dev-превью) — игнорируем
      }
      return;
    }

    // --- Esc: закрыть текущий открытый диалог (если нет фокуса в инпуте) ---
    if (e.key === 'Escape') {
      if (!isTypingInField()) {
        // Генерируем событие для компонентов диалогов/панелей
        document.dispatchEvent(new CustomEvent('jiratime:close-active-dialog'));
      }
      return;
    }
  }

  onMounted(() => window.addEventListener('keydown', handler));
  onUnmounted(() => window.removeEventListener('keydown', handler));
}
