import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('../views/Dashboard.vue') },
    { path: '/profiles', name: 'profiles', component: () => import('../views/Profiles.vue') },
    { path: '/templates', name: 'templates', component: () => import('../views/Templates.vue') },
    { path: '/settings', name: 'settings', component: () => import('../views/Settings.vue') },
  ],
});

export default router;
