import { createRouter, createWebHistory } from 'vue-router';
import { useSettingsStore } from '../store/settings';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // ─── Онбординг (Промпт 10) ───
    { path: '/onboarding', name: 'onboarding', component: () => import('../views/OnboardingWizard.vue') },

    // ─── Дашборд аналитики (Промпт 8) — главный экран ───
    { path: '/', name: 'analytics', component: () => import('../views/DashboardAnalytics.vue') },

    // ─── Основные экраны ───
    { path: '/dashboard',         name: 'dashboard',         component: () => import('../views/Dashboard.vue') },
    { path: '/my-worklog',        name: 'my-worklog',        component: () => import('../views/MyWorklog.vue') },
    { path: '/bulk-log',          name: 'bulk-log',          component: () => import('../views/BulkLogWizard.vue') },
    { path: '/day-from-calendar', name: 'day-from-calendar', component: () => import('../views/DayFromCalendar.vue') },
    { path: '/day-bulk-preview',  name: 'day-bulk-preview',  component: () => import('../views/DayBulkPreview.vue') },
    { path: '/profiles',          name: 'profiles',          component: () => import('../views/Profiles.vue') },
    { path: '/templates',         name: 'templates',         component: () => import('../views/Templates.vue') },
    { path: '/settings',          name: 'settings',          component: () => import('../views/Settings.vue') },
    { path: '/logs',              name: 'logs',              component: () => import('../views/LogsView.vue') },
  ],
});

// Guard: переднаправляем на онбординг при первом запуске
router.beforeEach((to) => {
  // Избегаем бесконечного цикла если уже идём на /onboarding
  if (to.name === 'onboarding') return;

  const onboardingDone = localStorage.getItem('jiratime-onboarding-done');
  if (!onboardingDone) {
    return { name: 'onboarding' };
  }
});

export default router;
