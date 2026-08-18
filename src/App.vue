<script setup lang="ts">
import { onMounted } from 'vue';
import { useSettingsStore } from './store/settings';
import SyncStatusIndicator from './components/SyncStatusIndicator.vue';
import { usePowerEvents } from './composables/usePowerEvents';
import './styles/theme.css';

const settings = useSettingsStore();
onMounted(() => settings.loadTheme());

// Слушаем события пробуждения Windows и триггерим проверку очереди
// (возобновление после сна/гибернации, получение фокуса, tauri://focus)
usePowerEvents();
</script>

<template>
  <div :class="['app', settings.theme]">
    <!-- Индикатор сети/синхронизации — отображается в шапке приложения -->
    <SyncStatusIndicator class="app-sync-indicator" />
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
