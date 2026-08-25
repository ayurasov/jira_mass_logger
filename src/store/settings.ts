import { defineStore } from 'pinia';
import { ref, watch, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { RU_HOLIDAYS_DEFAULT, type RuHoliday } from '../lib/ruHolidays';

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

  // alias `workHoursPerDay` (используется в analytics, dayFromCalendar, MyWorklog) —
  // computed, чтобы корректно разворачиваться в шаблонах (v-model) и быть реактивным.
  const workHoursPerDay = computed(() => workdayHours.value);

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

  // --- Авто-синхронизация Jira worklog ---
  const autoSyncEnabled = ref<boolean>(
    localStorage.getItem('jiratime-auto-sync-enabled') === 'true',
  );
  const autoSyncIntervalMinutes = ref<number>(
    Number(localStorage.getItem('jiratime-auto-sync-interval') ?? '15') || 15,
  );
  function setAutoSync(enabled: boolean, minutes?: number) {
    autoSyncEnabled.value = enabled;
    if (typeof minutes === 'number' && minutes > 0) autoSyncIntervalMinutes.value = minutes;
    localStorage.setItem('jiratime-auto-sync-enabled', String(enabled));
    if (typeof minutes === 'number' && minutes > 0) {
      localStorage.setItem('jiratime-auto-sync-interval', String(minutes));
    }
  }


  // --- Производственный календарь РФ (праздники/выходные) ---
  // Базовый список праздников 2026-2027 годов + пользовательские дни, отключённые
  // праздники (если пользователь считает день рабочим) и добавленные вручную дни.
  const HOLIDAYS_STORAGE_KEY = 'jiratime-holidays-overrides';

  interface HolidayOverrides {
    disabled: string[]; // даты из базового списка, которые пользователь считает рабочими
    custom: RuHoliday[]; // дополнительные выходные, добавленные пользователем
  }

  function loadHolidayOverrides(): HolidayOverrides {
    try {
      const raw = localStorage.getItem(HOLIDAYS_STORAGE_KEY);
      if (raw) return JSON.parse(raw) as HolidayOverrides;
    } catch {
      // игнорируем повреждённые данные
    }
    return { disabled: [], custom: [] };
  }

  const _holidayOverrides = ref<HolidayOverrides>(loadHolidayOverrides());

  function persistHolidayOverrides() {
    localStorage.setItem(HOLIDAYS_STORAGE_KEY, JSON.stringify(_holidayOverrides.value));
  }

  // Итоговый список праздников: базовый набор минус отключённые пользователем,
  // плюс пользовательские дополнительные дни.
  const holidays = computed<RuHoliday[]>(() => {
    const disabledSet = new Set(_holidayOverrides.value.disabled);
    const base = RU_HOLIDAYS_DEFAULT.filter((h) => !disabledSet.has(h.date));
    const customDates = new Set(_holidayOverrides.value.custom.map((h) => h.date));
    return [...base, ..._holidayOverrides.value.custom].sort((a, b) => a.date.localeCompare(b.date))
      .filter((h, i, arr) => i === 0 || arr[i - 1].date !== h.date || customDates.has(h.date));
  });

  const holidaysMap = computed<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const h of holidays.value) m.set(h.date, h.title);
    return m;
  });

  function isHoliday(dateIso: string): boolean {
    return holidaysMap.value.has(dateIso);
  }

  function toggleBaseHoliday(dateIso: string, enabled: boolean) {
    const set = new Set(_holidayOverrides.value.disabled);
    if (enabled) set.delete(dateIso);
    else set.add(dateIso);
    _holidayOverrides.value = { ..._holidayOverrides.value, disabled: Array.from(set) };
    persistHolidayOverrides();
  }

  function addCustomHoliday(dateIso: string, title: string) {
    const custom = _holidayOverrides.value.custom.filter((h) => h.date !== dateIso);
    custom.push({ date: dateIso, title: title || 'Выходной день' });
    _holidayOverrides.value = { ..._holidayOverrides.value, custom };
    persistHolidayOverrides();
  }

  function removeCustomHoliday(dateIso: string) {
    const custom = _holidayOverrides.value.custom.filter((h) => h.date !== dateIso);
    _holidayOverrides.value = { ..._holidayOverrides.value, custom };
    persistHolidayOverrides();
  }

  function resetHolidayOverrides() {
    _holidayOverrides.value = { disabled: [], custom: [] };
    persistHolidayOverrides();
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
    workHoursPerDay,
    autoSyncEnabled,
    autoSyncIntervalMinutes,
    setAutoSync,
    holidays,
    holidaysMap,
    isHoliday,
    toggleBaseHoliday,
    addCustomHoliday,
    removeCustomHoliday,
    resetHolidayOverrides,
    RU_HOLIDAYS_DEFAULT,
  };
});
