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
      Циферблат: cx=32 cy=32 r=23 — СТРОГО по центру viewBox 64×64.
      Диаметр 46px, поле от края фона: 2px (паддинг rect) + (32-23)=9px = 11px.
      Бейдж cx=49 cy=49 перекрывает правый нижний сектор.
    -->
    <circle cx="32" cy="32" r="23"
      fill="none" stroke="#ffffff" stroke-width="3.5" />

    <!--
      Засечки 12/3/6/9 — от внешнего края r=23 внутрь на 4px.
      12: (32, 32-23)=(32,9)  → (32, 9+4)=(32,13)   ← верхний край с учётом stroke
      Используем stroke cx±r  и cx±(r-4) точки:
        12: y1=32-23=9  → y2=9+4.5=13.5  (x=32)
        3:  x1=32+23=55 → x2=55-4.5=50.5 (y=32)
        6:  y1=32+23=55 → y2=55-4.5=50.5 (x=32)
        9:  x1=32-23=9  → x2=9+4.5=13.5  (y=32)
    -->
    <line x1="32" y1="9"   x2="32" y2="13.5" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    <line x1="55" y1="32" x2="50.5" y2="32" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    <line x1="32" y1="55" x2="32" y2="50.5" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    <line x1="9"  y1="32" x2="13.5" y2="32" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />

    <!--
      Стрелки 10:10 от центра (32,32).
      Минутная (60° от 12, длина 0.82×23=18.86):
        конец = (32 + 18.86×sin60°, 32 − 18.86×cos60°)
              = (32 + 16.33,        32 − 9.43)
              = (48.33, 22.57)
      Часовая (300° от 12, длина 0.60×23=13.8):
        конец = (32 + 13.8×sin300°, 32 − 13.8×cos300°)
              = (32 − 11.95,        32 − 6.9)
              = (20.05, 25.1)
    -->
    <line x1="32" y1="32" x2="48.3" y2="22.6"
      stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" />
    <line x1="32" y1="32" x2="20.1" y2="25.1"
      stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" />

    <!-- Центральная точка -->
    <circle cx="32" cy="32" r="3" fill="#ffffff" />

    <!--
      Бейдж: cx=49 cy=49 r=8.5.
      Правый нижний угол — перекрывает циферблат на ~2px, создавая глубину.
    -->
    <!-- Тень -->
    <circle cx="49" cy="49.8" r="8.8" fill="rgba(0,0,0,0.22)" />
    <!-- Белый круг -->
    <circle cx="49" cy="49" r="8.5" fill="#ffffff" />
    <!--
      Галочка внутри бейджа.
      Три точки: левая (45,49) → нижняя (48.2,52.5) → правая верхняя (54.5,44.5).
      stroke #0d5a46 — тёмно-зелёный, хорошо виден на белом фоне и на Windows taskbar.
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
 * Циферблат: cx=32 cy=32 r=23 — строго по центру viewBox 64×64.
 * Бейдж:     cx=49 cy=49 r=8.5 — правый нижний угол.
 * Галочка:   stroke #0d5a46 (тёмно-зелёная, контрастная).
 */
withDefaults(defineProps<{ size?: number }>(), { size: 32 });
</script>

<style scoped>
.app-logo {
  display: block;
  flex-shrink: 0;
}
</style>
