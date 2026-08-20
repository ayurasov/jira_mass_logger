/**
 * Автообновление через tauri-plugin-updater (Промпт 10).
 *
 * Сценарий:
 *   1. При запуске приложения через 5 секунд (даём время онбордингу отобразиться)
 *      проверяем наличие обновлений.
 *   2. Если есть апдейт — показываем баннер (tauri dialog + toast).
 *   3. Установка происходит в %LOCALAPPDATA% без UAC
 *      при installMode: quiet (NSIS currentUser).
 */
import { ref } from 'vue';
import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';

export interface UpdateInfo {
  version: string;
  body: string | null;
}

const updateAvailable = ref<UpdateInfo | null>(null);
const checking = ref(false);
const installProgress = ref<number | null>(null);

export function useUpdater() {
  /**
   * Проверяет наличие обновлений и предлагает установить.
   * Вызывается автоматически из main.ts серез 5 секунд после запуска.
   */
  async function checkForUpdates() {
    if (checking.value) return;
    checking.value = true;
    try {
      const update = await check();
      if (!update?.available) return;

      updateAvailable.value = {
        version: update.version,
        body: update.body ?? null,
      };

      const shouldInstall = await ask(
        `Доступна новая версия JiraTime ${update.version}.

${update.body ?? ''}

Установить сейчас?`,
        { title: 'Обновление JiraTime', okLabel: 'Установить', cancelLabel: 'Позже' },
      );

      if (!shouldInstall) return;

      installProgress.value = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Progress') {
          const data = event.data as { chunkLength?: number; contentLength?: number };
          const pct = data.chunkLength && data.contentLength
            ? Math.round((data.chunkLength / data.contentLength) * 100)
            : null;
          if (pct !== null) installProgress.value = pct;
        }
        if (event.event === 'Finished') {
          installProgress.value = 100;
        }
      });
    } catch (err) {
      // Тихая деградация: ошибка проверки не крашает приложение
      console.warn('[updater] check failed:', err);
    } finally {
      checking.value = false;
    }
  }

  return { updateAvailable, checking, installProgress, checkForUpdates };
}
