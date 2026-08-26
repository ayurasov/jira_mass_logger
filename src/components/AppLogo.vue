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

    <!-- Фон-карточка: ровный отступ 2px со всех сторон -->
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#jt-grad)" />

    <!--
      Циферблат: СТРОГО по центру viewBox.
      cx=32 cy=32 — математический центр 64×64.
      r=18 → диаметр 36px, оставляет поле для бейджа в правом нижнем углу.
    -->
    <circle
      cx="32" cy="32" r="18"
      fill="none"
      stroke="#ffffff"
      stroke-width="3.5"
    />

    <!-- Засечка 12 часов -->
    <line
      x1="32" y1="15" x2="32" y2="18.5"
      stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"
    />

    <!--
      Стрелки: показываем ~10:10 — классическое «улыбающееся» время.
      Минутная: вверх-влево (к 10 часам) → (32,32) → (22.5, 22.5)
      Часовая:  вверх-вправо (к 2 часам)  → (32,32) → (41.5, 22.5)
    -->
    <!-- Минутная стрелка (длиннее) -->
    <line
      x1="32" y1="32" x2="23" y2="23"
      stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"
    />
    <!-- Часовая стрелка (короче) -->
    <line
      x1="32" y1="32" x2="41" y2="23"
      stroke="#ffffff" stroke-width="3" stroke-linecap="round"
    />

    <!-- Центральная точка -->
    <circle cx="32" cy="32" r="2.5" fill="#ffffff" />

    <!--
      Бейдж с галочкой — правый нижний угол.
      cx=47 cy=47, r=11.
      Галочка: тёмный зелёный #0d5a46 (хорошо виден на белом фоне и на тёмном taskbar Windows).
    -->
    <!-- Тень бейджа -->
    <circle cx="47" cy="47.5" r="11" fill="rgba(0,0,0,0.18)" />
    <!-- Белый круг -->
    <circle cx="47" cy="47" r="11" fill="#ffffff" />
    <!-- Галочка: три точки образуют ✓ симметрично внутри круга -->
    <polyline
      points="41,47 45.5,52 53,41"
      fill="none"
      stroke="#0d5a46"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup lang="ts">
/**
 * Логотип приложения JiraTime — часы с бейджем-галочкой.
 * Циферблат строго по центру viewBox (cx=32 cy=32).
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
