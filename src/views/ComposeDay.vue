<script setup lang="ts">
// «Собрать день»: автоматическое заполнение дня до цели — встречи календаря,
// привычные задачи и описания из прошлых записей. Любая правка (в таблице или
// перетаскиванием на шкале) фиксируется, остальное подстраивается под цель само.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import ActionIcon from '../components/ActionIcon.vue';
import OneClickFill from '../components/OneClickFill.vue';
import DatePicker from '../components/DatePicker.vue';
import { useComposeStore } from '../store/compose';
import { useLicenseStore } from '../store/license';
import { addDaysIso, formatRuDate, parseIsoDate } from '../utils/time';
import { describeHabit, findOverlaps, hhmmToMinutes, minutesToHHMM, startMinutesOf, type ProposalItem } from '../utils/dayComposer';

const store = useComposeStore();
const license = useLicenseStore();
const route = useRoute();

const WD_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WD_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const fmtDur = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h ? (mm ? `${h} ч ${mm} м` : `${h} ч`) : `${mm} м`;
};

onMounted(() => {
  const q = route.query.date as string | undefined;
  store.load(q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : store.date);
});

function setDate(d: string) { if (d && d !== store.date) store.load(d); }
function shiftDay(delta: number) { store.load(addDaysIso(store.date, delta)); }

// Цель и рабочее время — автоматическая пересборка (с небольшой задержкой на ввод).
let rebuildTimer: number | null = null;
watch(
  () => [store.targetHours, store.prefs.dayStart, store.prefs.dayEnd, store.prefs.lunchEnabled, store.prefs.lunchStart, store.prefs.lunchEnd],
  () => {
    if (store.loading) return;
    if (rebuildTimer) window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(() => store.rebuild(), 250);
  },
);
watch(() => [store.prefs.historyWeeks, store.prefs.useMeetings], () => store.load(store.date, false));

// ── Шкала дня (с перетаскиванием) ───────────────────────────────────
const scale = computed(() => {
  const starts = [hhmmToMinutes(store.prefs.dayStart), ...store.existing.map((w) => startMinutesOf(w.started)), ...store.proposal.map((p) => p.start)];
  const ends = [hhmmToMinutes(store.prefs.dayEnd), ...store.existing.map((w) => startMinutesOf(w.started) + w.timeSpentSeconds / 60), ...store.proposal.map((p) => p.start + p.minutes)];
  const from = Math.max(0, Math.floor(Math.min(...starts) / 60) * 60);
  const to = Math.min(24 * 60, Math.ceil(Math.max(...ends) / 60) * 60);
  return { from, to: Math.max(to, from + 60) };
});
const pct = (m: number) => ((m - scale.value.from) / (scale.value.to - scale.value.from)) * 100;
const hours = computed(() => {
  const out: number[] = [];
  for (let m = scale.value.from; m <= scale.value.to; m += 60) out.push(m);
  return out;
});

const track = ref<HTMLElement | null>(null);
type DragMode = 'move' | 'start' | 'end';
const drag = ref<{ id: string; mode: DragMode; x0: number; start0: number; minutes0: number; start: number; minutes: number; scale: { from: number; to: number }; moved: boolean } | null>(null);

function onBlockDown(e: PointerEvent, p: ProposalItem, mode: DragMode) {
  if (e.button !== 0 || store.loading) return;
  e.preventDefault();
  e.stopPropagation();
  drag.value = { id: p.id, mode, x0: e.clientX, start0: p.start, minutes0: p.minutes, start: p.start, minutes: p.minutes, scale: { ...scale.value }, moved: false };
  // Слушаем всё окно: отпускание мыши вне блока/шкалы не должно «залипать» в перетаскивании.
  window.addEventListener('pointermove', onBlockMove);
  window.addEventListener('pointerup', onBlockUp);
  window.addEventListener('pointercancel', cancelDrag);
  window.addEventListener('blur', cancelDrag);
}
function stopListening() {
  window.removeEventListener('pointermove', onBlockMove);
  window.removeEventListener('pointerup', onBlockUp);
  window.removeEventListener('pointercancel', cancelDrag);
  window.removeEventListener('blur', cancelDrag);
}
function onBlockMove(e: PointerEvent) {
  const d = drag.value;
  if (!d || !track.value) return;
  const pxPerMin = track.value.clientWidth / (d.scale.to - d.scale.from);
  const delta = Math.round((e.clientX - d.x0) / pxPerMin / 15) * 15;
  if (delta !== 0) d.moved = true;
  if (d.mode === 'move') {
    d.start = Math.max(0, Math.min(24 * 60 - d.minutes0, d.start0 + delta));
  } else if (d.mode === 'end') {
    d.minutes = Math.max(15, Math.min(24 * 60 - d.start0, d.minutes0 + delta));
  } else {
    const start = Math.min(d.start0 + d.minutes0 - 15, Math.max(0, d.start0 + delta));
    d.start = start;
    d.minutes = d.start0 + d.minutes0 - start;
  }
}
function onBlockUp() {
  const d = drag.value;
  stopListening();
  drag.value = null;
  if (!d || !d.moved || !store.proposal.some((p) => p.id === d.id)) return;
  store.editItem(d.id, { start: d.start, minutes: d.minutes });
}
function cancelDrag() {
  stopListening();
  drag.value = null;
}
const shown = (p: ProposalItem) => (drag.value?.id === p.id ? { start: drag.value.start, minutes: drag.value.minutes } : p);
// Смена дня/перезагрузка — любое незавершённое перетаскивание сбрасываем.
watch(() => [store.date, store.loading], cancelDrag);
onBeforeUnmount(cancelDrag);

