import { defineStore } from 'pinia';
import { ref } from 'vue';

export type AppTheme = 'light' | 'dark';

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<AppTheme>('light');
  // Признак завершённого онбординга (Промпт 10)
  const onboardingCompleted = ref<boolean>(
    localStorage.getItem('jiratime-onboarding-done') === 'true'
  );

  /** Читаем тему из localStorage (или системные настройки через matchMedia) */
  function loadTheme() {
    const stored = localStorage.getItem('jiratime-theme') as AppTheme | null;
    if (stored === 'light' || stored === 'dark') {
      theme.value = stored;
    } else {
      // Автоопределение системной темы Windows 10/11
      theme.value = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
  }

  function setTheme(t: AppTheme) {
    theme.value = t;
    localStorage.setItem('jiratime-theme', t);
  }

  /** Отметить онбординг как завершённый */
  function completeOnboarding() {
    onboardingCompleted.value = true;
    localStorage.setItem('jiratime-onboarding-done', 'true');
  }

  /** Сбросить онбординг (для тестирования и ре-рана из запуска) */
  function resetOnboarding() {
    onboardingCompleted.value = false;
    localStorage.removeItem('jiratime-onboarding-done');
  }

  return {
    theme,
    onboardingCompleted,
    loadTheme,
    setTheme,
    completeOnboarding,
    resetOnboarding,
  };
});
