<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { useRouter } from 'vue-router';
import { useDayFromCalendarStore } from './store/dayFromCalendar';
import { localIsoDate } from './utils/time';
import { useSettingsStore } from './store/settings';
import { useLicenseStore } from './store/license';
import { useJiraProfilesStore } from './store/jiraProfiles';
import SyncStatusIndicator from './components/SyncStatusIndicator.vue';
import AboutPanel from './components/AboutPanel.vue';
import LicenseRequiredModal from './components/LicenseRequiredModal.vue';
import { usePowerEvents } from './composables/usePowerEvents';
import { useHotkeys } from './composables/useHotkeys';
import { useUpdater } from './composables/useUpdater';
import './styles/theme.css';

const settings = useSettingsStore();
const license = useLicenseStore();
const jiraProfiles = useJiraProfilesStore();
const router = useRouter();

// Пункт трея «Залогировать сегодня» — открываем день из календаря на сегодня.
listen('tray:log_today', async () => {
  const today = localIsoDate();
  try { localStorage.setItem('jiratime-calendar-date', today); } catch { /* private mode */ }
  if (router.currentRoute.value.name === 'calendar') {
    await useDayFromCalendarStore().loadDay(today);
  } else {
    await router.push({ name: 'calendar' });
  }
}).catch(() => {});

onMounted(() => {
  settings.loadTheme();
  license.load();
  jiraProfiles.ensureLoaded();
});

// Тема дублируется на <html>: фон body, полосы прокрутки и элементы вне .app
// (модалки, выпадающие списки) тоже становятся тёмными, без белых полей.
watch(
  () => settings.theme,
  (t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.style.colorScheme = t;
  },
  { immediate: true },
);

// Индикатор сети в шапке проверяет доступность именно активного Jira-профиля.
watch(
  () => jiraProfiles.activeConnectionParams,
  (params) => { invoke('set_monitor_connection', { params }).catch(() => {}); },
  { deep: true },
);

// Пробуждение Windows / возврат из свёрнутого состояния: экраны, которым нужно
// обновиться (например, «Мой worklog»), слушают 'system:possible_resume'.
usePowerEvents(() => { emit('system:possible_resume').catch(() => {}); });

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
    <!-- Блок «О программе»: версия, автор, дата/копирайт, контакт в Telegram — правый нижний угол -->
    <AboutPanel />
    <!-- Глобальный модал требования лицензии -->
    <LicenseRequiredModal />
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
