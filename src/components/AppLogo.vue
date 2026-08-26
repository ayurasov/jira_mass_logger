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
        <stop offset="0%" stop-color="#2244dd" />
        <stop offset="100%" stop-color="#22c1a1" />
      </linearGradient>
    </defs>

    <!-- Фон -->
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#jt-grad)" />

    <!--
      Циферблат: cx=32 cy=30, r=23.
      Сдвинут чуть вверх (cy=30 вместо 32) чтобы бейдж (cx=49 cy=49)
      не перекрывал цифры — визуальный баланс.
      r=23 → диаметр 46px, занимает ~72% ширины плитки.
    -->
    <circle cx="32" cy="30" r="23"
      fill="none" stroke="#ffffff" stroke-width="3.5" />

    <!-- Засечки 12/3/6/9 (от края r внутрь на 4.5px) -->
    <!-- 12 -->
    <line x1="32" y1="8.5"  x2="32" y2="12.5"
      stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    <!-- 3  -->
    <line x1="53.5" y1="30" x2="49.5" y2="30"
      stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    <!-- 6  -->
    <line x1="32" y1="51.5" x2="32" y2="47.5"
      stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    <!-- 9  -->
    <line x1="10.5" y1="30" x2="14.5" y2="30"
      stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />

    <!--
      Стрелки 10:10 от центра (32, 30).
      Минутная → 60°:  конец = (32 + 18.86*sin60°,  30 − 18.86*cos60°)
                             = (32 + 16.33,          30 − 9.43)
                             = (48.33, 20.57)
      Часовая  → 300°: конец = (32 + 13.8*sin300°,  30 − 13.8*cos300°)
                             = (32 − 11.95,          30 − 6.9)
                             = (20.05, 23.1)
    -->
    <line x1="32" y1="30" x2="48.3" y2="20.6"
      stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" />
    <line x1="32" y1="30" x2="20.1" y2="23.1"
      stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" />

    <!-- Центральная точка -->
    <circle cx="32" cy="30" r="3" fill="#ffffff" />

    <!--
      Бейдж: cx=49 cy=49, r=8.5.
      Компактный, в правом нижнем углу.
      Галочка #0d5a46 — тёмно-зелёная, хорошо читается на белом
      и на Windows taskbar.
    -->
    <!-- Тень -->
    <circle cx="49" cy="49.8" r="8.8" fill="rgba(0,0,0,0.22)" />
    <!-- Белый круг -->
    <circle cx="49" cy="49" r="8.5" fill="#ffffff" />
    <!--
      Галочка в круге r=8.5, центр (49,49).
      Три точки: (45,49) → (48.2,52.5) → (54.5,44.5)
    -->
    <polyline
      points="45,49 48.2,52.5 54.5,44.5"
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
 * Логотип JiraTime.
 * Часы: cx=32 cy=30 r=23 (большой циферблат, сдвинут чуть вверх).
 * Бейдж: cx=49 cy=49 r=8.5 (компактный, правый нижний угол).
 * Галочка #0d5a46 — тёмно-зелёная, контрастная.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 32 });
</script>

<style scoped>
.app-logo {
  display: block;
  flex-shrink: 0;
}
</style>
