<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import DatePicker from '../components/DatePicker.vue';
import { useDayFromCalendarStore } from '../store/dayFromCalendar';
import { tauriApi } from '../lib/tauriApi';
import { useJiraProfilesStore } from '../store/jiraProfiles';
import { useSettingsStore } from '../store/settings';
import { useFavoriteTasksStore } from '../store/favoriteTasks';
import ActionIcon from '../components/ActionIcon.vue';
import { useLicenseStore } from '../store/license';

const store = useDayFromCalendarStore();
const router = useRouter();
const settings = useSettingsStore();
const jiraStore = useJiraProfilesStore();
const favorites = useFavoriteTasksStore();
const license = useLicenseStore();

const selectedDate = ref(new Date().toISOString().slice(0, 10));
const issueSearchMap = ref<Record<number, string>>({});
const issueOptionsMap = ref<Record<number, { key: string; summary: string }[]>>({});
let searchTimer: number | null = null;

function fmtDateRu(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short' }).format(d);
}

function fmtHours(sec: number): string {
  return (sec / 3600).toFixed(2);
}

onMounted(async () => {
  await jiraStore.ensureLoaded();
  try {
    const saved = localStorage.getItem('jiratime-calendar-date');
    if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved)) selectedDate.value = saved;
  } catch { /* private mode */ }
  await store.loadDay(selectedDate.value);
});

function fmtTime(iso: string): string {
  const dt = new Date(iso);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: settings.timezone,
    hour: '2-digit', minute: '2-digit',
  }).format(dt);
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

function timelineTop(iso: string): number {
  const dt = new Date(iso);
  const tz = settings.timezone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(dt).map((p) => [p.type, p.value]),
  );
  const h = Number(parts.hour) % 24;
  const m = Number(parts.minute);
  return ((h * 60 + m - 8 * 60) / (12 * 60)) * 100; // 08:00–20:00 window
}

function timelineHeight(sec: number): number {
  return Math.max(2, (sec / (12 * 3600)) * 100);
}

async function searchIssues(idx: number, q: string) {
  issueSearchMap.value[idx] = q;
  if (searchTimer) window.clearTimeout(searchTimer);
  if (q.length < 2) { issueOptionsMap.value[idx] = []; return; }
  // Дебаунс 350мс — не перегружаем Jira на каждый символ
  searchTimer = window.setTimeout(async () => {
    const params = jiraStore.activeConnectionParams;
    if (!params) return;
    try {
      // Если запрос похож на ключ задачи (ABC-123) — ищем по ключу точно,
      // иначе обычный полнотекстовый поиск по text.
      const trimmed = q.trim();
      const isIssueKey = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(trimmed);
      const jql = isIssueKey
        ? `key = "${trimmed.toUpperCase()}" ORDER BY updated DESC`
        : `text ~ "${trimmed}" ORDER BY updated DESC`;
      const res = await tauriApi.getIssuesByJql(params, jql);
      issueOptionsMap.value[idx] = res.map((i) => ({ key: i.key, summary: i.summary ?? '' }));
    } catch {
      issueOptionsMap.value[idx] = [];
    }
  }, 350);
}

function selectIssue(idx: number, key: string, summary: string) {
  store.setIssueForRow(idx, key, summary);
  issueOptionsMap.value[idx] = [];
  issueSearchMap.value[idx] = '';
}
function selectFavorite(idx: number, key: string, summary: string | null | undefined) {
  store.setIssueForRow(idx, key, summary ?? null);
}

// Вставить любимую задачу в первую свободную (без выбранной задачи) встречу.
function applyFavorite(key: string, summary: string | null | undefined) {
  const idx = store.rows.findIndex((r) => !r.selectedIssueKey);
  if (idx >= 0) {
    store.setIssueForRow(idx, key, summary ?? null);
  } else {
    // Все строки уже имеют задачу — просто запоминаем выбор для следующей.
    favorites.touch(key, summary ?? null);
  }
}

async function logSingle(idx: number) {
  if (!license.guardWrite()) return;
  await store.logSingleRow(idx);
}

