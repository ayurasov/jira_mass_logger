<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingsStore } from './store/settings';
import SyncStatusIndicator from './components/SyncStatusIndicator.vue';
import { usePowerEvents } from './composables/usePowerEvents';
import { useHotkeys } from './composables/useHotkeys';
import { useUpdater } from './composables/useUpdater';
import './styles/theme.css';

const settings = useSettingsStore();
const router = useRouter();
const { checkForUpdates } = useUpdater();

onMounted(() => {
  settings.loadTheme();

  // Проверка обновлений — через 5 секунд после запуска,
  // только если онбординг завершён (не мешаем первому запуску)
  if (settings.onboardingCompleted) {
    setTimeout(() => checkForUpdates(), 5000);
  }
});

// Слушаем события пробуждения Windows и триггерим проверку очереди
usePowerEvents();

// Глобальные горячие клавиши (Промпт 10)
if (settings.onboardingCompleted) {
  useHotkeys([
    {
      key: 'n',
      ctrl: true,
      description: 'Открыть мастер массового трекинга',
      handler: () => router.push({ name: 'bulk-log' }),
    },
    {
      key: 'l',
      ctrl: true,
      description: 'Перейти в таблицу worklog',
      handler: () => router.push({ name: 'my-worklog' }),
    },
    {
      key: 'm',
      ctrl: true,
      description: 'Свернуть в трей',
      handler: async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().hide();
      },
    },
    {
      key: ',',
      ctrl: true,
      description: 'Настройки',
      handler: () => router.push({ name: 'settings' }),
    },
    {
      key: 'F1',
      description: 'Диагностика / логи',
      handler: () => router.push({ name: 'logs' }),
    },
  ]);
}
</script>

<template>
  <div :class="['app', settings.theme]">
    <!-- Индикатор сети/синхронизации — скрыт во время онбординга -->
    <SyncStatusIndicator
      v-if="settings.onboardingCompleted"
      class="app-sync-indicator"
    />
    <router-view />
  </div>
</template>

<style scoped>
.app {
  position: relative;
}

/* Индикатор фиксируется в правом верхнем углу поверх навигации */
.app-sync-indicator {
  position: fixed;
  top: 8px;
  right: 12px;
  z-index: 9999;
}
</style>
