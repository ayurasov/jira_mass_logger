import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // ─── Дашборд аналитики (Промпт 8) — главный экран ───
    { path: '/', name: 'analytics', component: () => import('../views/DashboardAnalytics.vue') },

    // ─── Остальные вьюхи ───
    { path: '/dashboard',        name: 'dashboard',        component: () => import('../views/Dashboard.vue') },
    { path: '/my-worklog',       name: 'my-worklog',       component: () => import('../views/MyWorklog.vue') },
    { path: '/bulk-log',         name: 'bulk-log',         component: () => import('../views/BulkLogWizard.vue') },
    { path: '/day-from-calendar',name: 'day-from-calendar',component: () => import('../views/DayFromCalendar.vue') },
    { path: '/day-bulk-preview', name: 'day-bulk-preview', component: () => import('../views/DayBulkPreview.vue') },
    { path: '/profiles',         name: 'profiles',         component: () => import('../views/Profiles.vue') },
    { path: '/templates',        name: 'templates',        component: () => import('../views/Templates.vue') },
    { path: '/settings',         name: 'settings',         component: () => import('../views/Settings.vue') },

    // ─── Логи (Промпт 9) — экран диагностики ───
    { path: '/logs',             name: 'logs',             component: () => import('../views/LogsView.vue') },
  ],
});

export default router;
