<!--
  Единый монохромный набор иконок для навигации приложения.
  Все иконки — stroke-based, однотонные (currentColor), одинаковая толщина линий (1.8),
  чтобы выглядеть единообразно вместо разноцветных emoji-иконок.
  Цвет наследуется от родителя (color: var(--fg) / var(--primary) для active).
-->
<script setup lang="ts">
export type NavIconName =
  | 'dashboard'
  | 'worklog'
  | 'bulk'
  | 'calendar'
  | 'team'
  | 'compose'
  | 'digest'
  | 'templates'
  | 'profiles'
  | 'logs'
  | 'settings';

const props = withDefaults(defineProps<{ name: NavIconName; size?: number }>(), { size: 20 });
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
    class="nav-svg-icon"
    aria-hidden="true"
  >
    <!-- Дашборд: столбики мини-аналитики -->
    <g v-if="name === 'dashboard'">
      <rect x="3" y="11" width="4" height="9" rx="1" />
      <rect x="10" y="6" width="4" height="14" rx="1" />
      <rect x="17" y="3" width="4" height="17" rx="1" />
    </g>

    <!-- Worklog: страница с таймером -->
    <g v-else-if="name === 'worklog'">
      <rect x="4" y="4" width="16" height="17" rx="2" />
      <path d="M8 2.5v3M16 2.5v3" />
      <circle cx="12" cy="14" r="3" />
      <path d="M12 12.5V14l1 1" />
    </g>

    <!-- Bulk: молния (массовое действие) -->
    <g v-else-if="name === 'bulk'">
      <path d="M12 2 4 13h6l-1 9 9-13h-6l1-7z" />
    </g>

    <!-- Calendar → Jira -->
    <g v-else-if="name === 'calendar'">
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
      <path d="M8 14h5m0 0-1.6-1.6M13 14l-1.6 1.6" />
    </g>

    <!-- Собрать день: блоки, складывающиеся в день -->
    <g v-else-if="name === 'compose'">
      <rect x="3" y="4" width="18" height="4" rx="1.2" />
      <rect x="3" y="10" width="11" height="4" rx="1.2" />
      <path d="M17 12h4M19 10v4" />
      <rect x="3" y="16" width="7" height="4" rx="1.2" />
    </g>

    <!-- Дайджест: пульс активности -->
    <g v-else-if="name === 'digest'">
      <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
    </g>

    <!-- Команда: двое людей -->
    <g v-else-if="name === 'team'">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M16.5 14.6c2.4.2 4.1 2 4.5 4.9" />
    </g>

    <!-- Шаблоны: линейка/трафарет -->
    <g v-else-if="name === 'templates'">
      <path d="M3 4h18v16H3z" />
      <path d="M7 8h10M7 12h10M7 16h6" />
    </g>

    <!-- Профили: связь/link -->
    <g v-else-if="name === 'profiles'">
      <path d="M9 15 15 9" />
      <path d="M11 6.5 12.3 5.2a3.5 3.5 0 0 1 5 5L16 11.5" />
      <path d="M13 17.5 11.7 18.8a3.5 3.5 0 0 1-5-5L8 12.5" />
    </g>

    <!-- Логи: документ строками -->
    <g v-else-if="name === 'logs'">
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M15 3v3h3" />
      <path d="M9 12h6M9 16h6M9 8h3" />
    </g>

    <!-- Настройки: шестерня -->
    <g v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.6 1z"
      />
    </g>
  </svg>
</template>

<style scoped>
.nav-svg-icon {
  display: block;
  flex-shrink: 0;
}
</style>
