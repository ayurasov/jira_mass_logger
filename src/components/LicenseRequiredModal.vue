<!--
  Модальное окно «Требуется лицензия».
  Показывается глобально через useLicenseStore.showModal.
  Кнопка «Активировать» → открывает AboutPanel на поле ввода кода.
  Кнопка «Закрыть» → просто закрывает модал (режим просмотра сохраняется).
-->
<script setup lang="ts">
import { useLicenseStore } from '../store/license';
import ActionIcon from './ActionIcon.vue';

const license = useLicenseStore();
</script>

<template>
  <transition name="lic-fade">
    <div v-if="license.showModal" class="lic-overlay" @click.self="license.closeModal">
      <div class="lic-modal" role="alertdialog" aria-modal="true" aria-labelledby="lic-title">

        <button
          class="lic-close"
          type="button"
          aria-label="Закрыть"
          @click="license.closeModal"
        >
          <ActionIcon name="close" :size="18" />
        </button>

        <!-- Icon -->
        <div class="lic-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="24" fill="var(--primary-soft, #e8eeff)" />
            <path d="M24 14a6 6 0 0 1 6 6v2h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H17a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1v-2a6 6 0 0 1 6-6zm0 2a4 4 0 0 0-4 4v2h8v-2a4 4 0 0 0-4-4zm0 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4z" fill="var(--primary, #2a62ff)"/>
          </svg>
        </div>

        <h2 id="lic-title" class="lic-title">Требуется лицензия</h2>

        <p class="lic-desc">
          Запись в Jira доступна только при активной лицензии.<br>
          Введите код активации, чтобы разблокировать все функции.
        </p>

        <div class="lic-actions">
          <button class="lic-btn lic-btn--primary" type="button" @click="license.openActivation">
            <ActionIcon name="key" :size="16" />
            Активировать лицензию
          </button>
          <button class="lic-btn lic-btn--ghost" type="button" @click="license.closeModal">
            Продолжить в режиме просмотра
          </button>
        </div>

      </div>
    </div>
  </transition>
</template>

<style scoped>
.lic-overlay {
  position: fixed;
  inset: 0;
  z-index: 10100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 20, 30, 0.50);
  backdrop-filter: blur(3px);
}

.lic-modal {
  position: relative;
  width: 26rem;
  max-width: calc(100vw - 2rem);
  background: var(--card, #ffffff);
  border: 1px solid var(--border, #d8deea);
  border-radius: 1.1rem;
  box-shadow: 0 1.5rem 3.5rem rgba(20, 28, 46, 0.28);
  padding: 2.25rem 2rem 2rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  color: var(--fg, #1a1a1a);
}

.lic-close {
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
  transition: background 0.15s, color 0.15s;
}
.lic-close:hover {
  background: var(--chip, #f0f2f7);
  color: var(--fg, #1a1a1a);
}

.lic-icon {
  margin-bottom: 1.1rem;
}

.lic-title {
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 0.65rem;
}

.lic-desc {
  font-size: 0.92rem;
  color: var(--muted, #5d6475);
  line-height: 1.55;
  margin: 0 0 1.5rem;
  max-width: 22rem;
}

.lic-actions {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: 100%;
}

.lic-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  width: 100%;
  padding: 0.65rem 1rem;
  border-radius: 0.6rem;
  font-size: 0.92rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: opacity 0.15s, background 0.15s;
}

.lic-btn--primary {
  background: var(--primary, #2a62ff);
  color: #fff;
}
.lic-btn--primary:hover { opacity: 0.88; }

.lic-btn--ghost {
  background: transparent;
  color: var(--muted, #5d6475);
  border: 1px solid var(--border, #d8deea);
}
.lic-btn--ghost:hover {
  background: var(--chip, #f0f2f7);
  color: var(--fg, #1a1a1a);
}

.lic-fade-enter-active,
.lic-fade-leave-active { transition: opacity 0.18s ease; }
.lic-fade-enter-from,
.lic-fade-leave-to { opacity: 0; }
</style>
