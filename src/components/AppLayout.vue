<!--
  Постоянная боковая навигация — обёртка для всех основных экранов приложения
  (кроме онбординга). Даёт единый способ переключаться между экранами:
  клик по пункту меню, горячие клавиши (см. useHotkeys) или сворацивание
  панели в компактный режим с иконками.
  Иконки — единый монохромный SVG-набор (NavIcon.vue) взамен разноцветных emoji.
-->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import AppLogo from './AppLogo.vue';
import NavIcon, { type NavIconName } from './NavIcon.vue';

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
        <AppLogo :size="28" />
        <span v-if="!collapsed" class="sidebar-brand-name">JiraTime</span>
      </div>

      <button
        class="sidebar-toggle"
        :title="collapsed ? 'Развернуть меню' : 'Свернуть меню'"
        @click="toggleCollapsed"
      >
        <span v-if="collapsed">»</span>
        <span v-else>«</span>
      </button>

      <nav class="sidebar-nav" aria-label="Навигация по экранам">
        <router-link
          v-for="item in NAV_ITEMS"
          :key="item.name"
          :to="{ name: item.name }"
          class="nav-item"
          :class="{ active: activeName === item.name }"
          :title="collapsed ? item.label : undefined"
        >
          <span class="nav-icon"><NavIcon :name="item.icon" :size="20" /></span>
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
  width: 19rem;
  flex-shrink: 0;
  background: var(--card);
  border-right: 1px solid var(--border);
  transition: width var(--transition-base, 180ms ease);
  overflow: hidden;
}
.app-sidebar.collapsed {
  width: 3.75rem;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.9rem 0.75rem 0.25rem;
  flex-shrink: 0;
}
.app-sidebar.collapsed .sidebar-brand {
  justify-content: center;
  padding: 0.9rem 0.4rem 0.25rem;
}
.sidebar-brand-name {
  font-weight: 700;
  font-size: 1.05rem;
  color: var(--fg);
  white-space: nowrap;
}

.sidebar-toggle {
  align-self: flex-end;
  margin: 0.5rem 0.5rem 0.25rem;
  width: 2rem;
  height: 2rem;
  border-radius: 0.5rem;
  border: 1px solid var(--border);
  background: var(--chip);
  color: var(--fg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.sidebar-toggle:hover {
  background: var(--border);
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem 0.75rem;
  overflow-y: auto;
}

.nav-item {
  display: grid;
  grid-template-columns: 1.25rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.4rem;
  padding: 0.55rem 0.55rem;
  border-radius: 0.75rem;
  color: var(--fg);
  white-space: nowrap;
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
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-hotkey {
  font-size: 0.65rem;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  padding: 0.08rem 0.25rem;
  font-family: 'Consolas', monospace;
  flex-shrink: 0;
  justify-self: end;
}

.app-sidebar.collapsed .nav-item {
  grid-template-columns: 1fr;
  justify-items: center;
  padding: 0.6rem;
}

.app-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>
