import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';

export type Theme = 'light' | 'dark' | 'system';

export interface WorkSchedule {
  workdayHours: number;
  workdays: number[]; // 0=Вс, 1=Пн, ..., 6=Сб
  timezone: string;
}

export const useSettingsStore = defineStore('settings', () => {
  // --- Тема ---
  const theme = ref<'light' | 'dark'>(
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );

  function loadTheme() {
    const saved = localStorage.getItem('jiratime-theme') as 'light' | 'dark' | null;
    if (saved) theme.value = saved;

    // Автоопределение темы Windows через Tauri при первом запуске
    if (!saved) {
      invoke<string>('get_system_theme')
        .then((t) => {
          if (t === 'dark' || t === 'light') theme.value = t;
        })
        .catch(() => {/* fallback: system matchMedia уже установлен */});
    }
  }

  watch(theme, (val) => localStorage.setItem('jiratime-theme', val));

  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }

  // --- Онбординг ---
  const onboardingDone = ref<boolean>(
    localStorage.getItem('jiratime-onboarding-done') === 'true',
  );

  function setOnboardingDone(val: boolean) {
    onboardingDone.value = val;
    localStorage.setItem('jiratime-onboarding-done', String(val));
  }

  // --- Рабочий график ---
  const DEFAULT_SCHEDULE: WorkSchedule = {
    workdayHours: 8,
    workdays: [1, 2, 3, 4, 5],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  const _savedSchedule = localStorage.getItem('jiratime-work-schedule');
  const workdayHours = ref<number>(
    _savedSchedule ? (JSON.parse(_savedSchedule) as WorkSchedule).workdayHours : DEFAULT_SCHEDULE.workdayHours,
  );
  const workdays = ref<number[]>(
    _savedSchedule ? (JSON.parse(_savedSchedule) as WorkSchedule).workdays : DEFAULT_SCHEDULE.workdays,
  );
  const timezone = ref<string>(
    _savedSchedule ? (JSON.parse(_savedSchedule) as WorkSchedule).timezone : DEFAULT_SCHEDULE.timezone,
  );

  function setWorkSchedule(s: WorkSchedule) {
    workdayHours.value = s.workdayHours;
    workdays.value = s.workdays;
    timezone.value = s.timezone;
    localStorage.setItem('jiratime-work-schedule', JSON.stringify(s));
    // Передаём в Rust-бэкенд для персистентного хранения в SQLite
    invoke('save_work_schedule', {
      workdayHours: s.workdayHours,
      workdays: s.workdays,
      timezone: s.timezone,
    }).catch(console.error);
  }

  return {
    theme,
    loadTheme,
    toggleTheme,
    onboardingDone,
    setOnboardingDone,
    workdayHours,
    workdays,
    timezone,
    setWorkSchedule,
  };
});
