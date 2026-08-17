import { defineStore } from 'pinia';

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    theme: 'light' as 'light' | 'dark',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workHoursPerDay: 8,
  }),
  actions: {
    loadTheme() {
      const saved = localStorage.getItem('jiratime-theme');
      if (saved === 'dark' || saved === 'light') this.theme = saved;
    },
    toggleTheme() {
      this.theme = this.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('jiratime-theme', this.theme);
    },
  },
});
