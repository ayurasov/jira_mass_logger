<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useDayFromCalendarStore } from '../store/dayFromCalendar';
import { tauriApi } from '../lib/tauriApi';
import { useJiraProfilesStore } from '../store/jiraProfiles';
import { useSettingsStore } from '../store/settings';

const store = useDayFromCalendarStore();
const router = useRouter();
const settings = useSettingsStore();
const jiraStore = useJiraProfilesStore();

const selectedDate = ref(new Date().toISOString().slice(0, 10));
const issueSearchMap = ref<Record<number, string>>({});
const issueOptionsMap = ref<Record<number, { key: string; summary: string }[]>>({});

onMounted(async () => {
  await jiraStore.ensureLoaded();
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
  if (q.length < 2) { issueOptionsMap.value[idx] = []; return; }
  const params = jiraStore.activeConnectionParams;
  if (!params) return;
  const res = await tauriApi.getIssuesByJql(
    params,
    `text ~ "${q}" ORDER BY updated DESC`,
  );
  issueOptionsMap.value[idx] = res.map((i) => ({ key: i.key, summary: i.summary ?? '' }));
}

function selectIssue(idx: number, key: string, summary: string) {
  store.setIssueForRow(idx, key, summary);
  issueOptionsMap.value[idx] = [];
  issueSearchMap.value[idx] = '';
}

async function logSingle(idx: number) {
  await store.logSingleRow(idx);
}

function goToBulkPreview() {
  store.buildBulkPreview();
  router.push('/calendar/preview');
}

const uncoveredHours = computed(() => (store.uncoveredSeconds / 3600).toFixed(1));
</script>

<template>
  <div class="day-calendar">
    <!-- Header -->
    <div class="day-header">
      <h2>📅 День из календаря</h2>
      <div class="day-controls">
        <input type="date" v-model="selectedDate"
          @change="store.loadDay(selectedDate)" class="date-picker" />
        <button @click="store.loadDay(selectedDate, true)" :disabled="store.loading" class="btn-refresh">
          🔄 Обновить
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

    <!-- Coverage indicator -->
    <div class="coverage-bar"
      :class="{ ok: store.uncoveredSeconds === 0, warn: store.uncoveredSeconds > 0 }">
      <span>
        Покрыто: {{ fmtDuration(store.coveredSeconds) }} / {{ store.workHoursPerDay }}ч
        <template v-if="store.uncoveredSeconds > 0">
          · ⚠️ Не залогировано ещё {{ uncoveredHours }}ч
        </template>
        <template v-else>
          · ✅ Норма выполнена
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
            <span v-if="row.selectedIssueKey" class="issue-chip">
              {{ row.selectedIssueKey }}
              <span v-if="row.selectedIssueSummary" class="issue-summary">
                {{ row.selectedIssueSummary }}
              </span>
              <button @click="store.setIssueForRow(idx, '', null)" class="btn-clear">✕</button>
            </span>
            <div class="issue-search-wrap" v-if="!row.selectedIssueKey">
              <input
                type="text"
                :value="issueSearchMap[idx] ?? ''"
                @input="searchIssues(idx, ($event.target as HTMLInputElement).value)"
                placeholder="Поиск задачи Jira…"
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
              :disabled="!row.selectedIssueKey || row.logged"
              class="btn-log">
              {{ row.logged ? '✅ Залогировано' : '▶ В worklog' }}
            </button>
            <span v-if="row.logError" class="row-error">{{ row.logError }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.day-calendar { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.day-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.day-controls { display: flex; gap: 8px; align-items: center; }
.date-picker, .rounding-select { padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border, #ddd); }
.btn-refresh, .btn-bulk, .btn-log {
  padding: 4px 12px; border-radius: 4px; cursor: pointer;
  background: var(--accent, #0052cc); color: #fff; border: none; font-size: 13px;
}
.btn-refresh:disabled, .btn-log:disabled { opacity: 0.5; cursor: not-allowed; }

.coverage-bar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; border-radius: 6px; background: var(--surface2, #f4f5f7); font-size: 13px;
}
.coverage-bar.warn { background: #fff3cd; }
.coverage-bar.ok   { background: #d4edda; }

.calendar-layout { display: grid; grid-template-columns: 80px 1fr; gap: 12px; }
.timeline-col { position: relative; height: 600px; border-right: 1px solid var(--border, #ddd); }
.timeline-axis { position: relative; height: 100%; }
.timeline-hour {
  position: absolute; font-size: 10px; color: #888; right: 4px;
  transform: translateY(-50%); white-space: nowrap;
}
.timeline-events { position: absolute; inset: 0; }
.timeline-block {
  position: absolute; left: 2px; right: 2px;
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

.row-actions { display: flex; align-items: center; gap: 8px; }
.row-error { color: #dc2626; font-size: 11px; }
.loading, .empty { color: #888; padding: 24px; text-align: center; }
.error { color: #dc2626; padding: 8px 12px; background: #fee2e2; border-radius: 4px; }
</style>