// Пересекающиеся блоки — в две дорожки, чтобы не рисовались друг на друге.
const lanes = computed(() => {
  const items = [
    ...store.existing.map((w) => ({ id: w.rowKey, start: startMinutesOf(w.started), end: startMinutesOf(w.started) + w.timeSpentSeconds / 60 })),
    ...store.proposal.map((p) => ({ id: p.id, start: shown(p).start, end: shown(p).start + shown(p).minutes })),
  ].sort((a, b) => a.start - b.start);
  const laneEnd = [-1, -1];
  const res = new Map<string, number>();
  let split = false;
  for (const it of items) {
    const lane = it.start >= laneEnd[0] ? 0 : it.start >= laneEnd[1] ? 1 : 0;
    if (lane === 1 || it.start < laneEnd[0]) split = true;
    laneEnd[lane] = Math.max(laneEnd[lane], it.end);
    res.set(it.id, lane);
  }
  return { of: (id: string) => res.get(id) ?? 0, split };
});
const laneStyle = (id: string) => (lanes.value.split
  ? { top: lanes.value.of(id) === 0 ? '3px' : '50%', bottom: lanes.value.of(id) === 0 ? '50%' : '3px' }
  : {});

const overlaps = computed(() => findOverlaps(store.proposal, store.existing));

// ── Итоги ───────────────────────────────────────────────────────────
const totalMinutes = computed(() => store.filledMinutes + store.proposedMinutes);
const diffMinutes = computed(() => totalMinutes.value - store.targetMinutes);
const barScale = computed(() => Math.max(store.targetMinutes, totalMinutes.value, 1));
const sorted = computed(() => [...store.proposal].sort((a, b) => a.start - b.start));

const invalidRows = computed(() =>
  store.proposal.filter((p) => !/^[A-Za-z][A-Za-z0-9_]+-\d+$/.test(p.issueKey.trim()) || !(p.minutes > 0)),
);
const guessedCount = computed(() => store.proposal.filter((p) => p.guessed).length);
const canSubmit = computed(() => !store.submitting && !store.loading && store.proposal.length > 0 && invalidRows.value.length === 0);

function setRowTime(id: string, value: string) {
  if (/^\d{2}:\d{2}$/.test(value)) store.editItem(id, { start: hhmmToMinutes(value) });
}
function setRowHours(id: string, value: string) {
  const h = Number(String(value).replace(',', '.'));
  if (h > 0 && h <= 24) store.editItem(id, { minutes: Math.round(h * 60) });
}

