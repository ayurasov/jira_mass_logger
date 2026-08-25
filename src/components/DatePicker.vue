<template>
  <div class="dp" ref="root">
    <input
      class="dp-input"
      type="text"
      :placeholder="placeholder"
      :value="displayValue"
      readonly
      :disabled="disabled"
      @click="toggleOpen"
    />
    <div v-if="open" class="dp-popover">
      <div class="dp-header">
        <button type="button" class="dp-nav" @click="shiftMonth(-1)">&lsaquo;</button>
        <span class="dp-title">{{ monthLabel }}</span>
        <button type="button" class="dp-nav" @click="shiftMonth(1)">&rsaquo;</button>
      </div>
      <div class="dp-weekdays">
        <span v-for="d in weekdayLabels" :key="d">{{ d }}</span>
      </div>
      <div class="dp-grid">
        <button
          v-for="(cell, i) in cells"
          :key="i"
          type="button"
          class="dp-cell"
          :class="{
            'dp-cell--muted': !cell.inMonth,
            'dp-cell--today': cell.iso === todayIso,
            'dp-cell--selected': cell.iso === modelValue,
          }"
          @click="select(cell.iso)"
        >{{ cell.day }}</button>
      </div>
      <div class="dp-footer">
        <button type="button" class="dp-today" @click="selectToday">Сегодня</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';

const props = defineProps<{ modelValue: string; placeholder?: string; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const weekdayLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function toIsoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseIsoLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

const todayIso = toIsoLocal(new Date());
const viewDate = ref<Date>(props.modelValue ? parseIsoLocal(props.modelValue) : new Date());

watch(() => props.modelValue, (v) => {
  if (v) viewDate.value = parseIsoLocal(v);
});

const displayValue = computed(() => {
  if (!props.modelValue) return '';
  const d = parseIsoLocal(props.modelValue);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
});

const monthLabel = computed(() => `${MONTHS_RU[viewDate.value.getMonth()]} ${viewDate.value.getFullYear()}`);

const cells = computed(() => {
  const year = viewDate.value.getFullYear();
  const month = viewDate.value.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const jsDow = firstOfMonth.getDay(); // 0=Вс..6=Сб
  const offset = jsDow === 0 ? 6 : jsDow - 1; // индекс от Пн
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { iso: toIsoLocal(d), day: d.getDate(), inMonth: d.getMonth() === month };
  });
});

function toggleOpen() {
  if (props.disabled) return;
  open.value = !open.value;
}
function shiftMonth(delta: number) {
  viewDate.value = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() + delta, 1);
}
function select(iso: string) {
  emit('update:modelValue', iso);
  open.value = false;
}
function selectToday() {
  select(todayIso);
}
function onClickOutside(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('mousedown', onClickOutside));
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside));
</script>

<style scoped>
.dp { position: relative; display: inline-block; min-width: 8rem; }
.dp-input { min-width: inherit; }
.dp-input {
  font: inherit;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--color-border, #d7dae0);
  border-radius: 0.4rem;
  color: var(--color-text, #1f2430);
  background: var(--color-surface, #fff);
  cursor: pointer;
  width: 100%;
}
.dp-input:disabled { background: var(--color-surface-alt, #f2f3f5); color: var(--color-text-muted, #6b7280); cursor: not-allowed; }
.dp-popover {
  position: absolute;
  top: calc(100% + 0.25rem);
  left: 0;
  z-index: 60;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 0.5rem;
  box-shadow: 0 0.75rem 2rem rgba(0,0,0,0.18);
  padding: 0.6rem;
  width: 17rem;
}
.dp-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; }
.dp-nav { border: none; background: transparent; font-size: 1.1rem; line-height: 1; padding: 0.2rem 0.5rem; cursor: pointer; border-radius: 0.3rem; color: var(--color-text, #1f2430); }
.dp-nav:hover { background: var(--color-surface-alt, #f2f3f5); }
.dp-title { font-weight: 600; font-size: 0.875rem; text-transform: capitalize; }
.dp-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; font-size: 0.7rem; color: var(--color-text-muted, #6b7280); margin-bottom: 0.2rem; }
.dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.15rem; }
.dp-cell { border: none; background: transparent; padding: 0.35rem 0; font-size: 0.8125rem; border-radius: 0.3rem; cursor: pointer; color: var(--color-text, #1f2430); }
.dp-cell:hover { background: var(--color-surface-alt, #f2f3f5); }
.dp-cell--muted { color: var(--color-text-muted, #b8bcc4); }
.dp-cell--today { font-weight: 700; box-shadow: inset 0 0 0 1px var(--color-primary, #3366ff); }
.dp-cell--selected { background: var(--color-primary, #3366ff); color: #fff; }
.dp-footer { margin-top: 0.4rem; text-align: center; }
.dp-today { border: none; background: transparent; color: var(--color-primary, #3366ff); font-size: 0.8125rem; cursor: pointer; padding: 0.2rem 0.5rem; }
.dp-today:hover { text-decoration: underline; }
</style>
