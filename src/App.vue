<script setup lang="ts">
import { onMounted } from 'vue';
import { useSettingsStore } from './store/settings';
import SyncStatusIndicator from './components/SyncStatusIndicator.vue';
import { usePowerEvents } from './composables/usePowerEvents';
import { useHotkeys } from './composables/useHotkeys';
import { useUpdater } from './composables/useUpdater';
import './styles/theme.css';

const settings = useSettingsStore();

onMounted(() => {
  settings.loadTheme();
});

// Пробуждение Windows / sleep-wake цикл
usePowerEvents();

// Глобальные горячие клавиши: Ctrl+N, Ctrl+L, Ctrl+M
useHotkeys();

// Проверка обновлений при запуске (через tauri-plugin-updater)
useUpdater();
</script>

<template>
  <div :class="['app', settings.theme]">
    <!-- Индикатор сети/синхронизации — фиксирован в правом верхнем углу поверх навигации -->
    <SyncStatusIndicator class="app-sync-indicator" />
    <router-view />
  </div>
</template>

<style scoped>
.app {
  position: relative;
}

.app-sync-indicator {
  position: fixed;
  top: 8px;
  right: 12px;
  z-index: 9999;
}
</style>
