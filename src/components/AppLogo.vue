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

    <!-- Фон-карточка -->
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#jt-grad)" />

    <!-- Циферблат часов (смещён вверх-влево, чтобы дать место бейджу) -->
    <circle cx="29" cy="30" r="17" fill="none" stroke="#ffffff" stroke-width="3.5" />

    <!-- Стрелки часов: 12→3 (вертикаль вверх + горизонталь вправо) -->
    <line x1="29" y1="22" x2="29" y2="30" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" />
    <line x1="29" y1="30" x2="37" y2="35" stroke="#ffffff" stroke-width="3" stroke-linecap="round" />

    <!-- Засечка 12 часов -->
    <line x1="29" y1="14.5" x2="29" y2="17.5" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />

    <!-- Бейдж с галочкой — правый нижний угол, поверх фона -->
    <!-- Белый круг-фон бейджа -->
    <circle cx="47" cy="47" r="10" fill="#ffffff" />
    <!-- Галочка внутри бейджа (teal) -->
    <polyline
      points="41,47 45.5,52 53,41"
      fill="none"
      stroke="#22c1a1"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup lang="ts">
/**
 * Логотип приложения JiraTime — часы с бейджем-галочкой.
 * Используется в сайдбаре (AppLayout.vue) и в блоке «О программе» (AboutPanel.vue).
 */
withDefaults(defineProps<{ size?: number }>(), { size: 32 });
</script>

<style scoped>
.app-logo {
  display: block;
  flex-shrink: 0;
}
</style>
