import { createRouter, createWebHashHistory } from 'vue-router';
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
      name: 'dashboard',
      component: () => import('../views/DashboardAnalytics.vue'),
    },
    {
      path: '/worklog',
      name: 'worklog',
      component: () => import('../views/MyWorklog.vue'),
    },
    {
      path: '/bulk',
      name: 'bulk',
      component: () => import('../views/BulkLogWizard.vue'),
    },
    {
      path: '/templates',
      name: 'templates',
      component: () => import('../views/Templates.vue'),
    },
    {
      path: '/profiles',
      name: 'profiles',
      component: () => import('../views/Profiles.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/Settings.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

/**
 * Guard: при первом запуске (онбординг не завершён) редиректируем на /onboarding.
 */
router.beforeEach((to) => {
  if (to.meta.skipOnboardingGuard) return true;

  const settings = useSettingsStore();
  if (!settings.onboardingDone) {
    return { name: 'onboarding' };
  }
  return true;
});

export default router;
