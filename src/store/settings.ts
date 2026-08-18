import { defineStore } from 'pinia';
import { getCurrentWindow } from '@tauri-apps/api/window';

// таймзона берётся из Windows-настроек пользователя через Intl API
export const useSettingsStore = defineStore('settings', {
  state: () => ({
    theme: 'light' as 'light' | 'dark',
    followSystemTheme: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workHoursPerDay: 8,
    // фоновая автосинхронизация экрана "Мой worklog" с Jira, минуты, можно отключить
    autoSyncEnabled: localStorage.getItem('jiratime-autosync-enabled') !== 'false',
    autoSyncIntervalMinutes: Number(localStorage.getItem('jiratime-autosync-interval') ?? '5') || 5,
  }),
  actions: {
    async loadTheme() {
      const saved = localStorage.getItem('jiratime-theme');
      const followSaved = localStorage.getItem('jiratime-follow-system');
      this.followSystemTheme = followSaved !== 'false';

      if (this.followSystemTheme) {
        await this.syncWithSystemTheme();
      } else if (saved === 'dark' || saved === 'light') {
        this.theme = saved;
      }
    },
    async syncWithSystemTheme() {
      // синхронизация с темой Windows 10/11 (Settings > Personalization > Colors)
      const appWindow = getCurrentWindow();
      const current = await appWindow.theme();
      if (current === 'dark' || current === 'light') this.theme = current;

      await appWindow.onThemeChanged(({ payload }) => {
        if (this.followSystemTheme && (payload === 'dark' || payload === 'light')) {
          this.theme = payload;
        }
      });
    },
    toggleTheme() {
      this.followSystemTheme = false;
      this.theme = this.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('jiratime-follow-system', 'false');
      localStorage.setItem('jiratime-theme', this.theme);
    },
    enableSystemTheme() {
      this.followSystemTheme = true;
      localStorage.setItem('jiratime-follow-system', 'true');
      this.syncWithSystemTheme();
    },
    setAutoSync(enabled: boolean, intervalMinutes?: number) {
      this.autoSyncEnabled = enabled;
      localStorage.setItem('jiratime-autosync-enabled', String(enabled));
      if (intervalMinutes && intervalMinutes > 0) {
        this.autoSyncIntervalMinutes = intervalMinutes;
        localStorage.setItem('jiratime-autosync-interval', String(intervalMinutes));
      }
    },
  },
});
