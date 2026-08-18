<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingsStore } from './store/settings';
import SyncStatusIndicator from './components/SyncStatusIndicator.vue';
import { usePowerEvents } from './composables/usePowerEvents';
import { useHotkeys } from './composables/useHotkeys';
import './styles/theme.css';

const settings = useSettingsStore();
const router = useRouter();

onMounted(() => settings.loadTheme());

// Слушаем события пробуждения Windows и триггерим проверку очереди
// (возобновление после сна/гибернации, получение фокуса, tauri://focus)
usePowerEvents();

// Глобальные горячие клавиши (Промпт 10)
// Ctrl+N — открыть мастер (Bulk Log)
// Ctrl+L — перейти в таблицу worklog
// Ctrl+M — свернуть в трей
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
  ]);
}
</script>

<template>
  <div :class="['app', settings.theme]">
    <!-- Индикатор сети/синхронизации — виден на всех экранах кроме онбординга -->
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
