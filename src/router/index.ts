import { createRouter, createWebHistory } from 'vue-router';

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

// ─── Гард: перенаправляем на /onboarding при первом запуске ───
router.beforeEach((to) => {
  const done = localStorage.getItem('onboarding_done');
  if (!done && to.name !== 'onboarding') {
    return { name: 'onboarding' };
  }
});

export default router;
