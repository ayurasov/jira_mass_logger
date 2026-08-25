<!--
  Компактный блок «O программе» — фиксируется в правом нижнем углу окна.
  Показывает логотип, версию приложения, автора, год и контакт в Telegram.
  Сворачивается/раскрывается кликом по значку ℹ.
-->
<script setup lang="ts">
import { ref } from 'vue';
import { getVersion } from '@tauri-apps/api/app';
import { onMounted } from 'vue';
import AppLogo from './AppLogo.vue';

const APP_NAME = 'JiraTime';
const AUTHOR = 'Александр Юрасов';
const TELEGRAM = '@Alex_Yu_V';
const COPYRIGHT_YEAR = new Date().getFullYear();

const version = ref<string>('0.1.0');
const expanded = ref(false);

onMounted(async () => {
  try {
    version.value = await getVersion();
  } catch {
    // fallback на значение из package.json/tauri.conf.json, если API недоступен (например, в dev-браузере)
  }
});

function toggle() {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="about-panel" :class="{ expanded }">
    <button
      class="about-toggle"
      type="button"
      :title="expanded ? 'Скрыть информацию о программе' : 'О программе'"
      @click="toggle"
    >
      <AppLogo :size="18" />
      <span class="about-toggle-icon">ℹ</span>
    </button>

    <transition name="about-fade">
      <div v-if="expanded" class="about-card">
        <div class="about-header">
          <AppLogo :size="28" />
          <div>
            <div class="about-title">{{ APP_NAME }}</div>
            <div class="about-version">Версия {{ version }}</div>
          </div>
        </div>
        <dl class="about-meta">
          <div class="about-row">
            <dt>Автор</dt>
            <dd>{{ AUTHOR }}</dd>
          </div>
          <div class="about-row">
            <dt>Связь</dt>
            <dd>
              <a :href="`https://t.me/${TELEGRAM.replace('@', '')}`" target="_blank" rel="noopener noreferrer">
                {{ TELEGRAM }}
              </a>
            </dd>
          </div>
          <div class="about-row">
            <dt>Copyright</dt>
            <dd>© {{ COPYRIGHT_YEAR }} Alexander Yurasov</dd>
          </div>
        </dl>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.about-panel {
  position: fixed;
  right: 12px;
  bottom: 10px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.about-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid var(--border, #d8deea);
  background: var(--card, #ffffff);
  color: var(--muted, #5d6475);
  border-radius: 999rem;
  padding: 0.3rem 0.65rem;
  font-size: 0.78rem;
  box-shadow: var(--shadow, 0 0.5rem 1.25rem rgba(42, 59, 88, 0.1));
  opacity: 0.85;
}
.about-toggle:hover {
  opacity: 1;
}
.about-toggle-icon {
  font-style: normal;
}

.about-card {
  margin-top: 0.5rem;
  width: 15.5rem;
  background: var(--card, #ffffff);
  border: 1px solid var(--border, #d8deea);
  border-radius: 0.875rem;
  box-shadow: var(--shadow, 0 0.75rem 2rem rgba(42, 59, 88, 0.12));
  padding: 0.9rem 1rem;
  color: var(--fg, #1a1a1a);
}

.about-header {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin-bottom: 0.65rem;
}

.about-title {
  font-weight: 700;
  font-size: 1rem;
}

.about-version {
  font-size: 0.78rem;
  color: var(--muted, #5d6475);
}

.about-meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.about-row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.82rem;
}

.about-row dt {
  color: var(--muted, #5d6475);
}

.about-row dd {
  margin: 0;
  text-align: right;
}

.about-row a {
  color: var(--primary, #2a62ff);
  text-decoration: underline;
}

.about-fade-enter-active,
.about-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.about-fade-enter-from,
.about-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
