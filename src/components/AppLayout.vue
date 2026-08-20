<!--
  Постоянная боковая навигация — обёртка для всех основных экранов приложения
  (кроме онбординга). Даёт единый способ переключаться между экранами:
  клик по пункту меню, горячие клавиши (см. useHotkeys) или сворачивание
  панели в компактный режим с иконками.
-->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';

interface NavItem {
  name: string;
  label: string;
  icon: string;
  hotkey?: string;
}

const NAV_ITEMS: NavItem[] = [
  { name: 'dashboard', label: 'Дашборд', icon: '📊' },
  { name: 'worklog', label: 'Мой worklog', icon: '🗒️', hotkey: 'Ctrl+L' },
  { name: 'bulk', label: 'Массовое логирование', icon: '⚡', hotkey: 'Ctrl+N' },
  { name: 'templates', label: 'Шаблоны', icon: '📐' },
  { name: 'profiles', label: 'Профили', icon: '🔗' },
  { name: 'logs', label: 'Логи', icon: '🧾', hotkey: 'F1' },
  { name: 'settings', label: 'Настройки', icon: '⚙️', hotkey: 'Ctrl+,' },
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
          <span class="nav-icon">{{ item.icon }}</span>
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
  width: 15rem;
  flex-shrink: 0;
  background: var(--card);
  border-right: 1px solid var(--border);
  transition: width var(--transition-base, 180ms ease);
  overflow: hidden;
}
.app-sidebar.collapsed {
  width: 3.75rem;
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
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.65rem;
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
  font-size: 1.1rem;
  width: 1.5rem;
  text-align: center;
  flex-shrink: 0;
}

.nav-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-hotkey {
  font-size: 0.7rem;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  padding: 0.1rem 0.35rem;
  font-family: 'Consolas', monospace;
  flex-shrink: 0;
}

.app-sidebar.collapsed .nav-item {
  justify-content: center;
  padding: 0.6rem;
}

.app-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>
