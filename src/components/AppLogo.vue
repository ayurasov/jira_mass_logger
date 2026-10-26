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
      <linearGradient :id="`${uid}-bg`" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2447e0" />
        <stop offset="1" stop-color="#1fbf9f" />
      </linearGradient>
      <!-- Мягкий блик сверху — объём без лишних деталей -->
      <linearGradient :id="`${uid}-gl`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity=".16" />
        <stop offset=".5" stop-color="#fff" stop-opacity="0" />
      </linearGradient>
      <!-- Вырез вокруг бейджа: циферблат не упирается в него, между ними чистый зазор -->
      <mask :id="`${uid}-cut`" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <circle cx="47" cy="47" r="12.4" fill="#000" />
      </mask>
    </defs>

    <rect x="1" y="1" width="62" height="62" rx="13" :fill="`url(#${uid}-bg)`" />
    <rect x="1" y="1" width="62" height="62" rx="13" :fill="`url(#${uid}-gl)`" />

    <!-- Циферблат r=22 по центру, засечки 12/3/6/9, стрелки 10:10 -->
    <g :mask="`url(#${uid}-cut)`" stroke="#fff" stroke-linecap="round" fill="none">
      <circle cx="32" cy="32" r="22" stroke-width="3.6" />
      <line x1="32" y1="10" x2="32" y2="14.2" stroke-width="2.6" />
      <line x1="54" y1="32" x2="49.8" y2="32" stroke-width="2.6" />
      <line x1="32" y1="54" x2="32" y2="49.8" stroke-width="2.6" />
      <line x1="10" y1="32" x2="14.2" y2="32" stroke-width="2.6" />
      <line x1="32" y1="32" x2="47.24" y2="23.2" stroke-width="3.6" />
      <line x1="32" y1="32" x2="21.33" y2="25.84" stroke-width="3.6" />
      <circle cx="32" cy="32" r="2.9" fill="#fff" stroke="none" />
    </g>

    <!-- Бейдж с галочкой: плечи 1:2, скруглённые концы и излом -->
    <circle cx="47" cy="47" r="10" fill="#fff" />
    <path
      d="M42.3 47.3 L45.6 50.6 L51.9 44.1"
      fill="none"
      stroke="#0f7a55"
      stroke-width="2.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup lang="ts">
/**
 * Логотип JiraTime — тот же рисунок, что и в иконках приложения (src-tauri/icons).
 * id градиентов/маски уникальны на экземпляр: логотип одновременно есть в меню и в «О программе».
 */
import { useId } from 'vue';

withDefaults(defineProps<{ size?: number }>(), { size: 32 });
const uid = `jt-logo-${useId()}`;
</script>

<style scoped>
.app-logo {
  display: block;
  flex-shrink: 0;
}
</style>
