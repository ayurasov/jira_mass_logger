<!--
  Плашка «Доступна новая версия» над содержимым экрана. Появляется после автопроверки
  при запуске (или ручной проверки в настройках); «Обновить» ставит обновление сразу,
  «Позже» скрывает плашку для этой версии — в настройках обновление остаётся доступным.
-->
<script setup lang="ts">
import ActionIcon from './ActionIcon.vue';
import { useUpdatesStore } from '../store/updates';

const updates = useUpdatesStore();
</script>

<template>
  <div v-if="updates.busy || updates.showBanner" class="upd-banner" role="status">
    <ActionIcon :name="updates.busy ? 'refresh' : 'download'" :size="16" :class="{ 'upd-spin': updates.busy }" />
    <template v-if="updates.busy">
      <span class="upd-banner__text">{{ updates.progressText }}</span>
      <span class="upd-banner__bar"><span :style="{ width: (updates.progressPercent ?? 100) + '%' }" /></span>
    </template>
    <template v-else-if="updates.available">
      <!-- Установка не удалась (сеть, подпись не сошлась) — говорим об этом здесь же, а не только в настройках. -->
      <span v-if="updates.error" class="upd-banner__text upd-banner__text--error" :title="updates.error">{{ updates.error }}</span>
      <span v-else class="upd-banner__text">Доступна новая версия JiraTime <b>{{ updates.available.version }}</b></span>
      <router-link class="upd-banner__link" :to="{ name: 'settings', hash: '#updates' }">Что нового</router-link>
      <button class="upd-banner__btn" @click="updates.install()">{{ updates.error ? 'Повторить' : 'Обновить' }}</button>
      <button class="upd-banner__close" title="Напомнить о следующей версии" aria-label="Скрыть" @click="updates.dismiss()">
        <ActionIcon name="close" :size="14" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.upd-banner {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  /* справа место под индикатор синхронизации (fixed, правый верхний угол) */
  padding: 0.5rem 2.5rem 0.5rem 1.5rem;
  background: color-mix(in srgb, var(--primary) 9%, var(--card));
  border-bottom: 1px solid color-mix(in srgb, var(--primary) 30%, var(--border));
  color: var(--fg);
  font-size: 0.875rem;
}
.upd-banner > :first-child { color: var(--primary); flex-shrink: 0; }
.upd-banner__text { flex: 1 1 auto; min-width: 0; }
.upd-banner__text--error { color: var(--danger); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upd-banner__link { color: var(--primary); font-weight: 600; white-space: nowrap; }
.upd-banner__btn {
  border: none; border-radius: 0.5rem; padding: 0.35rem 0.85rem; font-weight: 600; font-size: 0.8125rem;
  background: var(--primary); color: #fff; cursor: pointer; white-space: nowrap;
}
.upd-banner__btn:hover { background: var(--primary-hover, var(--primary)); }
.upd-banner__close {
  border: none; background: transparent; color: var(--muted); cursor: pointer; padding: 0.2rem; border-radius: 0.35rem;
  display: inline-flex;
}
.upd-banner__close:hover { background: var(--chip); color: var(--fg); }
.upd-banner__bar { flex: 0 0 12rem; height: 6px; border-radius: 999px; background: var(--chip); overflow: hidden; }
.upd-banner__bar span { display: block; height: 100%; background: var(--primary); transition: width 200ms ease; }
.upd-spin { animation: upd-spin 1s linear infinite; }
@keyframes upd-spin { to { transform: rotate(360deg); } }
</style>
