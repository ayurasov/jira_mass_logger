import { createRouter, createWebHashHistory } from 'vue-router';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../store/settings';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('../views/OnboardingWizard.vue'),
      meta: { skipOnboardingGuard: true },
    },
    {
      path: '/',
      component: () => import('../components/AppLayout.vue'),
      children: [
        {
          path: '',
          name: 'dashboard',
          component: () => import('../views/DashboardAnalytics.vue'),
        },
        {
          path: 'worklog',
          name: 'worklog',
          component: () => import('../views/MyWorklog.vue'),
        },
        {
          path: 'bulk',
          name: 'bulk',
          component: () => import('../views/BulkLogWizard.vue'),
        },
        {
          path: 'calendar',
          name: 'calendar',
          component: () => import('../views/DayFromCalendar.vue'),
        },
        {
          path: 'calendar/preview',
          name: 'calendar-preview',
          component: () => import('../views/DayBulkPreview.vue'),
        },
        {
          path: 'templates',
          name: 'templates',
          component: () => import('../views/Templates.vue'),
        },
        {
          path: 'profiles',
          name: 'profiles',
          component: () => import('../views/Profiles.vue'),
        },
        {
          path: 'logs',
          name: 'logs',
          component: () => import('../views/LogsView.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('../views/Settings.vue'),
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

/**
 * Кэш результата проверки БД на этот сеанс работы приложения — чтобы не дёргать
 * Rust-команду `has_any_profiles` на каждую навигацию, а только один раз до первого
 * успешного её выполнения (null = ещё не проверяли, дальше — true/false).
 */
let dbHasProfilesCache: boolean | null = null;

async function dbHasProfiles(): Promise<boolean> {
  if (dbHasProfilesCache !== null) return dbHasProfilesCache;
  try {
    dbHasProfilesCache = await invoke<boolean>('has_any_profiles');
  } catch (e) {
    // Если Rust-команда недоступна (например, старый бинарник без миграции) —
    // не блокируем навигацию, просто считаем, что данных нет.
    console.error('has_any_profiles:', e);
    dbHasProfilesCache = false;
  }
  return dbHasProfilesCache;
}

/**
 * Guard: при первом запуске (онбординг не завершён) редиректируем на /onboarding —
 * НО только если в базе данных (SQLite) ещё нет ни одного профиля Jira/Exchange.
 *
 * Это покрывает сценарий, когда localStorage-флаг `jiratime-onboarding-done` был
 * сброшен (переустановка приложения, ручная очистка данных браузера/WebView2), но
 * сама база данных jiratime.db с уже настроенными профилями сохранилась — в этом
 * случае повторный онбординг не нужен, а флаг просто доводится до актуального состояния.
 */
router.beforeEach(async (to) => {
  if (to.meta.skipOnboardingGuard) return true;

  const settings = useSettingsStore();
  if (settings.onboardingDone) return true;

  if (await dbHasProfiles()) {
    // Профили уже есть в БД — онбординг не нужен, синхронизируем флаг.
    settings.setOnboardingDone(true);
    return true;
  }

  return { name: 'onboarding' };
});

export default router;
