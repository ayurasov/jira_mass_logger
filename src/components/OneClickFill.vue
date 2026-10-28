<template>
  <!-- «Одним нажатием»: собрать и отправить все переданные дни; прогресс, итог по дням, отмена. -->
  <div class="ocf" :class="{ 'ocf--compact': compact }">
    <button
      v-if="dates.length || store.batch.running"
      class="ocf__btn" :class="{ 'ocf__btn--primary': primary }"
      :disabled="!dates.length || store.batch.running || store.undoing"
      :title="dates.length ? `Собрать и залогировать: ${dates.map(dayLabel).join(', ')}` : 'Незаполненных дней нет'"
      @click="run"
    >
      <ActionIcon :name="store.batch.running ? 'refresh' : 'bolt'" :size="15" :class="{ 'ocf__spin': store.batch.running }" />
      <template v-if="store.batch.running">Заполняю {{ store.batch.done + 1 }} из {{ store.batch.total }}…</template>
      <template v-else>{{ label }}</template>
    </button>

    <div v-if="showResults && results.length" class="ocf__result" :class="allOk ? 'is-ok' : 'is-partial'">
      <div class="ocf__head">
        <span class="ocf__title">
          <ActionIcon :name="allOk ? 'check-circle' : 'info'" :size="15" />
          Заполнено {{ okDays }} из {{ results.length }} {{ plural(results.length, 'дня', 'дней', 'дней') }} · {{ fmtDur(totalMinutes) }}
        </span>
        <span class="ocf__actions">
          <button
            v-if="store.lastBatchCreated.length" class="ocf__link" :disabled="store.undoing"
            title="Удалить в Jira все записи, созданные этим заполнением" @click="undo"
          >{{ store.undoing ? 'Отмена…' : 'Отменить заполнение' }}</button>
          <button class="ocf__link ocf__link--muted" title="Скрыть итог" @click="showResults = false">Скрыть</button>
        </span>
      </div>
      <ul class="ocf__list">
        <li v-for="r in results" :key="r.date" :class="r.ok ? 'is-ok' : 'is-skip'">
          <button class="ocf__day" title="Открыть день" @click="$emit('open-day', r.date)">{{ dayLabel(r.date) }}</button>
          <span v-if="r.ok">{{ fmtDur(r.minutes) }} · {{ r.entries }} {{ plural(r.entries, 'запись', 'записи', 'записей') }}<template v-if="r.message"> · {{ r.message }}</template></span>
          <span v-else>пропущен: {{ r.message }}</span>
        </li>
      </ul>
    </div>
    <div v-if="undoMessage" class="ocf__undo-msg">{{ undoMessage }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import ActionIcon from './ActionIcon.vue';
import { useComposeStore } from '../store/compose';
import { useLicenseStore } from '../store/license';
import { formatRuDate, parseIsoDate } from '../utils/time';

const props = withDefaults(defineProps<{
  dates: string[];
  label?: string;
  primary?: boolean;
  compact?: boolean;
}>(), { label: 'Заполнить все пропуски', primary: true, compact: false });
defineEmits<{ (e: 'open-day', date: string): void }>();

const store = useComposeStore();
const license = useLicenseStore();
const showResults = ref(false);
const undoMessage = ref('');

const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const dayLabel = (iso: string) => `${WD[parseIsoDate(iso).getDay()]} ${formatRuDate(iso).slice(0, 5)}`;
const fmtDur = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h && mm ? `${h} ч ${mm} м` : h ? `${h} ч` : `${mm} м`;
};
function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const results = computed(() => store.batch.results);
const okDays = computed(() => results.value.filter((r) => r.ok).length);
const allOk = computed(() => okDays.value === results.value.length);
const totalMinutes = computed(() => results.value.reduce((s, r) => s + r.minutes, 0));

async function run() {
  if (!license.guardWrite()) return;
  undoMessage.value = '';
  showResults.value = true;
  await store.fillDays(props.dates);
}

async function undo() {
  const { removed, failed } = await store.undoLastBatch();
  undoMessage.value = failed
    ? `Удалено ${removed}, не удалось удалить ${failed} — повторите отмену.`
    : `Заполнение отменено: удалено ${removed} ${plural(removed, 'запись', 'записи', 'записей')}.`;
  if (!failed) showResults.value = false;
}
</script>

<style scoped>
.ocf { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.ocf__btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem; align-self: flex-start;
  height: 2.25rem; padding: 0 1rem; border-radius: 0.5rem; border: 1px solid var(--border);
  background: var(--card); color: var(--fg); font-weight: 600; font-size: 0.875rem; white-space: nowrap;
}
.ocf__btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
.ocf__btn--primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.ocf__btn--primary:hover:not(:disabled) { background: var(--primary-hover); color: #fff; }
.ocf__btn:disabled { opacity: 0.55; cursor: not-allowed; }
.ocf__spin { animation: ocf-spin 0.9s linear infinite; }
@keyframes ocf-spin { to { transform: rotate(360deg); } }

.ocf__result { border: 1px solid var(--border); border-radius: 0.625rem; padding: 0.625rem 0.75rem; background: var(--card); font-size: 0.8125rem; }
.ocf__result.is-ok { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); }
.ocf__result.is-partial { border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); }
.ocf__head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.ocf__title { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 600; }
.is-ok .ocf__title { color: var(--success); }
.is-partial .ocf__title { color: var(--amber-fg); }
.ocf__actions { display: inline-flex; gap: 0.75rem; }
.ocf__link { border: none; background: none; padding: 0; color: var(--primary); font-weight: 600; font-size: 0.8125rem; }
.ocf__link:disabled { opacity: 0.5; }
.ocf__link--muted { color: var(--muted); font-weight: 500; }
.ocf__list { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.ocf__list li { display: flex; gap: 0.6rem; align-items: baseline; }
.ocf__list li.is-skip { color: var(--muted); }
.ocf__day { border: none; background: none; padding: 0; min-width: 4.25rem; text-align: left; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.ocf__day:hover { color: var(--primary); text-decoration: underline; }
.ocf__undo-msg { font-size: 0.8125rem; color: var(--muted); }
.ocf--compact .ocf__btn { height: 2rem; padding: 0 0.8rem; font-size: 0.8125rem; }
</style>
