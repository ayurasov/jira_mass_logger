import { createRouter, createWebHistory } from 'vue-router';
import { useSettingsStore } from '../store/settings';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // ─── Онбординг (Промпт 10) ───
    { path: '/onboarding', name: 'onboarding', component: () => import('../views/OnboardingWizard.vue') },

    // ─── Дашборд аналитики (Промпт 8) — главный экран ───
    { path: '/', name: 'analytics', component: () => import('../views/DashboardAnalytics.vue') },

    // ─── Остальные вьюхи ───
    { path: '/dashboard',         name: 'dashboard',         component: () => import('../views/Dashboard.vue') },
    { path: '/my-worklog',        name: 'my-worklog',        component: () => import('../views/MyWorklog.vue') },
    { path: '/bulk-log',          name: 'bulk-log',          component: () => import('../views/BulkLogWizard.vue') },
    { path: '/day-from-calendar', name: 'day-from-calendar', component: () => import('../views/DayFromCalendar.vue') },
    { path: '/day-bulk-preview',  name: 'day-bulk-preview',  component: () => import('../views/DayBulkPreview.vue') },
    { path: '/profiles',          name: 'profiles',          component: () => import('../views/Profiles.vue') },
    { path: '/templates',         name: 'templates',         component: () => import('../views/Templates.vue') },
    { path: '/settings',          name: 'settings',          component: () => import('../views/Settings.vue') },

    // ─── Логи (Промпт 9) ───
    { path: '/logs',              name: 'logs',              component: () => import('../views/LogsView.vue') },
  ],
});

// Навигационный гард: первый запуск → онбординг
// Онбординг считается пройденным, если в settings.onboardingCompleted === true
router.beforeEach((to) => {
  if (to.name === 'onboarding') return true;
  const settings = useSettingsStore();
  if (!settings.onboardingCompleted) {
    return { name: 'onboarding' };
  }
  return true;
});

export default router;
