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
        <stop offset="0%" stop-color="#2255ee" />
        <stop offset="100%" stop-color="#22c1a1" />
      </linearGradient>
    </defs>

    <!-- Фон -->
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#jt-grad)" />

    <!--
      Циферблат: cx=32 cy=32 (=центр 64×64), r=20.
      r=20 → диаметр 40px, остаёт поле 14px до границы фона.
      Бейдж (r=9) вынесен в правый нижний угол, перекрывая часть циферблата.
    -->
    <circle cx="32" cy="32" r="20"
      fill="none" stroke="#ffffff" stroke-width="3.5" />

    <!-- Засечки на  12, 3, 6, 9 часов -->
    <!-- 12 -->
    <line x1="32" y1="13" x2="32" y2="17"
      stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    <!-- 3 -->
    <line x1="51" y1="32" x2="47" y2="32"
      stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    <!-- 6 -->
    <line x1="32" y1="51" x2="32" y2="47"
      stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    <!-- 9 -->
    <line x1="13" y1="32" x2="17" y2="32"
      stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />

    <!--
      Стрелки 10:10 (симметричное положение).
      Минутная (10 мин = 60° от 12): (32,32) → длина 14.5, угол 60° от центра
        Точка: (32+14.5*sin60, 32-14.5*cos60) = (32+12.56, 32-7.25) = (44.56, 24.75)
      Часовая (к 10 ч = 300° от 12): (32,32) → длина 10.5, угол 300°
        Точка: (32+10.5*sin300, 32-10.5*cos300) = (32-9.09, 32-5.25) = (22.91, 26.75)
    -->
    <!-- Минутная -->
    <line x1="32" y1="32" x2="44.6" y2="24.8"
      stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" />
    <!-- Часовая -->
    <line x1="32" y1="32" x2="22.9" y2="26.8"
      stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" />

    <!-- Центральная точка -->
    <circle cx="32" cy="32" r="2.8" fill="#ffffff" />

    <!--
      Бейдж cx=48 cy=48, r=9.
      Галочка занимает ~60% диаметра бейджа.
      Тёмный зелёный #0d5a46 — хорошо виден на белом и на Windows taskbar.
    -->
    <!-- Тень -->
    <circle cx="48" cy="48.5" r="9.2" fill="rgba(0,0,0,0.2)" />
    <!-- Белый круг -->
    <circle cx="48" cy="48" r="9" fill="#ffffff" />
    <!-- Галочка: (44.5,48) → (47.5,51.5) → (53,43.5) -->
    <polyline
      points="44.5,48 47.5,51.5 53,43.5"
      fill="none"
      stroke="#0d5a46"
      stroke-width="2.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup lang="ts">
/**
 * Логотип JiraTime: часы (cx=32 cy=32 r=20) + бейдж-галочка (cx=48 cy=48 r=9).
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
