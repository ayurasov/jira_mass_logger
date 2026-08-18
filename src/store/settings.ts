import { defineStore } from 'pinia';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { tauriApi, type AppSettings } from '../lib/tauriApi';

/** Представительная выборка IANA-таймзон, удобных для Windows-пользователей */
export const WINDOWS_TIMEZONES = [
  'Europe/Moscow', 'Europe/Kaliningrad', 'Europe/Samara',
  'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Krasnoyarsk',
  'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok',
  'Asia/Magadan', 'Asia/Kamchatka',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Helsinki', 'Europe/Kiev', 'Europe/Istanbul',
  'Asia/Dubai', 'Asia/Almaty', 'Asia/Bangkok',
  'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
  'Pacific/Auckland', 'America/New_York', 'America/Chicago',
  'America/Denver', 'America/Los_Angeles', 'America/Anchorage',
  'Pacific/Honolulu', 'UTC',
];

export const DAY_LABELS: Record<number, string> = {
  1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Вс',
};

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    // UI / theme
    theme: 'light' as 'light' | 'dark',
    followSystemTheme: true,
    // Backend-backed settings
    workHoursPerDay: 8,
    workDays: [1, 2, 3, 4, 5] as number[],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    notifyEndOfDay: true,
    notifyEndOfDayTime: '17:45',
    notifyEndOfWeek: true,
    notifyEndOfWeekTime: '17:00',
    closeToTray: true,
    autostart: false,
    holidayCountry: 'RU',
    // sync state
    autoSyncEnabled: localStorage.getItem('jiratime-autosync-enabled') !== 'false',
    autoSyncIntervalMinutes: Number(localStorage.getItem('jiratime-autosync-interval') ?? '5') || 5,
    loaded: false,
  }),

  actions: {
    /** Загружает настройки из Rust при старте приложения */
    async loadFromBackend() {
      try {
        const s = await tauriApi.getAppSettings();
        this.workHoursPerDay = s.workHoursPerDay;
        this.workDays = s.workDays;
        this.timezone = s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        this.notifyEndOfDay = s.notifyEndOfDay;
        this.notifyEndOfDayTime = s.notifyEndOfDayTime;
        this.notifyEndOfWeek = s.notifyEndOfWeek;
        this.notifyEndOfWeekTime = s.notifyEndOfWeekTime;
        this.closeToTray = s.closeToTray;
        this.autostart = s.autostart;
        this.holidayCountry = s.holidayCountry;
      } catch (_) {
        // БД может быть не готова при первом запуске — остаемся с defaults
      }
      this.loaded = true;
    },

    /** Сохраняет все настройки в Rust/SQLite */
    async save() {
      const s: AppSettings = {
        workHoursPerDay: this.workHoursPerDay,
        workDays: this.workDays,
        timezone: this.timezone,
        notifyEndOfDay: this.notifyEndOfDay,
        notifyEndOfDayTime: this.notifyEndOfDayTime,
        notifyEndOfWeek: this.notifyEndOfWeek,
        notifyEndOfWeekTime: this.notifyEndOfWeekTime,
        closeToTray: this.closeToTray,
        autostart: this.autostart,
        holidayCountry: this.holidayCountry,
      };
      await tauriApi.setAppSettings(s);
    },

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
      const appWindow = getCurrentWindow();
      const current = await appWindow.theme();
      if (current === 'dark' || current === 'light') this.theme = current;
      await appWindow.onThemeChanged(({ payload }) => {
        if (this.followSystemTheme && (payload === 'dark' || payload === 'light')) this.theme = payload;
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