function navigateDay(delta: number) {
  const next = new Date(selectedDate.value + 'T12:00:00Z');
  next.setUTCDate(next.getUTCDate() + delta);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  selectedDate.value = `${y}-${m}-${d}`;
  store.loadDay(selectedDate.value);
}

const weekRefreshing = ref(false);
async function refreshWeek() {
  weekRefreshing.value = true;
  try {
    // Полная ресинхронизация недели с Jira, затем перезагрузка дня, чтобы
  // дедуп (existingKeys/existingDayWorklogs) сбросился: записи, удалённые в
  // Jira напрямую, больше не блокируют повторное логирование этого события.
    await store.refreshWeekFromJira();
    await store.loadDay(selectedDate.value);
  } finally {
    weekRefreshing.value = false;
  }
}

function goToday() {
  selectedDate.value = new Date().toISOString().slice(0, 10);
  store.loadDay(selectedDate.value);
}

function selectWeekDay(date: string) {
  selectedDate.value = date;
  store.loadDay(date);
}

function goToBulkPreview() {
  if (!license.guardWrite()) return;
  store.buildBulkPreview();
  router.push('/calendar/preview');
}

const uncoveredHours = computed(() => fmtDuration(store.uncoveredSeconds));
</script>

<template>
  <div class="day-calendar">
    <!-- Header -->
    <div class="day-header">
      <h2><ActionIcon name="clock" :size="20" /> День из календаря</h2>
      <div class="day-controls">
        <div class="day-nav">
          <button @click="navigateDay(-1)" class="nav-btn" title="Предыдущий день"><ActionIcon name="chevron-left" :size="14" /></button>
          <button @click="goToday" class="nav-today" title="Сегодня">Сегодня</button>
          <button @click="navigateDay(1)" class="nav-btn" title="Следующий день"><ActionIcon name="chevron-right" :size="14" /></button>
        </div>
        <DatePicker v-model="selectedDate"
          @update:modelValue="store.loadDay(selectedDate)" class="date-picker" />
        <button @click="store.loadDay(selectedDate, true)" :disabled="store.loading" class="btn-refresh">
          <ActionIcon name="refresh" :size="14" /> Обновить
        </button>
        <button @click="refreshWeek" :disabled="weekRefreshing || store.loading" class="btn-refresh"
          title="Полностью ресинхронизировать worklog всей недели с Jira: удалённые в Jira записи и дубли в кэше пропадут">
          <ActionIcon name="refresh" :size="14" /> {{ weekRefreshing ? 'Обновление недели…' : 'Обновить неделю из Jira' }}
        </button>
        <select
          :value="store.roundingStepMinutes"
          @change="store.setRoundingStep(Number(($event.target as HTMLSelectElement).value))"
          class="rounding-select"
          title="Шаг округления длительности встречи">
          <option :value="15">округление 15 мин</option>
          <option :value="30">округление 30 мин</option>
        </select>
      </div>
    </div>

    <!-- Баннер режима просмотра -->
    <div v-if="!license.isActive" class="license-banner">
      <ActionIcon name="warning" :size="15" />
      Работаете в <strong>режиме просмотра</strong> — логирование в Jira недоступно.
      <button class="license-banner__btn" @click="license.openActivation">Активировать</button>
    </div>

    <!-- Week summary panel -->
    <div class="week-panel" v-if="store.weekSummary.length > 0">
      <div class="week-panel__head">
        <span class="week-panel__title">Неделя {{ store.weekStart }} — {{ store.weekEnd }}</span>
        <span class="week-panel__total">Итого: {{ fmtHours(store.weekTotalSeconds) }} ч</span>
      </div>
      <div class="week-grid">
        <button
          v-for="day in store.weekSummary"
          :key="day.date"
          class="week-day"
          :class="{ 'week-day--active': day.date === selectedDate, 'week-day--empty': day.items.length === 0 }"
          @click="selectWeekDay(day.date)">
          <span class="week-day__dow">{{ day.weekday.slice(0, 3) }}</span>
          <span class="week-day__date">{{ fmtDateRu(day.date) }}</span>
          <span class="week-day__hours" :class="{ zero: day.totalSeconds === 0 }">{{ fmtHours(day.totalSeconds) }} ч</span>
          <span class="week-day__tasks" v-if="day.items.length > 0">
            {{ day.items.length }} задач{{ day.items.length > 1 ? 'и' : 'а' }}
          </span>
          <span class="week-day__tasks week-day__tasks--empty" v-else>нет записей</span>
        </button>
      </div>
      <!-- Detailed task list for selected day -->
      <div class="week-tasks" v-if="store.weekSummary.find(d => d.date === selectedDate)?.items.length">
        <h4>Залогировано за {{ fmtDateRu(selectedDate) }}:</h4>
        <ul class="task-list">
          <li v-for="(it, i) in store.weekSummary.find(d => d.date === selectedDate)?.items" :key="i" class="task-list__item">
            <span class="task-list__key">{{ it.issueKey }}</span>
            <span class="task-list__hours">{{ fmtHours(it.seconds) }} ч</span>
            <span class="task-list__comment" v-if="it.comment">{{ it.comment }}</span>
          </li>
        </ul>
      </div>
    </div>
    <div class="coverage-bar"
      :class="{ ok: store.uncoveredSeconds === 0, warn: store.uncoveredSeconds > 0 }">
      <span>
        Покрыто: {{ fmtDuration(store.coveredSeconds) }} / {{ store.workHoursPerDay }}ч
        <template v-if="store.uncoveredSeconds > 0">
          · <ActionIcon name="warning" :size="13" /> Не залогировано ещё {{ uncoveredHours }}
        </template>
        <template v-else>
          · <ActionIcon name="check-circle" :size="13" /> Норма выполнена
        </template>
      </span>
      <button v-if="store.rows.length > 0" @click="goToBulkPreview" class="btn-bulk">
        Затянуть весь день →
      </button>
    </div>

    <div v-if="store.loading" class="loading">Загрузка встреч…</div>
    <div v-if="store.error" class="error">{{ store.error }}</div>
    <div v-if="!store.loading && store.rows.length === 0 && !store.error" class="empty">
      Встреч на выбранный день нет.
    </div>

    <!-- Любимые задачи: автоподбор из последних 90 дней -->
    <div v-if="favorites.has" class="fav-panel">
      <div class="fav-panel__head">
        <span class="fav-panel__title"><ActionIcon name="star" :size="14" /> Любимые задачи</span>
        <span class="fav-panel__hint">автоподбор из последних 3 мес. · нажмите, чтобы вставить в первую свободную встречу</span>
      </div>
      <div class="fav-panel__chips">
        <button
          v-for="f in favorites.items"
          :key="f.issueKey"
          class="fav-chip"
          :title="f.issueSummary || f.issueKey"
          @click="applyFavorite(f.issueKey, f.issueSummary)">
          {{ f.issueKey }}
          <span class="fav-chip__summary" v-if="f.issueSummary">{{ f.issueSummary }}</span>
          <span class="fav-chip__remove" @click.stop="favorites.remove(f.issueKey)" title="Убрать из избранного"><ActionIcon name="close" :size="11" /></span>
        </button>
      </div>
    </div>

    <!-- Main layout: timeline + rows -->
    <div v-if="store.rows.length > 0" class="calendar-layout">
      <!-- Timeline column -->
      <div class="timeline-col">
        <div class="timeline-axis">
          <div
            v-for="h in [8,9,10,11,12,13,14,15,16,17,18,19,20]"
            :key="h"
            class="timeline-hour"
            :style="{ top: ((h - 8) / 12 * 100) + '%' }">
            {{ String(h).padStart(2, '0') }}:00
          </div>
        </div>
        <div class="timeline-events">
          <div
            v-for="(row, idx) in store.rows"
            :key="row.event.id"
            class="timeline-block"
            :class="{ logged: row.logged, 'has-error': !!row.logError }"
            :style="{
              top: timelineTop(row.event.startAt) + '%',
              height: timelineHeight(row.roundedSeconds) + '%',
            }"
            :title="row.event.subject">
            {{ fmtTime(row.event.startAt) }}
          </div>
        </div>
      </div>

      <!-- Rows list -->
      <div class="rows-col">
        <div
          v-for="(row, idx) in store.rows"
          :key="row.event.id"
          class="meeting-row"
          :class="{ logged: row.logged }">

          <!-- Time + subject -->
          <div class="meeting-info">
            <span class="meeting-time">
              {{ fmtTime(row.event.startAt) }} – {{ fmtTime(row.event.endAt) }}
            </span>
            <span class="meeting-dur">({{ fmtDuration(row.roundedSeconds) }})</span>
            <span class="meeting-subject">{{ row.event.subject }}</span>
            <span
              v-if="row.suggestion && row.suggestion.source !== 'none'"
              class="match-badge"
              :class="row.suggestion.source">
              {{ row.suggestion.source }}
            </span>
          </div>

          <!-- Issue picker -->
          <div class="issue-row">
            <!-- Любимые задачи: быстрый выбор без поиска -->
            <div v-if="favorites.has && !row.selectedIssueKey" class="favorites-bar">
              <button
                v-for="f in favorites.items"
                :key="f.issueKey"
                class="fav-chip"
                :title="f.issueSummary || f.issueKey"
                @click="selectFavorite(idx, f.issueKey, f.issueSummary)">
                {{ f.issueKey }}
                <span class="fav-chip__remove" @click.stop="favorites.remove(f.issueKey)" title="Убрать из избранного"><ActionIcon name="close" :size="11" /></span>
              </button>
            </div>
            <span v-if="row.selectedIssueKey" class="issue-chip">
              {{ row.selectedIssueKey }}
              <span v-if="row.selectedIssueSummary" class="issue-summary">
                {{ row.selectedIssueSummary }}
              </span>
              <button @click="store.setIssueForRow(idx, '', null)" class="btn-clear"><ActionIcon name="close" :size="12" /></button>
              <button
                :class="['btn-star', favorites.isFavorite(row.selectedIssueKey) ? 'is-fav' : '']"
                :title="favorites.isFavorite(row.selectedIssueKey) ? 'В избранном' : 'Добавить в избранное'"
                @click="favorites.toggle(row.selectedIssueKey, row.selectedIssueSummary)"><ActionIcon :name="favorites.isFavorite(row.selectedIssueKey) ? 'star' : 'star-outline'" :size="13" /></button>
            </span>
            <div class="issue-search-wrap" v-if="!row.selectedIssueKey">
              <input
                type="text"
                :value="issueSearchMap[idx] ?? ''"
                @input="searchIssues(idx, ($event.target as HTMLInputElement).value)"
                placeholder="Поиск задачи: текст или ключ ABC-123…"
                class="issue-search" />
              <div v-if="(issueOptionsMap[idx] ?? []).length > 0" class="issue-dropdown">
                <div
                  v-for="opt in issueOptionsMap[idx]"
                  :key="opt.key"
                  @click="selectIssue(idx, opt.key, opt.summary)"
                  class="issue-option">
                  <strong>{{ opt.key }}</strong> {{ opt.summary }}
                </div>
              </div>
            </div>
            <input v-model="row.comment" class="comment-input" placeholder="Комментарий…" />
          </div>

          <!-- Actions -->
          <div class="row-actions">
            <button
              @click="logSingle(idx)"
              :disabled="!row.selectedIssueKey || row.logged || !license.isActive"
              class="btn-log"
              :class="{ 'btn-log--locked': !license.isActive }">
              <ActionIcon :name="row.logged ? 'check-circle' : (license.isActive ? 'play' : 'key')" :size="13" />
              {{ row.logged ? 'Залогировано' : (license.isActive ? 'В worklog' : 'Нужна лицензия') }}
            </button>
            <span v-if="row.logError" class="row-error">{{ row.logError }}</span>
            <span v-else-if="row.dedupWarning" class="row-warning"><ActionIcon name="warning" :size="12" /> {{ row.dedupWarning }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.day-calendar { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.day-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.day-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.day-nav { display: flex; gap: 4px; align-items: center; }
.nav-btn { width: 30px; height: 28px; border: 1px solid var(--border, #ddd); background: var(--bg-elev, #fff); border-radius: 4px; cursor: pointer; font-size: 12px; }
.nav-btn:hover { background: var(--bg-hover, #f0f0f0); }
.nav-today { height: 28px; padding: 0 10px; border: 1px solid var(--border, #ddd); background: var(--bg-elev, #fff); border-radius: 4px; cursor: pointer; font-size: 12px; }
.nav-today:hover { background: var(--bg-hover, #f0f0f0); }

.license-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 1rem;
  background: #fff8e1;
  border: 1px solid #ffe082;
  border-radius: 0.5rem;
  font-size: 0.87rem;
  color: #7a5400;
}
.license-banner__btn {
  margin-left: auto;
  padding: 0.25rem 0.75rem;
  border-radius: 0.4rem;
  border: 1px solid #f59e0b;
  background: #fef3c7;
  color: #92400e;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}
.license-banner__btn:hover { background: #fde68a; }

.week-panel { background: var(--bg-elev, #fff); border: 1px solid var(--border, #ddd); border-radius: 8px; padding: 12px; }
.week-panel__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.week-panel__title { font-weight: 600; font-size: 13px; color: var(--text, #333); }
.week-panel__total { font-size: 13px; color: var(--accent, #0891b2); font-weight: 600; }
.week-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
.week-day { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 4px; border: 1px solid var(--border, #e5e5e5); border-radius: 6px; background: var(--bg, #fafafa); cursor: pointer; transition: all 0.15s; }
.week-day:hover { border-color: var(--accent, #0891b2); background: var(--bg-hover, #f0f7fa); }
.week-day--active { border-color: var(--accent, #0891b2); background: var(--bg-hover, #e0f2fe); }
.week-day--empty { opacity: 0.6; }
.week-day__dow { font-size: 10px; color: var(--text-muted, #888); text-transform: uppercase; }
.week-day__date { font-size: 13px; font-weight: 600; color: var(--text, #333); }
.week-day__hours { font-size: 12px; font-weight: 600; color: var(--accent, #0891b2); }
.week-day__hours.zero { color: var(--text-muted, #aaa); }
.week-day__tasks { font-size: 10px; color: var(--text-muted, #888); }
.week-day__tasks--empty { color: var(--text-faint, #ccc); }
.week-tasks { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border, #eee); }
.week-tasks h4 { margin: 0 0 6px; font-size: 12px; color: var(--text, #333); }
.task-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.task-list__item { display: flex; gap: 8px; align-items: center; font-size: 12px; padding: 4px 6px; background: var(--bg, #f9f9f9); border-radius: 4px; }
.task-list__key { font-weight: 700; color: var(--accent, #0891b2); min-width: 90px; }
.task-list__hours { font-weight: 600; color: var(--text, #333); min-width: 60px; }
.task-list__comment { color: var(--text-muted, #666); }

/* Убираем собственную рамку/паддинг обёртки под DatePicker — рамку рисует
   внутренний .dp-trigger компонента DatePicker, а обёртке нужна только
   фиксированная inline-ширина, чтобы .dp (width: 100%) не растягивался и не
   расталкивал кнопки/select на новую строку внутри .day-controls. */
.date-picker {
  flex: 0 0 auto;
  width: 9rem;
  border: none;
  padding: 0;
  border-radius: 0;
  background: transparent;
}
.rounding-select { padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border, #ddd); flex: 0 0 auto; }
.btn-refresh, .btn-bulk, .btn-log {
  padding: 4px 12px; border-radius: 4px; cursor: pointer;
  background: var(--accent, #0052cc); color: #fff; border: none; font-size: 13px;
}
.btn-refresh:disabled, .btn-log:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-log--locked { background: var(--text-muted, #888) !important; }

.coverage-bar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; border-radius: 6px; background: var(--surface2, #f4f5f7); font-size: 13px;
}
.coverage-bar.warn { background: #fff3cd; }
.coverage-bar.ok   { background: #d4edda; }

.calendar-layout { display: grid; grid-template-columns: 80px 1fr; gap: 12px; }
.timeline-col { position: relative; height: 600px; border-right: 1px solid var(--border, #ddd); width: 80px; }
.timeline-axis { position: relative; height: 100%; }
.timeline-hour {
  position: absolute; font-size: 10px; color: #888; left: 4px;
  transform: translateY(-50%); white-space: nowrap;
}
.timeline-events { position: absolute; inset: 0; }
.timeline-block {
  position: absolute; left: 34px; right: 4px;
  background: #4c9aff33; border-left: 3px solid #4c9aff;
  padding: 2px 4px; font-size: 10px; overflow: hidden;
  border-radius: 2px; cursor: default;
}
.timeline-block.logged        { background: #57d9a333; border-left-color: #57d9a3; }
.timeline-block.has-error     { background: #ff5c5c33; border-left-color: #ff5c5c; }

.rows-col { display: flex; flex-direction: column; gap: 8px; }
.meeting-row {
  border: 1px solid var(--border, #ddd); border-radius: 6px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
  background: var(--surface, #fff);
}
.meeting-row.logged { opacity: 0.6; }
.meeting-info { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.meeting-time  { font-size: 12px; color: #666; white-space: nowrap; }
.meeting-dur   { font-size: 11px; color: #888; }
.meeting-subject { font-weight: 600; font-size: 13px; }
.match-badge { font-size: 10px; padding: 2px 6px; border-radius: 10px; background: #e0e7ff; color: #3730a3; }
.match-badge.history { background: #d1fae5; color: #065f46; }
.match-badge.rule    { background: #fef3c7; color: #92400e; }
.match-badge.prefix  { background: #e0e7ff; color: #3730a3; }

.issue-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.issue-chip {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 8px; background: #e0e7ff; border-radius: 12px; font-size: 12px;
}
.issue-summary { color: #555; font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-clear { background: none; border: none; cursor: pointer; font-size: 12px; padding: 0; }
.btn-star { background: none; border: none; cursor: pointer; font-size: 14px; padding: 0 2px; color: #888; line-height: 1; }
.btn-star.is-fav { color: #f5a623; }
.favorites-bar { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; width: 100%; padding: 2px 0; }
.fav-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 8px; background: #fff8e1; border: 1px solid #ffe082; border-radius: 12px; font-size: 11px; cursor: pointer; line-height: 1.4;
}
.fav-chip:hover { background: #fff3c4; }
.fav-chip__summary { color: #6b5d00; font-size: 10px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fav-chip__remove { color: #999; font-size: 10px; }
.fav-chip__remove:hover { color: #c92a2a; }

.fav-panel {
  margin: 0.5rem 0;
  padding: 0.6rem 0.75rem;
  background: #fffdf5;
  border: 1px solid #ffe082;
  border-radius: 0.6rem;
}
.fav-panel__head { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
.fav-panel__title { font-weight: 600; font-size: 0.8125rem; color: #6b4f00; margin-right: 0.15rem; }
.fav-panel__hint { font-size: 0.7rem; color: #8a7a3a; }
.fav-panel__chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.issue-search-wrap { position: relative; }
.issue-search { padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border, #ddd); font-size: 12px; width: 220px; }
.issue-dropdown {
  position: absolute; top: 100%; left: 0; z-index: 50;
  background: #fff; border: 1px solid var(--border, #ddd); border-radius: 4px;
  max-height: 180px; overflow-y: auto; min-width: 280px;
}
.issue-option { padding: 6px 10px; font-size: 12px; cursor: pointer; }
.issue-option:hover { background: #f0f4ff; }
.comment-input {
  padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border, #ddd);
  font-size: 12px; flex: 1; min-width: 180px;
}

.row-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.row-error { color: #dc2626; font-size: 11px; }
.row-warning { color: #b45309; font-size: 11px; }
.loading, .empty { color: #888; padding: 24px; text-align: center; }
.error { color: #dc2626; padding: 8px 12px; background: #fee2e2; border-radius: 4px; }
</style>
