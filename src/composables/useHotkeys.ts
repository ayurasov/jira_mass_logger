/**
 * Глобальные горячие клавиши в Windows-стиле (Промпт 10).
 *
 * Поддерживаемые шорткаты из корня приложения (App.vue):
 *   Ctrl+N  — Мастер массового трекинга (/bulk-log)
 *   Ctrl+L  — Таблица worklog (/my-worklog)
 *   Ctrl+M  — Свернуть в трей
 *   Ctrl+,  — Настройки (/settings)
 *   F1      — Логи (/logs)
 *
 * Enter/Escape реализованы локально в компонентах редактирования.
 *
 * API: передайте массив HotkeyBinding[]. Композабл сам подпишется/отпишется.
 */
import { onMounted, onUnmounted } from 'vue';

export interface HotkeyBinding {
  /** Клавиша (строчная, lower-case: 'n', 'l', ',', 'F1') */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Описание для дебага */
  description?: string;
  handler: () => void | Promise<void>;
}

/**
 * Регистрирует глобальные шорткаты через массив описаний.
 * Автоматически отписывается при unmount компонента.
 * Не перехватывает события внутри полей ввода (INPUT, TEXTAREA, SELECT, contenteditable).
 */
export function useHotkeys(bindings: HotkeyBinding[]) {
  function handleKeydown(e: KeyboardEvent) {
    // Не перехватываем если фокус на поле ввода
    const tag = (e.target as HTMLElement)?.tagName ?? '';
    const isInputLike =
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) ||
      (e.target as HTMLElement)?.isContentEditable;

    for (const binding of bindings) {
      const keyMatch = e.key.toLowerCase() === binding.key.toLowerCase() ||
                       e.key === binding.key; // F1 и т.п. сохраняют регистр
      const ctrlMatch = !!binding.ctrl === e.ctrlKey;
      const shiftMatch = !!binding.shift === e.shiftKey;
      const altMatch = !!binding.alt === e.altKey;

      if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
        // Пропускаем Enter/Escape в полях ввода — они обрабатываются локально
        if (isInputLike && !binding.ctrl && !binding.alt) continue;
        e.preventDefault();
        void binding.handler();
      }
    }
  }

  onMounted(() => window.addEventListener('keydown', handleKeydown));
  onUnmounted(() => window.removeEventListener('keydown', handleKeydown));
}
