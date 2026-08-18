import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Глобальные горячие клавиши в Windows-стиле.
 *
 * Ctrl+N  — быстрое открытие мастера массового трекинга
 * Ctrl+L  — переход на страницу «Мой worklog»
 * Ctrl+M  — свернуть в системный трей
 * Enter   — сабмит inline-редактирование (обрабатывается каждым компонентом самостоятельно)
 * Esc     — отменяет редактирование / закрывает диалог
 */
export function useHotkeys() {
  const router = useRouter();

  async function handler(e: KeyboardEvent) {
    // --- Ctrl+N: Мастер массового трекинга ---
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      await router.push({ name: 'bulk-log' });
      return;
    }

    // --- Ctrl+L: Таблица worklog ---
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      await router.push({ name: 'my-worklog' });
      return;
    }

    // --- Ctrl+M: Свернуть в трей ---
    if (e.ctrlKey && e.key === 'm') {
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
      const active = document.activeElement as HTMLElement | null;
      const isEditing =
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable);
      if (!isEditing) {
        // Генерируем событие для компонентов диалогов/панелей
        document.dispatchEvent(new CustomEvent('jiratime:close-active-dialog'));
      }
      return;
    }
  }

  onMounted(() => window.addEventListener('keydown', handler));
  onUnmounted(() => window.removeEventListener('keydown', handler));
}