async function submit() {
  if (!license.guardWrite() || !canSubmit.value) return;
  try {
    await store.submit();
    // Полная автоматизация: после успешной отправки — сразу следующий незаполненный день.
    if (store.submitMessage?.ok && store.prefs.autoAdvance && store.nextUnfilled) {
      const next = store.nextUnfilled;
      window.setTimeout(() => store.load(next), 900);
    }
  } catch (e) {
    store.submitMessage = { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

const usedKeys = computed(() => new Set([...store.existing.map((w) => w.issueKey), ...store.proposal.map((p) => p.issueKey)]));
const dayLabel = (iso: string) => `${WD_SHORT[parseIsoDate(iso).getDay()]} ${formatRuDate(iso).slice(0, 5)}`;
</script>

<template>
  <div class="cd">
    <header class="cd-header">
      <div>
        <h1>Собрать день</h1>
        <p class="cd-sub">День собирается автоматически: встречи, привычные задачи и их обычные описания — ровно до цели. Двигайте и растягивайте блоки на шкале — остальное подстроится само.</p>
      </div>
    </header>

    <!-- Параметры -->
    <section class="cd-card cd-controls">
      <!-- Основное: день и цель; действия справа -->
      <div class="cd-controls__main">
        <div class="cd-field">
          <span class="cd-label">День</span>
          <div class="cd-date">
            <button class="cd-icon" title="Предыдущий день" @click="shiftDay(-1)"><ActionIcon name="chevron-left" :size="16" /></button>
            <DatePicker :model-value="store.date" class="cd-datepicker" @update:model-value="setDate" />
            <button class="cd-icon" title="Следующий день" @click="shiftDay(1)"><ActionIcon name="chevron-right" :size="16" /></button>
            <span class="cd-weekday" :class="{ 'is-off': !store.isWorkday }">{{ WD_FULL[parseIsoDate(store.date).getDay()] }}<template v-if="!store.isWorkday"> · выходной</template></span>
          </div>
        </div>

        <div class="cd-field">
          <span class="cd-label">Всего за день, ч</span>
          <div class="cd-target">
            <input v-model.number="store.targetHours" type="number" min="0.25" max="24" step="0.25" class="cd-num" />
            <div class="cd-seg">
              <button v-for="h in [4, 6, 8]" :key="h" class="cd-seg__btn" :class="{ 'is-on': store.targetHours === h }" @click="store.targetHours = h">{{ h }}</button>
            </div>
          </div>
        </div>

        <div class="cd-actions">
          <button class="cd-btn" :disabled="store.loading" title="Забыть правки и собрать день заново" @click="store.reset()">
            <ActionIcon name="sparkles" :size="15" /> Пересобрать
          </button>
          <button class="cd-btn" :disabled="store.refreshingHistory || store.loading" title="Загрузить worklog за окно истории из Jira" @click="store.refreshHistory()">
            <ActionIcon name="refresh" :size="15" :class="{ 'cd-spin': store.refreshingHistory }" /> История из Jira
          </button>
        </div>
      </div>

      <!-- Параметры сборки: одна спокойная строка -->
      <div class="cd-controls__params">
        <div class="cd-param">
          <span class="cd-param__label">Рабочее время</span>
          <div class="cd-range">
            <input v-model="store.prefs.dayStart" type="time" />
            <span class="cd-range__dash">—</span>
            <input v-model="store.prefs.dayEnd" type="time" />
          </div>
        </div>

        <div class="cd-param">
          <label class="cd-param__label cd-param__check"><input v-model="store.prefs.lunchEnabled" type="checkbox" /> Обед</label>
          <div class="cd-range" :class="{ 'is-off': !store.prefs.lunchEnabled }">
            <input v-model="store.prefs.lunchStart" type="time" :disabled="!store.prefs.lunchEnabled" />
            <span class="cd-range__dash">—</span>
            <input v-model="store.prefs.lunchEnd" type="time" :disabled="!store.prefs.lunchEnabled" />
          </div>
        </div>

        <div class="cd-param">
          <span class="cd-param__label">История</span>
          <select v-model.number="store.prefs.historyWeeks" class="cd-select">
            <option :value="2">2 недели</option>
            <option :value="4">4 недели</option>
            <option :value="6">6 недель</option>
            <option :value="8">8 недель</option>
          </select>
          <label class="cd-param__label cd-param__check cd-param__extra"><input v-model="store.prefs.useMeetings" type="checkbox" /> встречи календаря</label>
        </div>
      </div>
    </section>

    <!-- Незаполненные дни + «одним нажатием» -->
    <div v-if="store.unfilled.length || store.batch.results.length" class="cd-unfilled">
      <div class="cd-unfilled__row">
        <span v-if="store.unfilled.length" class="cd-muted cd-small">Не заполнено за 2 недели:</span>
        <span v-else class="cd-muted cd-small">За 2 недели всё заполнено.</span>
        <button
          v-for="d in store.unfilled" :key="d.date" class="cd-day-chip"
          :class="{ 'is-current': d.date === store.date }" @click="setDate(d.date)"
        >{{ dayLabel(d.date) }} <span>{{ fmtDur(d.minutes) }}</span></button>
      </div>
      <OneClickFill
        :dates="store.unfilled.map((d) => d.date)" :primary="false" compact
        :label="`Заполнить все пропуски · ${store.unfilled.length} ${store.unfilled.length === 1 ? 'день' : store.unfilled.length < 5 ? 'дня' : 'дней'}`"
        @open-day="setDate"
      />
    </div>
    <div v-if="store.favoriteFallback && !store.loading" class="cd-alert cd-alert--info">
      <ActionIcon name="info" :size="15" /> Истории списаний пока нет — предложена избранная задача {{ store.habits[0]?.issueKey }}. Проверьте задачи перед отправкой: пакетное заполнение такие дни пропускает.
    </div>

    <div v-if="store.error" class="cd-alert cd-alert--error"><ActionIcon name="warning" :size="15" /> {{ store.error }}</div>
    <div v-if="store.meetingsNote" class="cd-alert cd-alert--info"><ActionIcon name="info" :size="15" /> {{ store.meetingsNote }}</div>

    <!-- Итог + шкала + главная кнопка -->
    <section class="cd-card cd-summary" :class="{ 'cd-loading': store.loading }">
      <div class="cd-summary__nums">
        <div><span class="cd-dot cd-dot--done"></span>Уже заполнено <b>{{ fmtDur(store.filledMinutes) }}</b></div>
        <div><span class="cd-dot cd-dot--plan"></span>Предлагается <b>{{ fmtDur(store.proposedMinutes) }}</b></div>
        <div>Цель <b>{{ fmtDur(store.targetMinutes) }}</b></div>
        <div class="cd-summary__diff" :class="{ 'is-ok': Math.abs(diffMinutes) < 1, 'is-over': diffMinutes >= 1, 'is-under': diffMinutes <= -1 }">
          <template v-if="Math.abs(diffMinutes) < 1"><ActionIcon name="check-circle" :size="15" /> ровно по цели</template>
          <template v-else-if="diffMinutes > 0">перебор {{ fmtDur(diffMinutes) }}</template>
          <template v-else>не хватает {{ fmtDur(-diffMinutes) }}</template>
        </div>
        <button class="cd-btn cd-btn--primary cd-cta" :disabled="!canSubmit" @click="submit">
          <ActionIcon name="play" :size="14" />
          {{ store.submitting ? 'Отправка…' : store.proposal.length ? `Залогировать ${fmtDur(store.proposedMinutes)}` : 'Нечего отправлять' }}
        </button>
      </div>
      <div class="cd-bar">
        <span class="cd-bar__done" :style="{ width: (store.filledMinutes / barScale) * 100 + '%' }"></span>
        <span class="cd-bar__plan" :style="{ width: (store.proposedMinutes / barScale) * 100 + '%' }"></span>
        <span class="cd-bar__target" :style="{ left: (store.targetMinutes / barScale) * 100 + '%' }" title="Цель"></span>
      </div>

      <div class="cd-timeline">
        <div ref="track" class="cd-timeline__track" :class="{ 'is-dragging': !!drag }">
          <span
            v-if="store.prefs.lunchEnabled" class="cd-tl cd-tl--lunch"
            :style="{ left: pct(hhmmToMinutes(store.prefs.lunchStart)) + '%', width: pct(hhmmToMinutes(store.prefs.lunchEnd)) - pct(hhmmToMinutes(store.prefs.lunchStart)) + '%' }"
            title="Обед"
          ></span>
          <span
            v-for="w in store.existing" :key="w.rowKey" class="cd-tl cd-tl--done"
            :style="{ ...laneStyle(w.rowKey), left: pct(startMinutesOf(w.started)) + '%', width: pct(startMinutesOf(w.started) + w.timeSpentSeconds / 60) - pct(startMinutesOf(w.started)) + '%' }"
            :title="`${w.issueKey} · ${w.started.slice(11, 16)} · ${fmtDur(w.timeSpentSeconds / 60)} (уже залогировано)`"
          >{{ w.issueKey }}</span>
          <span
            v-for="p in store.proposal" :key="p.id" class="cd-tl cd-tl--plan"
            :class="{ 'cd-tl--meeting': p.source === 'meeting', 'cd-tl--bad': overlaps.has(p.id), 'cd-tl--locked': p.locked, 'cd-tl--active': drag?.id === p.id }"
            :style="{ ...laneStyle(p.id), left: pct(shown(p).start) + '%', width: pct(shown(p).start + shown(p).minutes) - pct(shown(p).start) + '%' }"
            :title="`${p.issueKey} · ${minutesToHHMM(shown(p).start)}–${minutesToHHMM(shown(p).start + shown(p).minutes)} · ${fmtDur(shown(p).minutes)}\nПеретащите, чтобы сдвинуть; края — чтобы изменить длительность`"
            @pointerdown="onBlockDown($event, p, 'move')"
          >
            <i class="cd-tl__h cd-tl__h--l" @pointerdown="onBlockDown($event, p, 'start')"></i>
            <span class="cd-tl__label">{{ p.issueKey }}<small v-if="drag?.id === p.id"> {{ minutesToHHMM(shown(p).start) }} · {{ fmtDur(shown(p).minutes) }}</small></span>
            <i class="cd-tl__h cd-tl__h--r" @pointerdown="onBlockDown($event, p, 'end')"></i>
          </span>
        </div>
        <div class="cd-timeline__hours">
          <span v-for="h in hours" :key="h" :style="{ left: pct(h) + '%' }">{{ minutesToHHMM(h) }}</span>
        </div>
      </div>
      <div class="cd-summary__foot">
        <span v-if="guessedCount" class="cd-warn"><ActionIcon name="warning" :size="13" /> {{ guessedCount }} {{ guessedCount === 1 ? 'встреча' : 'встречи' }} с задачей по умолчанию — проверьте</span>
        <span v-if="invalidRows.length" class="cd-err">Укажите задачу в строках без ключа.</span>
        <span v-if="store.submitMessage" :class="store.submitMessage.ok ? 'cd-ok' : 'cd-err'">
          {{ store.submitMessage.text }}
          <template v-if="store.submitMessage.ok && store.prefs.autoAdvance && store.nextUnfilled"> Открываю {{ dayLabel(store.nextUnfilled) }}…</template>
        </span>
        <label class="cd-check cd-check--sm cd-auto"><input v-model="store.prefs.autoAdvance" type="checkbox" @change="store.savePrefs()" /> после отправки — к следующему незаполненному дню</label>
      </div>
    </section>

    <div class="cd-grid">
      <!-- Предложение -->
      <section class="cd-card cd-plan">
        <div class="cd-plan__head">
          <h2>Предложение</h2>
          <button class="cd-btn cd-btn--sm" @click="store.addRow()">+ Строка</button>
        </div>

        <div v-if="store.existing.length" class="cd-existing">
          <div class="cd-existing__title">Уже залогировано</div>
          <div v-for="w in store.existing" :key="w.rowKey" class="cd-existing__row">
            <span class="mono">{{ w.started.slice(11, 16) }}</span>
            <b>{{ w.issueKey }}</b>
            <span class="cd-muted cd-ellipsis">{{ w.comment || w.issueSummary || '' }}</span>
            <span class="mono">{{ fmtDur(w.timeSpentSeconds / 60) }}</span>
          </div>
        </div>

        <div v-if="!store.loading && store.proposal.length === 0" class="cd-empty">
          <template v-if="store.targetMinutes > 0 && store.filledMinutes >= store.targetMinutes">
            <ActionIcon name="check-circle" :size="18" /> День уже заполнен — добавлять нечего.
            <button v-if="store.nextUnfilled" class="cd-btn cd-btn--sm" @click="setDate(store.nextUnfilled)">К {{ dayLabel(store.nextUnfilled) }} →</button>
          </template>
          <template v-else-if="!store.habits.length">
            Недостаточно истории, чтобы найти привычные задачи. Нажмите «История из Jira» или добавьте строку вручную.
          </template>
          <template v-else>Нажмите «Пересобрать», чтобы получить предложение.</template>
        </div>

        <table v-else class="cd-table">
          <colgroup>
            <col style="width: 7.25rem" /><col style="width: 4.75rem" />
            <col style="width: 8.75rem" /><col /><col style="width: 2.25rem" />
          </colgroup>
          <thead>
            <tr><th>Начало</th><th>Часы</th><th>Задача</th><th>Описание и основание</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="p in sorted" :key="p.id" :class="{ 'is-bad': overlaps.has(p.id) || !!store.rowErrors[p.id], 'is-guess': p.guessed }">
              <td><input :value="minutesToHHMM(p.start)" type="time" step="900" class="cd-time" @change="setRowTime(p.id, ($event.target as HTMLInputElement).value)" /></td>
              <td><input :value="(p.minutes / 60).toFixed(2).replace(/\.?0+$/, '')" type="number" min="0.25" step="0.25" class="cd-hours" @change="setRowHours(p.id, ($event.target as HTMLInputElement).value)" /></td>
              <td>
                <input :value="p.issueKey" class="cd-key" placeholder="ABC-123" list="cd-habit-keys" @change="store.editItem(p.id, { issueKey: ($event.target as HTMLInputElement).value })" />
                <small v-if="p.issueSummary" class="cd-muted cd-ellipsis">{{ p.issueSummary }}</small>
              </td>
              <td>
                <input
                  :value="p.comment" class="cd-comment" placeholder="Описание" :list="`cd-sugg-${p.id}`"
                  @change="store.editItem(p.id, { comment: ($event.target as HTMLInputElement).value })"
                />
                <datalist :id="`cd-sugg-${p.id}`">
                  <option v-for="c in store.suggestionsFor(p.issueKey)" :key="c" :value="c" />
                </datalist>
                <small class="cd-why">
                  <span class="cd-src" :class="'cd-src--' + p.source">{{ p.source === 'meeting' ? 'встреча' : p.source === 'habit' ? 'привычка' : 'вручную' }}</span>
                  <span v-if="p.locked" class="cd-src cd-src--locked" title="Строку правили — при пересборке она не меняется">правка</span>
                  <span class="cd-muted">{{ p.reason }}</span>
                  <span v-if="p.guessed" class="cd-warn">проверьте задачу</span>
                  <span v-if="overlaps.has(p.id)" class="cd-err">пересекается по времени</span>
                  <span v-if="store.rowErrors[p.id]" class="cd-err">{{ store.rowErrors[p.id] }}</span>
                </small>
              </td>
              <td><button class="cd-icon cd-icon--danger" title="Убрать (остальное подстроится)" @click="store.removeItem(p.id)"><ActionIcon name="close" :size="14" /></button></td>
            </tr>
          </tbody>
        </table>
        <datalist id="cd-habit-keys">
          <option v-for="h in store.habits" :key="h.issueKey" :value="h.issueKey">{{ h.issueSummary }}</option>
        </datalist>
      </section>

      <!-- Привычные задачи -->
      <aside class="cd-card cd-habits">
        <h2>Привычные задачи</h2>
        <p class="cd-muted cd-small">За {{ store.prefs.historyWeeks }} нед. до {{ formatRuDate(addDaysIso(store.date, -1)) }} · клик — добавить</p>
        <div v-if="!store.habits.length" class="cd-muted cd-small">Пока нет данных.</div>
        <button
          v-for="h in store.habits.slice(0, 12)" :key="h.issueKey" class="cd-habit"
          :class="{ 'is-used': usedKeys.has(h.issueKey) }" :title="h.typicalComment || h.issueSummary || ''"
          @click="store.addRow(h)"
        >
          <span class="cd-habit__top">
            <b>{{ h.issueKey }}</b>
            <span class="mono cd-muted">~{{ fmtDur(h.typicalMinutes) }} · {{ minutesToHHMM(h.typicalStart) }}</span>
          </span>
          <span v-if="h.issueSummary" class="cd-ellipsis cd-small">{{ h.issueSummary }}</span>
          <span class="cd-habit__freq"><span :style="{ width: Math.round(h.frequency * 100) + '%' }"></span></span>
          <span class="cd-small cd-muted">{{ describeHabit(h) }}</span>
        </button>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.cd { padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; max-width: 110rem; }
.cd-header h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.01em; }
.cd-sub { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.875rem; }
.cd-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 1rem 1.125rem; }
.cd-muted { color: var(--muted); }
.cd-small { font-size: 0.75rem; }
.cd-ellipsis { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; }
.cd-loading { opacity: 0.6; }

.cd-controls { display: flex; flex-direction: column; gap: 0; padding-top: 0.875rem; padding-bottom: 0.875rem; }
.cd-controls__main { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.75rem 2rem; padding-bottom: 0.875rem; border-bottom: 1px solid var(--border); }
/* Разделители между группами: у каждой группы левая граница со сдвигом -1px, а контейнер
   (сдвинут на ширину отступа и обрезает переполнение) прячет границу у первой группы строки —
   и при переносе на узком окне в начале строки не остаётся «висячей» черты. */
.cd-controls__params { display: flex; flex-wrap: wrap; align-items: center; row-gap: 0.5rem; margin: 0 0 0 -1rem; padding-top: 0.75rem; overflow: hidden; }
.cd-param { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0 1rem; margin-left: -1px; border-left: 1px solid var(--border); }
.cd-param__label { font-size: 0.8125rem; color: var(--muted); font-weight: 500; white-space: nowrap; }
.cd-param__check { display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer; }
.cd-param__check input { margin: 0; accent-color: var(--primary); }
.cd-range__dash { color: var(--muted); }
.cd-param__extra { margin-left: 0.5rem; }
.cd-select { padding: 0.3rem 0.5rem; font-size: 0.8125rem; }
.cd-weekday { margin-left: 0.25rem; font-size: 0.8125rem; color: var(--muted); white-space: nowrap; }
.cd-weekday.is-off { color: var(--warning); }
.cd-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden; }
.cd-seg__btn { border: none; background: var(--card); color: var(--muted); padding: 0 0.7rem; height: 2.125rem; font-weight: 600; font-size: 0.8125rem; font-variant-numeric: tabular-nums; }
.cd-seg__btn + .cd-seg__btn { border-left: 1px solid var(--border); }
.cd-seg__btn:hover { background: var(--chip); color: var(--fg); }
.cd-seg__btn.is-on { background: var(--primary-soft); color: var(--primary); }
.cd-field { display: flex; flex-direction: column; gap: 0.35rem; }
.cd-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
.cd-date, .cd-target, .cd-range { display: flex; align-items: center; gap: 0.375rem; }
.cd-range.is-off { opacity: 0.5; }
.cd-datepicker { width: 9.5rem; }
.cd-num { width: 4.5rem; height: 2.125rem; box-sizing: border-box; padding: 0.35rem 0.55rem; }
.cd-range input { padding: 0.3rem 0.45rem; font-size: 0.8125rem; font-variant-numeric: tabular-nums; }
.cd-check { display: inline-flex; gap: 0.4rem; align-items: center; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
.cd-check--sm { text-transform: none; letter-spacing: 0; font-weight: 500; }
.cd-actions { display: flex; gap: 0.5rem; margin-left: auto; }

.cd-btn { display: inline-flex; align-items: center; gap: 0.4rem; height: 2.125rem; box-sizing: border-box; border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 0.5rem; padding: 0 0.95rem; font-weight: 600; font-size: 0.875rem; }
.cd-btn:hover:not(:disabled) { background: var(--chip); }
.cd-btn--primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.cd-btn--primary:hover:not(:disabled) { background: var(--primary-hover); }
.cd-btn--sm { padding: 0.3rem 0.65rem; font-size: 0.8125rem; }
.cd-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cd-icon { display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border: none; border-radius: 0.5rem; background: transparent; color: var(--muted); }
.cd-icon:hover { background: var(--chip); color: var(--fg); }
.cd-icon--danger:hover { background: var(--color-danger-bg); color: var(--danger); }
.cd-spin { animation: cd-spin 0.9s linear infinite; }
@keyframes cd-spin { to { transform: rotate(360deg); } }

.cd-alert { display: flex; gap: 0.5rem; align-items: center; padding: 0.6rem 0.875rem; border-radius: 0.5rem; font-size: 0.875rem; }
.cd-alert--error { background: var(--color-danger-bg); color: var(--danger); }
.cd-alert--info { background: var(--chip); color: var(--fg); }

/* Итог */
.cd-summary { display: flex; flex-direction: column; gap: 0.75rem; transition: opacity 150ms ease; }
.cd-summary__nums { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; align-items: center; font-size: 0.875rem; color: var(--muted); }
.cd-summary__nums b { color: var(--fg); margin-left: 0.25rem; font-variant-numeric: tabular-nums; }
.cd-summary__diff { margin-left: auto; font-weight: 700; display: inline-flex; gap: 0.35rem; align-items: center; }
.cd-summary__diff.is-ok { color: var(--success); }
.cd-summary__diff.is-over { color: var(--primary-strong); }
.cd-summary__diff.is-under { color: var(--warning); }
.cd-dot { display: inline-block; width: 0.625rem; height: 0.625rem; border-radius: 3px; margin-right: 0.4rem; vertical-align: -1px; }
.cd-dot--done { background: var(--success); }
.cd-dot--plan { background: var(--primary); }
.cd-bar { position: relative; height: 0.625rem; border-radius: 999px; background: var(--chip); display: flex; overflow: visible; }
.cd-bar__done { background: var(--success); border-radius: 999px 0 0 999px; transition: width 200ms ease; }
.cd-bar__plan { background: repeating-linear-gradient(135deg, var(--primary) 0 6px, color-mix(in srgb, var(--primary) 70%, transparent) 6px 12px); transition: width 200ms ease; }
.cd-bar__target { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--fg); border-radius: 2px; transform: translateX(-1px); }

