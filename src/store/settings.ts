import { defineStore } from 'pinia';
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<'light' | 'dark'>('light');
  const onboardingDone = ref(!!localStorage.getItem('onboarding_done'));

  async function loadTheme() {
    try {
      // Пытаемся получить системную тему через Tauri
      const t = await invoke<'light' | 'dark'>('get_system_theme').catch(() => null);
      if (t) { theme.value = t; return; }
    } catch {}
    // Fallback: matchMedia
    theme.value = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function setTheme(t: 'light' | 'dark') {
    theme.value = t;
    document.documentElement.setAttribute('data-theme', t);
  }

  function markOnboardingDone() {
    onboardingDone.value = true;
    localStorage.setItem('onboarding_done', '1');
  }

  return { theme, onboardingDone, loadTheme, setTheme, markOnboardingDone };
});
