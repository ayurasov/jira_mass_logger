<!--
  Компактный информационный блок "О программе" — фиксирован в правом нижнем
  углу поверх основного контента. Показывает версию приложения, дату сборки/
  релиза, автора и контакт для связи. Разворачивается по клику для показа
  деталей, в свёрнутом виде занимает минимум места.
-->
<script setup lang="ts">
import { ref } from 'vue';
import logoUrl from '../assets/logo.svg';

// Версия синхронизирована с src-tauri/tauri.conf.json (poле "version").
const APP_VERSION = '0.1.0';
const RELEASE_DATE = '25.08.2026';
const AUTHOR = 'Александр Юрасов';
const COPYRIGHT = `© 2026 Alexander Yurasov`;
const TELEGRAM_HANDLE = '@Alex_Yu_V';
const TELEGRAM_URL = 'https://t.me/Alex_Yu_V';

const expanded = ref(false);

function toggle() {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="about-badge" :class="{ expanded }">
    <button class="about-trigger" title="О программе" @click="toggle">
      <img :src="logoUrl" alt="JiraTime" class="about-logo" />
      <span class="about-version">v{{ APP_VERSION }}</span>
    </button>

    <div v-if="expanded" class="about-panel">
      <div class="about-panel-header">
        <img :src="logoUrl" alt="JiraTime" class="about-panel-logo" />
        <div>
          <div class="about-panel-title">JiraTime</div>
          <div class="about-panel-version">Версия {{ APP_VERSION }} · {{ RELEASE_DATE }}</div>
        </div>
      </div>
      <dl class="about-panel-meta">
        <dt>Автор</dt>
        <dd>{{ AUTHOR }}</dd>
        <dt>Copyright</dt>
        <dd>{{ COPYRIGHT }}</dd>
        <dt>Telegram</dt>
        <dd><a :href="TELEGRAM_URL" target="_blank" rel="noopener">{{ TELEGRAM_HANDLE }}</a></dd>
      </dl>
    </div>
  </div>
</template>

<style scoped>
.about-badge {
  position: fixed;
  right: 12px;
  bottom: 10px;
  z-index: 9998;
  font-size: 0.8rem;
}

.about-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.6rem;
  border-radius: 9999px;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--card, #fff);
  color: var(--muted, #6b7280);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  cursor: pointer;
}
.about-trigger:hover {
  color: var(--fg, #111827);
  border-color: var(--primary, #3366ff);
}

.about-logo {
  width: 16px;
  height: 16px;
  border-radius: 4px;
}

.about-version {
  font-weight: 600;
  font-family: 'Consolas', monospace;
}

.about-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: 15.5rem;
  padding: 0.85rem 1rem;
  border-radius: 0.75rem;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--card, #fff);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
}

.about-panel-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.6rem;
}

.about-panel-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  flex-shrink: 0;
}

.about-panel-title {
  font-weight: 700;
  color: var(--fg, #111827);
}

.about-panel-version {
  font-size: 0.78rem;
  color: var(--muted, #6b7280);
}

.about-panel-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.6rem;
  margin: 0;
  font-size: 0.8rem;
}

.about-panel-meta dt {
  color: var(--muted, #6b7280);
}

.about-panel-meta dd {
  margin: 0;
  color: var(--fg, #111827);
  text-align: right;
}

.about-panel-meta a {
  color: var(--primary, #3366ff);
  text-decoration: none;
}
.about-panel-meta a:hover {
  text-decoration: underline;
}
</style>
