import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('../views/Dashboard.vue') },
    { path: '/my-worklog', name: 'my-worklog', component: () => import('../views/MyWorklog.vue') },
    { path: '/bulk-log', name: 'bulk-log', component: () => import('../views/BulkLogWizard.vue') },
    { path: '/profiles', name: 'profiles', component: () => import('../views/Profiles.vue') },
    { path: '/templates', name: 'templates', component: () => import('../views/Templates.vue') },
    { path: '/settings', name: 'settings', component: () => import('../views/Settings.vue') },
  ],
});

export default router;
