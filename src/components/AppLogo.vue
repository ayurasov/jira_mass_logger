<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    xmlns="http://www.w3.org/2000/svg"
    class="app-logo"
    role="img"
    aria-label="JiraTime"
  >
    <defs>
      <linearGradient id="jt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#3366ff" />
        <stop offset="100%" stop-color="#22c1a1" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#jt-grad)" />
    <circle cx="32" cy="34" r="18" fill="none" stroke="#ffffff" stroke-width="4" />
    <path
      d="M32 22 V34 L41 40"
      fill="none"
      stroke="#ffffff"
      stroke-width="4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <rect x="27" y="8" width="10" height="6" rx="2" fill="#ffffff" />
    <path
      d="M23 47 L29 53 L43 39"
      fill="none"
      stroke="#ffffff"
      stroke-width="4.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity="0.95"
    />
  </svg>
</template>

<script setup lang="ts">
/**
 * Логотип приложения JiraTime — часы синхронизации с чек-маркой.
 * Используется в сайдбаре (AppLayout.vue) и в блоке "О программе" (AboutPanel.vue).
 */
withDefaults(defineProps<{ size?: number }>(), { size: 32 });
</script>

<style scoped>
.app-logo {
  display: block;
  flex-shrink: 0;
}
</style>