.cd-timeline { padding-top: 0.25rem; }
.cd-timeline__track { position: relative; height: 2.25rem; border-radius: 0.5rem; background: var(--surface-sunken); border: 1px solid var(--border); overflow: hidden; }
.cd-timeline__hours { position: relative; height: 1.1rem; margin-top: 0.25rem; }
.cd-timeline__hours span { position: absolute; transform: translateX(-50%); font-size: 0.6875rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.cd-timeline__hours span:first-child { transform: none; }
.cd-timeline__hours span:last-child { transform: translateX(-100%); }
.cd-tl { position: absolute; top: 3px; bottom: 3px; border-radius: 0.375rem; font-size: 0.6875rem; font-weight: 700; padding: 0 0.35rem; display: flex; align-items: center; overflow: hidden; white-space: nowrap; min-width: 3px; }
.cd-tl--lunch { top: 0; bottom: 0; border-radius: 0; background: repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--muted) 18%, transparent) 5px 7px); }
.cd-tl--done { background: color-mix(in srgb, var(--success) 22%, transparent); color: var(--success); border: 1px solid color-mix(in srgb, var(--success) 45%, transparent); }
.cd-tl--plan { background: color-mix(in srgb, var(--primary) 20%, transparent); color: var(--primary-strong); border: 1px dashed var(--primary); }
.cd-tl--meeting { border-style: solid; }
.cd-tl--bad { background: color-mix(in srgb, var(--danger) 20%, transparent); border-color: var(--danger); color: var(--danger); }

