<!--
  Единый монохромный набор служебных иконок для действий на страницах
  (кнопки, статусы, поиск и т.п.) — взамен разноцветных emoji.
  Стилистика идентична NavIcon.vue: stroke-based, currentColor, толщина линии 1.8.
-->
<script setup lang="ts">
export type ActionIconName =
  | 'refresh'
  | 'download'
  | 'search'
  | 'duplicate'
  | 'close'
  | 'pin'
  | 'pin-off'
  | 'edit'
  | 'trash'
  | 'link'
  | 'check-circle'
  | 'x-circle'
  | 'dot'
  | 'key'
  | 'folder'
  | 'chevron-left'
  | 'chevron-right'
  | 'star'
  | 'star-outline'
  | 'warning'
  | 'bolt'
  | 'clock'
  | 'play'
  | 'dashboard'
  | 'bell'
  | 'sparkles'
  | 'arrow-right';

const props = withDefaults(defineProps<{ name: ActionIconName; size?: number }>(), { size: 16 });
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="action-svg-icon"
    aria-hidden="true"
  >
    <g v-if="name === 'refresh'">
      <path d="M20 11a8 8 0 0 0-14.3-4.3M4 5v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.3M20 19v-4h-4" />
    </g>

    <g v-else-if="name === 'download'">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </g>

    <g v-else-if="name === 'search'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-4.8-4.8" />
    </g>

    <g v-else-if="name === 'duplicate'">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16V6a2 2 0 0 1 2-2h10" />
    </g>

    <g v-else-if="name === 'close'">
      <path d="M6 6l12 12M18 6L6 18" />
    </g>

    <g v-else-if="name === 'pin'">
      <path d="M12 2l2 2-1 5 4 4-3 1-3 3-1 5-1-5-3-3-3-1 4-4-1-5 2-2z" fill="currentColor" stroke="none" />
    </g>
    <g v-else-if="name === 'pin-off'">
      <path d="M12 2l2 2-1 5 4 4-3 1-3 3-1 5-1-5-3-3-3-1 4-4-1-5 2-2z" />
    </g>

    <g v-else-if="name === 'edit'">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 6.5l3 3" />
    </g>

    <g v-else-if="name === 'trash'">
      <path d="M5 7h14" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M7 7l1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </g>

    <g v-else-if="name === 'link'">
      <path d="M9 15 15 9" />
      <path d="M11 6.5 12.3 5.2a3.5 3.5 0 0 1 5 5L16 11.5" />
      <path d="M13 17.5 11.7 18.8a3.5 3.5 0 0 1-5-5L8 12.5" />
    </g>

    <g v-else-if="name === 'check-circle'">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.2l2.4 2.4 4.6-5.2" />
    </g>

    <g v-else-if="name === 'x-circle'">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </g>

    <g v-else-if="name === 'dot'">
      <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
    </g>

    <g v-else-if="name === 'key'">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l2 2M14 9l2 2" />
    </g>

    <g v-else-if="name === 'folder'">
      <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 17.5z" />
    </g>

    <g v-else-if="name === 'chevron-left'">
      <path d="M15 5 8 12l7 7" />
    </g>
    <g v-else-if="name === 'chevron-right'">
      <path d="M9 5l7 7-7 7" />
    </g>

    <g v-else-if="name === 'star'">
      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor" stroke="none" />
    </g>
    <g v-else-if="name === 'star-outline'">
      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z" />
    </g>

    <g v-else-if="name === 'warning'">
      <path d="M12 3.5 21 19H3z" />
      <path d="M12 9.5v4.2M12 16.5h.01" />
    </g>

    <g v-else-if="name === 'bolt'">
      <path d="M12 2 4 13h6l-1 9 9-13h-6l1-7z" />
    </g>

    <g v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </g>

    <g v-else-if="name === 'play'">
      <path d="M6.5 4.8v14.4a.9.9 0 0 0 1.4.7l11-7.2a.9.9 0 0 0 0-1.5l-11-7.2a.9.9 0 0 0-1.4.8z" />
    </g>

    <g v-else-if="name === 'dashboard'">
      <rect x="3" y="11" width="4" height="9" rx="1" />
      <rect x="10" y="6" width="4" height="14" rx="1" />
      <rect x="17" y="3" width="4" height="17" rx="1" />
    </g>

    <g v-else-if="name === 'bell'">
      <path d="M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </g>

    <g v-else-if="name === 'sparkles'">
      <path d="M12 2v6M12 16v6M4.5 12h6M13.5 12h6" />
      <path d="M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" />
    </g>

    <g v-else-if="name === 'arrow-right'">
      <path d="M4 12h16M14 6l6 6-6 6" />
    </g>
  </svg>
</template>

<style scoped>
.action-svg-icon {
  display: block;
  flex-shrink: 0;
}
</style>
