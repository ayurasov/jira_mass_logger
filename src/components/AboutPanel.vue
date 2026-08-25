<!--
  Кнопка «О программе» — фиксированный значок ℹ в левом нижнем углу окна.
  По клику открывает модальное окно по центру экрана: крупный логотип,
  название, версия, автор, контакт в Telegram, copyright и благодарность
  за использование программы. Закрывается кнопкой «ОК», крестиком,
  кликом по фону или клавишей Esc.
-->
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { getVersion } from '@tauri-apps/api/app';
import AppLogo from './AppLogo.vue';
import ActionIcon from './ActionIcon.vue';

const APP_NAME = 'JiraTime';
const AUTHOR = 'Александр Юрасов';
const TELEGRAM = '@Alex_Yu_V';
const COPYRIGHT_YEAR = new Date().getFullYear();

const version = ref<string>('0.1.0');
const open = ref(false);

onMounted(async () => {
  try {
    version.value = await getVersion();
  } catch {
    // fallback на значение из package.json/tauri.conf.json, если API недоступен (например, в dev-браузере)
  }
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    close();
  }
}

function toggle() {
  open.value = !open.value;
}

function close() {
  open.value = false;
}
</script>

<template>
  <button
    class="about-toggle"
    type="button"
    title="О программе"
    aria-label="О программе"
    @click="toggle"
  >
    <ActionIcon name="info" :size="18" />
  </button>

  <transition name="about-fade">
    <div v-if="open" class="about-overlay" @click.self="close">
      <div class="about-modal" role="dialog" aria-modal="true" aria-label="О программе">
        <button class="about-close" type="button" title="Закрыть" aria-label="Закрыть" @click="close">
          <ActionIcon name="close" :size="18" />
        </button>

        <div class="about-modal__logo">
          <AppLogo :size="72" />
        </div>

        <div class="about-modal__title">{{ APP_NAME }}</div>
        <div class="about-modal__version">Версия {{ version }}</div>

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

        <p class="about-thanks">Спасибо, что пользуетесь {{ APP_NAME }}! 🙌</p>

        <button class="about-ok" type="button" @click="close">ОК</button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.about-toggle {
  position: fixed;
  left: 12px;
  bottom: 10px;
  z-index: 9999;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--border, #d8deea);
  background: var(--card, #ffffff);
  color: var(--muted, #5d6475);
  border-radius: 999rem;
  box-shadow: var(--shadow, 0 0.5rem 1.25rem rgba(42, 59, 88, 0.1));
  opacity: 0.85;
  cursor: pointer;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.about-toggle:hover {
  opacity: 1;
  background: var(--chip, #f0f2f7);
  color: var(--fg, #1a1a1a);
}

.about-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 20, 30, 0.45);
  backdrop-filter: blur(2px);
}

.about-modal {
  position: relative;
  width: 24rem;
  max-width: calc(100vw - 2rem);
  background: var(--card, #ffffff);
  border: 1px solid var(--border, #d8deea);
  border-radius: 1.1rem;
  box-shadow: 0 1.5rem 3.5rem rgba(20, 28, 46, 0.25);
  padding: 2rem 1.75rem 1.75rem;
  color: var(--fg, #1a1a1a);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.about-close {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: none;
  background: transparent;
  color: var(--muted, #5d6475);
  border-radius: 0.5rem;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.about-close:hover {
  background: var(--chip, #f0f2f7);
  color: var(--fg, #1a1a1a);
}

.about-modal__logo {
  margin-bottom: 0.9rem;
}

.about-modal__title {
  font-weight: 700;
  font-size: 1.4rem;
  letter-spacing: -0.01em;
}

.about-modal__version {
  font-size: 0.9rem;
  color: var(--muted, #5d6475);
  margin-top: 0.15rem;
  margin-bottom: 1.4rem;
}

.about-meta {
  margin: 0 0 1.3rem;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.about-row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.9rem;
  border-bottom: 1px solid var(--border, #eef0f5);
  padding-bottom: 0.45rem;
}
.about-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.about-row dt {
  color: var(--muted, #5d6475);
}

.about-row dd {
  margin: 0;
  text-align: right;
  font-weight: 500;
}

.about-row a {
  color: var(--primary, #2a62ff);
  text-decoration: underline;
}

.about-thanks {
  margin: 0 0 1.5rem;
  font-size: 0.95rem;
  color: var(--fg, #1a1a1a);
}

.about-ok {
  width: 100%;
  padding: 0.65rem 1rem;
  border: none;
  border-radius: 0.6rem;
  background: var(--primary, #2a62ff);
  color: #fff;
  font-weight: 600;
  font-size: 0.95rem;
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.about-ok:hover {
  opacity: 0.9;
}

.about-fade-enter-active,
.about-fade-leave-active {
  transition: opacity 0.15s ease;
}
.about-fade-enter-from,
.about-fade-leave-to {
  opacity: 0;
}
</style>
