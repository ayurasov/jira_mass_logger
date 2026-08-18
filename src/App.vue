<script setup lang="ts">
import { onMounted } from 'vue';
import { useSettingsStore } from './store/settings';
import SyncStatusIndicator from './components/SyncStatusIndicator.vue';
import { usePowerEvents } from './composables/usePowerEvents';
import { useHotkeys } from './composables/useHotkeys';
import './styles/theme.css';

const settings = useSettingsStore();
onMounted(() => settings.loadTheme());

// Слушаем события пробуждения Windows
usePowerEvents();
// Глобальные горячие клавиши
useHotkeys();
</script>

<template>
  <div :class="['app', settings.theme]">
    <!-- Индикатор сети/синхронизации -->
    <SyncStatusIndicator class="app-sync-indicator" />
    <router-view />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  /* Минимальный размер окна: 900x600 */
  min-width: 900px;
  min-height: 600px;
}

.app-sync-indicator {
  position: fixed;
  top: 8px;
  right: 12px;
  z-index: 9999;
}
</style>
