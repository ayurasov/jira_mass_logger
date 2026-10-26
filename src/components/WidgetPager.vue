<template>
  <!-- Компактный пейджер виджета: «11–20 из 57 · ‹ 2 / 6 › · по 10». Скрыт, когда всё помещается на одну страницу. -->
  <div v-if="pager.pages.value > 1" class="wp">
    <span class="wp__range">{{ pager.from.value }}–{{ pager.to.value }} из {{ total ?? pager.total.value }}</span>
    <div class="wp__nav">
      <button class="wp__btn" :disabled="pager.page.value <= 1" title="Предыдущая страница" @click="pager.go(pager.page.value - 1)">
        <ActionIcon name="chevron-left" :size="14" />
      </button>
      <span class="wp__page">{{ pager.page.value }} / {{ pager.pages.value }}</span>
      <button class="wp__btn" :disabled="pager.page.value >= pager.pages.value" title="Следующая страница" @click="pager.go(pager.page.value + 1)">
        <ActionIcon name="chevron-right" :size="14" />
      </button>
    </div>
    <label class="wp__size" title="Сколько строк на странице">
      по
      <select :value="pager.size.value" @change="pager.setSize(Number(($event.target as HTMLSelectElement).value))">
        <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
      </select>
    </label>
  </div>
</template>

<script setup lang="ts">
import ActionIcon from './ActionIcon.vue';
import { PAGE_SIZES, type Pager } from '../composables/usePager';

withDefaults(defineProps<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pager: Pager<any>;
  /** Полное число в Jira, если загружено не всё (подпись «из N»). */
  total?: number;
}>(), { total: undefined });
</script>

<style scoped>
.wp { display: flex; align-items: center; gap: 0.625rem; justify-content: flex-end; flex-wrap: wrap; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); font-size: 0.75rem; color: var(--muted); }
.wp__range { margin-right: auto; font-variant-numeric: tabular-nums; }
.wp__nav { display: inline-flex; align-items: center; gap: 0.25rem; }
.wp__page { min-width: 3rem; text-align: center; font-variant-numeric: tabular-nums; color: var(--fg); font-weight: 600; }
.wp__btn { display: inline-flex; align-items: center; justify-content: center; width: 1.625rem; height: 1.625rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--card); color: var(--fg); padding: 0; }
.wp__btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
.wp__btn:disabled { opacity: 0.4; cursor: default; }
.wp__size { display: inline-flex; align-items: center; gap: 0.3rem; }
.wp__size select { padding: 0.15rem 0.35rem; font-size: 0.75rem; }
</style>