/* Предложение */
.cd-grid { display: grid; grid-template-columns: minmax(0, 1fr) 18rem; gap: 1rem; align-items: start; }
.cd-plan__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
.cd-plan h2, .cd-habits h2 { margin: 0; font-size: 1rem; }
.cd-existing { background: var(--surface-sunken); border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; }
.cd-existing__title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--success); margin-bottom: 0.25rem; }
.cd-existing__row { display: grid; grid-template-columns: 3rem 7rem 1fr auto; gap: 0.75rem; font-size: 0.8125rem; padding: 0.2rem 0; align-items: center; }
.cd-empty { display: flex; gap: 0.5rem; align-items: center; color: var(--muted); padding: 1.25rem 0.25rem; }

.cd-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; table-layout: fixed; }
.cd-table th { text-align: left; color: var(--muted); font-weight: 600; padding: 0.4rem 0.375rem; border-bottom: 1px solid var(--border); }
.cd-table td { padding: 0.375rem; border-bottom: 1px solid var(--border); vertical-align: top; }
.cd-table tr.is-off td { opacity: 0.45; }
.cd-table tr.is-bad td { background: color-mix(in srgb, var(--danger) 6%, transparent); }
.cd-table input:not([type="checkbox"]) { padding: 0.35rem 0.45rem; font-size: 0.8125rem; width: 100%; }
.cd-key { text-transform: uppercase; }
.cd-why { display: flex !important; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
.cd-table td small { display: block; margin-top: 0.15rem; font-size: 0.6875rem; }
.cd-src { display: inline-block; font-size: 0.6875rem; font-weight: 700; padding: 0.05rem 0.45rem; border-radius: 999px; }
.cd-src--meeting { background: var(--chip); color: var(--primary-strong); }
.cd-src--habit { background: var(--color-success-bg); color: var(--success); }
.cd-src--manual { background: var(--amber-bg); color: var(--amber-fg); }
.cd-err { color: var(--danger); font-size: 0.8125rem; }
.cd-ok { color: var(--success); font-size: 0.8125rem; font-weight: 600; }
.cd-footer { display: flex; justify-content: flex-end; align-items: center; gap: 1rem; margin-top: 0.875rem; flex-wrap: wrap; }

/* Привычные задачи */
.cd-habits { display: flex; flex-direction: column; gap: 0.5rem; }
.cd-habits p { margin: 0 0 0.25rem; }
.cd-habit { display: flex; flex-direction: column; gap: 0.2rem; text-align: left; border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 0.5rem; padding: 0.5rem 0.625rem; transition: border-color 120ms ease, transform 80ms ease; }
.cd-habit:hover { border-color: var(--primary); transform: translateY(-1px); }
.cd-habit.is-used { opacity: 0.55; }
.cd-habit__top { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.8125rem; }
.cd-habit__freq { height: 3px; border-radius: 999px; background: var(--chip); overflow: hidden; }
.cd-habit__freq span { display: block; height: 100%; background: var(--success); }

@media (max-width: 72rem) {
  .cd-grid { grid-template-columns: 1fr; }
  .cd-actions { margin-left: 0; }
}
/* v2: интерактивная шкала, незаполненные дни, CTA */
.cd-cta { margin-left: 0.5rem; }
.cd-summary__foot { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; font-size: 0.8125rem; }
.cd-auto { margin-left: auto; }
.cd-warn { color: var(--amber-fg); background: var(--amber-bg); border-radius: 999px; padding: 0.05rem 0.5rem; font-size: 0.75rem; display: inline-flex; gap: 0.3rem; align-items: center; }
.cd-unfilled { display: flex; flex-direction: column; gap: 0.5rem; }
.cd-unfilled__row { display: flex; flex-wrap: wrap; gap: 0.375rem; align-items: center; }
.cd-day-chip { border: 1px dashed color-mix(in srgb, var(--warning) 60%, var(--border)); background: var(--card); color: var(--fg); border-radius: 999px; padding: 0.2rem 0.65rem; font-size: 0.8125rem; font-weight: 600; }
.cd-day-chip span { color: var(--muted); font-weight: 500; margin-left: 0.25rem; }
.cd-day-chip:hover { border-style: solid; border-color: var(--primary); }
.cd-day-chip.is-current { background: var(--chip); border-style: solid; border-color: var(--primary); }
.cd-timeline__track { height: 3rem !important; user-select: none; touch-action: none; }
.cd-tl--plan { cursor: grab; padding: 0 0.5rem; }
.cd-timeline__track.is-dragging .cd-tl--plan { cursor: grabbing; }
.cd-tl--locked { border-style: solid; box-shadow: inset 0 -2px 0 var(--primary); }
.cd-tl--active { z-index: 3; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18); }
.cd-tl__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
.cd-tl__label small { font-weight: 600; opacity: 0.85; }
.cd-tl__h { position: absolute; top: 0; bottom: 0; width: 7px; cursor: ew-resize; }
.cd-tl__h--l { left: 0; }
.cd-tl__h--r { right: 0; }
.cd-tl__h::after { content: ''; position: absolute; top: 30%; bottom: 30%; left: 2px; width: 2px; border-radius: 2px; background: currentColor; opacity: 0; transition: opacity 120ms ease; }
.cd-tl--plan:hover .cd-tl__h::after { opacity: 0.6; }
.cd-src--locked { background: color-mix(in srgb, var(--primary) 14%, transparent); color: var(--primary-strong); }
.cd-table tr.is-guess td { background: color-mix(in srgb, var(--warning) 7%, transparent); }
</style>
