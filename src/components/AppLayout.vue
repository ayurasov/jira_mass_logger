<!--
  Постоянная боковая навигация — обёртка для всех основных экранов приложения
  (кроме онбординга). Даёт единый способ переключаться между экранами:
  клик по пункту меню, горячие клавиши (см. useHotkeys) или сворачивание
  панели в компактный режим с иконками.
  Иконки — единый монохромный SVG-набор (NavIcon.vue / ActionIcon.vue) взамен разноцветных emoji.
-->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import AppLogo from './AppLogo.vue';
import NavIcon, { type NavIconName } from './NavIcon.vue';
import ActionIcon from './ActionIcon.vue';

interface NavItem {
  name: string;
  label: string;
  icon: NavIconName;
  hotkey?: string;
}

const NAV_ITEMS: NavItem[] = [
  { name: 'dashboard', label: 'Дашборд', icon: 'dashboard' },
  { name: 'worklog', label: 'Мой worklog', icon: 'worklog', hotkey: 'Ctrl+L' },
  { name: 'bulk', label: 'Массовое логирование', icon: 'bulk', hotkey: 'Ctrl+N' },
  { name: 'calendar', label: 'Календарь → Jira', icon: 'calendar', hotkey: 'Ctrl+K' },
  { name: 'templates', label: 'Шаблоны', icon: 'templates' },
  { name: 'profiles', label: 'Профили', icon: 'profiles' },
  { name: 'logs', label: 'Логи', icon: 'logs', hotkey: 'F1' },
  { name: 'settings', label: 'Настройки', icon: 'settings', hotkey: 'Ctrl+,' },
];

const route = useRoute();
const collapsed = ref<boolean>(localStorage.getItem('jiratime-sidebar-collapsed') === 'true');

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  localStorage.setItem('jiratime-sidebar-collapsed', String(collapsed.value));
}

const activeName = computed(() => route.name as string);

onMounted(() => {
  // Синхронизация, если значение было изменено в другой вкладке/окне (на будущее)
  window.addEventListener('storage', (e) => {
    if (e.key === 'jiratime-sidebar-collapsed') {
      collapsed.value = e.newValue === 'true';
    }
  });
});
</script>

<template>
  <div class="app-layout">
    <aside class="app-sidebar" :class="{ collapsed }">
      <div class="sidebar-brand" :title="collapsed ? 'JiraTime' : undefined">
        <AppLogo :size="26" />
        <span v-if="!collapsed" class="sidebar-brand-name">JiraTime</span>
        <button
          class="sidebar-toggle"
          :title="collapsed ? 'Развернуть меню' : 'Свернуть меню'"
          :aria-label="collapsed ? 'Развернуть меню' : 'Свернуть меню'"
          @click="toggleCollapsed"
        >
          <ActionIcon :name="collapsed ? 'chevron-right' : 'chevron-left'" :size="14" />
        </button>
      </div>

      <nav class="sidebar-nav" aria-label="Навигация по экранам">
        <router-link
          v-for="item in NAV_ITEMS"
          :key="item.name"
          :to="{ name: item.name }"
          class="nav-item"
          :class="{ active: activeName === item.name }"
          :title="collapsed ? item.label : undefined"
        >
          <span class="nav-icon"><NavIcon :name="item.icon" :size="19" /></span>
          <span class="nav-label">{{ item.label }}</span>
          <span v-if="item.hotkey && !collapsed" class="nav-hotkey">{{ item.hotkey }}</span>
        </router-link>
      </nav>
    </aside>

    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  min-height: 0;
  overflow: hidden;
}

.app-sidebar {
  display: flex;
  flex-direction: column;
  width: 17.5rem;
  flex-shrink: 0;
  background: var(--card);
  border-right: 1px solid var(--border);
  transition: width var(--transition-base, 180ms ease);
  overflow: hidden;
}
.app-sidebar.collapsed {
  width: 4.25rem;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.85rem 0.6rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.35rem;
}
.app-sidebar.collapsed .sidebar-brand {
  justify-content: center;
  padding: 0.85rem 0.35rem;
  position: relative;
}

.sidebar-brand-name {
  font-weight: 700;
  font-size: 1rem;
  letter-spacing: -0.01em;
  color: var(--fg);
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-toggle {
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.5rem;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.sidebar-toggle:hover {
  background: var(--chip);
  color: var(--fg);
  border-color: var(--border);
}
.app-sidebar.collapsed .sidebar-toggle {
  position: absolute;
  right: -0.6rem;
  top: 50%;
  transform: translateY(-50%);
  width: 1.4rem;
  height: 1.4rem;
  background: var(--card);
  border: 1px solid var(--border);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  z-index: 1;
}
.app-sidebar.collapsed .sidebar-toggle:hover {
  background: var(--chip);
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.15rem 0.55rem 0.75rem;
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.5rem 0.6rem;
  border-radius: 0.6rem;
  color: var(--fg);
  font-size: 0.875rem;
  line-height: 1.3;
  white-space: nowrap;
  transition: background 120ms ease, color 120ms ease;
}
.nav-item:hover {
  background: var(--chip);
}
.nav-item.active {
  background: var(--chip);
  color: var(--primary);
  font-weight: 600;
}

.nav-icon {
  width: 1.25rem;
  height: 1.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: inherit;
}

.nav-label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-hotkey {
  font-size: 0.65rem;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  padding: 0.08rem 0.3rem;
  font-family: 'Consolas', monospace;
  flex-shrink: 0;
}

.app-sidebar.collapsed .nav-item {
  justify-content: center;
  padding: 0.6rem;
}
.app-sidebar.collapsed .nav-label,
.app-sidebar.collapsed .nav-hotkey {
  display: none;
}

.app-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>
