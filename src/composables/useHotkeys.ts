import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isModKey } from '../utils/platform';

/**
 * Глобальные горячие клавиши. На macOS вместо Ctrl работает и ⌘ (подписи — hotkeyLabel).
 *
 * Ctrl+N  — быстрое открытие мастера массового трекинга (route: bulk)
 * Ctrl+L  — переход на страницу «Мой worklog» (route: worklog)
 * Ctrl+,  — переход в настройки (route: settings)
 * Ctrl+B  — «Битрикс24» (route: bitrix)
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

  // Сравниваем e.code (физическая клавиша), а не e.key: в русской раскладке
  // Ctrl+N даёт e.key === 'т', и горячие клавиши не срабатывали.
  async function handler(e: KeyboardEvent) {
    // --- Ctrl+N: Мастер массового трекинга ---
    if (isModKey(e) && !e.shiftKey && !e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      await router.push({ name: 'bulk' });
      return;
    }

    // --- Ctrl+L: Таблица worklog ---
    if (isModKey(e) && !e.shiftKey && !e.altKey && e.code === 'KeyL') {
      e.preventDefault();
      await router.push({ name: 'worklog' });
      return;
    }

    // --- Ctrl+, : Настройки ---
    // Ctrl+K — «Календарь → Jira» (подсказка показана в боковом меню)
    if (isModKey(e) && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      await router.push({ name: 'calendar' });
      return;
    }

    // Ctrl+D — «Собрать день», Ctrl+J — «Дайджест»
    if (isModKey(e) && !e.shiftKey && !e.altKey && (e.code === 'KeyD' || e.code === 'KeyJ')) {
      e.preventDefault();
      await router.push({ name: e.code === 'KeyD' ? 'compose' : 'digest' });
      return;
    }

    // Ctrl+T — «Команда»
    if (isModKey(e) && !e.shiftKey && !e.altKey && e.code === 'KeyT') {
      e.preventDefault();
      await router.push({ name: 'team' });
      return;
    }

    // Ctrl+B — «Битрикс24» (если раздел включён: иначе маршрут покажет, как подключить)
    if (isModKey(e) && !e.shiftKey && !e.altKey && e.code === 'KeyB') {
      e.preventDefault();
      await router.push({ name: 'bitrix' });
      return;
    }

    if (isModKey(e) && !e.shiftKey && !e.altKey && e.code === 'Comma') {
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
    if (isModKey(e) && !e.shiftKey && !e.altKey && e.code === 'KeyM') {
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
