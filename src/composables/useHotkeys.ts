/**
 * Глобальные горячие клавиши в Windows-стиле.
 *
 * Ctrl+N  — открыть мастер массового трекинга
 * Ctrl+L  — перейти в таблицу worklog
 * Ctrl+M  — свернуть в трей
 * Ctrl+,  — открыть настройки
 * F1      — открыть экран логов
 *
 * Enter и Escape обрабатываются локально в компонентах редактирования
 * (см. MyWorklog.vue / BulkLogWizard.vue)
 */
import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function useHotkeys() {
  const router = useRouter();

  async function handleKeydown(e: KeyboardEvent) {
    // Не перехватываем изолированные поля ввода
    const tag = (e.target as HTMLElement)?.tagName ?? '';
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (e.target as HTMLElement)?.isContentEditable;

    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          await router.push('/bulk-log');
          break;
        case 'l':
          e.preventDefault();
          await router.push('/my-worklog');
          break;
        case 'm':
          e.preventDefault();
          try {
            const win = getCurrentWindow();
            await win.minimize();
          } catch {}
          break;
        case ',':
          e.preventDefault();
          await router.push('/settings');
          break;
      }
    }

    if (e.key === 'F1') {
      e.preventDefault();
      await router.push('/logs');
    }
  }

  onMounted(() => window.addEventListener('keydown', handleKeydown));
  onUnmounted(() => window.removeEventListener('keydown', handleKeydown));
}
