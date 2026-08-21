<template>
  <div class="worklog-screen">
    <header class="worklog-header">
      <div class="worklog-header__title">
        <h1>Мой worklog</h1>
        <span v-if="!store.isOnline" class="badge badge--offline">Оффлайн</span>
        <span v-else-if="store.hasPendingSync" class="badge badge--pending">Синхронизация…</span>
        <span v-else-if="store.fetchInfo && store.fetchInfo.startsWith('Jira вернула 0')" class="badge badge--pending">Jira: 0 записей</span>
        <span v-else-if="store.fetchInfo" class="badge badge--offline">Ошибка Jira</span>
        <span v-else class="badge badge--ok">Синхронизировано</span>
      </div>
      <div class="worklog-header__actions">
        <button class="btn btn--ghost" @click="openAutoSyncSettings = !openAutoSyncSettings">⚡ Автосинхронизация</button>
        <button class="btn btn--secondary" :disabled="store.loading" @click="refreshFromJira">
          {{ store.loading ? 'Обновление…' : '↻ Обновить из Jira' }}
        </button>
        <button class="btn btn--primary" @click="exportCsv">⬇ Экспорт CSV</button>
      </div>
    </header>

    <div v-if="store.fetchInfo" class="fetch-info" :class="{ 'fetch-info--error': store.fetchInfo.startsWith('Jira вернула 0') || store.fetchInfo.includes('ошибк') }">
      {{ store.fetchInfo }}
    </div>
    <div v-if="openAutoSyncSettings" class="autosync-panel">
      <label class="toggle">
        <input type="checkbox" :checked="settings.autoSyncEnabled" @change="onToggleAutoSync" />
        Автоматически обновлять из Jira каждые
      </label>
      <input
        type="number"
        min="1"
        class="autosync-panel__interval"
        :value="settings.autoSyncIntervalMinutes"
        :disabled="!settings.autoSyncEnabled"
        @change="onChangeAutoSyncInterval"
      />
      <span>минут</span>
      <span v-if="store.lastSyncedAt" class="autosync-panel__last">Последний sync: {{ formatDateTime(store.lastSyncedAt) }}</span>
    </div>

    <div class="filters">
      <input v-model="store.filters.issueKey" class="filters__input" placeholder="Фильтр по задаче (ABC-123)" />
      <input v-model="store.filters.projectKey" class="filters__input" placeholder="Проект (ABC)" />
      <input v-model="store.filters.fromDate" type="date" class="filters__input" />
      <input v-model="store.filters.toDate" type="date" class="filters__input" />
      <input v-model="store.filters.searchText" class="filters__input filters__input--search" placeholder="🔎 Поиск в описании…" />
      <label class="filters__norm">
        Норма в день, ч:
        <input v-model.number="settings.workdayHours" type="number" min="1" max="24" step="0.5" />
      </label>
    </div>

    <div
      ref="scrollContainer"
      class="worklog-table-wrap"
      :class="{ 'worklog-table-wrap--editing': editingCell !== null }"
      @wheel="onWheel"
    >
      <table class="worklog-table">
        <thead>
          <tr>
            <th>Дата</th>
            <th>дн</th>
            <th>Задача</th>
            <th>Суть задачи</th>
            <th class="col-hours">Со</th>
            <th>Описание</th>
            <th>Время старта</th>
            <th>Статус</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="group in groupedByWeek" :key="group.week">
            <tr class="week-row">
              <td colspan="4">Неделя {{ group.week }}</td>
              <td class="col-hours" :class="weekHoursClass(group.totalHours)">{{ group.totalHours.toFixed(2) }} ч</td>
              <td colspan="4"></td>
            </tr>
            <template v-for="dayGroup in group.days" :key="dayGroup.date">
              <tr class="day-row">
                <td colspan="4">{{ formatDate(dayGroup.date) }}</td>
                <td class="col-hours" :class="dayHoursClass(dayGroup.totalHours)">{{ dayGroup.totalHours.toFixed(2) }} ч</td>
                <td colspan="4"></td>
              </tr>
              <tr v-for="row in dayGroup.rows" :key="row.rowKey" class="worklog-row">
                <td>{{ formatDate(row.date) }}</td>
                <td>{{ WEEKDAY_RU_SHORT[row.weekday] }}</td>
                <td>
                  <div class="issue-cell">
                    <span class="issue-cell__key">{{ row.issueKey }}</span>
                    <span v-if="row.issueSummary" class="issue-cell__summary">{{ row.issueSummary }}</span>
                  </div>
                </td>
                <td class="col-hours" @dblclick="startEdit(row.rowKey, 'hours')">
                  <input
                    v-if="isEditing(row.rowKey, 'hours')"
                    v-model.number="editBuffer"
                    type="number"
                    step="0.25"
                    class="cell-input"
                    autofocus
                    @keyup.enter="commitEdit(row, 'hours')"
                    @keyup.escape="cancelEdit"
                    @blur="commitEdit(row, 'hours')"
                  />
                  <span v-else>{{ row.hours.toFixed(2) }}</span>
                </td>
                <td @dblclick="startEdit(row.rowKey, 'comment')">
                  <input
                    v-if="isEditing(row.rowKey, 'comment')"
                    v-model="editBuffer"
                    type="text"
                    class="cell-input cell-input--wide"
                    autofocus
                    @keyup.enter="commitEdit(row, 'comment')"
                    @keyup.escape="cancelEdit"
                    @blur="commitEdit(row, 'comment')"
                  />
                  <span v-else class="comment-preview">{{ row.comment || '—' }}</span>
                </td>
                <td @dblclick="startEdit(row.rowKey, 'started')">
                  <input
                    v-if="isEditing(row.rowKey, 'started')"
                    v-model="editBuffer"
                    type="time"
                    class="cell-input"
                    autofocus
                    @keyup.enter="commitEdit(row, 'started')"
                    @keyup.escape="cancelEdit"
                    @blur="commitEdit(row, 'started')"
                  />
                  <span v-else>{{ formatTime(row.started) }}</span>
                </td>
                <td>
                  <span class="status-dot" :class="'status-dot--' + row.syncStatus" :title="row.syncError || row.syncStatus"></span>
                </td>
                <td class="row-actions">
                  <button class="icon-btn" title="Дублировать" @click="promptDuplicate(row)">⧉</button>
                  <button class="icon-btn icon-btn--danger" title="Удалить" @click="confirmDelete(row)">✕</button>
                </td>
              </tr>
            </template>
          </template>
          <tr v-if="groupedByWeek.length === 0">
            <td colspan="9" class="empty-state">Нет записей за выбранный период</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="store.pendingConflict" class="modal-overlay">
      <div class="modal conflict-modal">
        <h2>Конфликт версий</h2>
        <p>Запись была изменена в Jira параллельно. выберите, какую версию оставить:</p>
        <div class="conflict-diff">
          <div class="conflict-diff__col">
            <h3>Ваша версия</h3>
            <p><b>Часы:</b> {{ store.pendingConflict.local.hours }}</p>
            <p><b>Описание:</b> {{ store.pendingConflict.local.comment || '—' }}</p>
          </div>
          <div class="conflict-diff__col">
            <h3>Версия из Jira</h3>
            <p><b>Часы:</b> {{ (store.pendingConflict.remote.timeSpentSeconds / 3600).toFixed(2) }}</p>
            <p><b>Описание:</b> {{ store.pendingConflict.remote.comment || '—' }}</p>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn--secondary" @click="store.resolveConflict('keep-remote')">Взять из Jira</button>
          <button class="btn btn--primary" @click="store.resolveConflict('keep-local')">Оставить свою</button>
        </div>
      </div>
    </div>

    <div v-if="duplicateTarget" class="modal-overlay">
      <div class="modal">
        <h2>Дублировать запись</h2>
        <label>Новая дата: <input v-model="duplicateDate" type="date" /></label>
        <div class="modal-actions">
          <button class="btn btn--secondary" @click="duplicateTarget = null">Отмена</button>
          <button class="btn btn--primary" @click="confirmDuplicate">Дублировать</button>
        </div>
      </div>
    </div>

    <div v-if="deleteTarget" class="modal-overlay">
      <div class="modal">
        <h2>Удалить запись?</h2>
        <p>{{ deleteTarget.issueKey }} — {{ deleteTarget.hours }} ч за {{ formatDate(deleteTarget.date) }}</p>
        <div class="modal-actions">
          <button class="btn btn--secondary" @click="deleteTarget = null">Отмена</button>
          <button class="btn btn--danger" @click="doDelete">Удалить</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { useMyWorklogStore, type WorklogRow } from '../store/myWorklog';
import { useSettingsStore } from '../store/settings';
import { useJiraProfilesStore } from '../store/jiraProfiles';
import { tauriApi } from '../lib/tauriApi';
import { WEEKDAY_RU_SHORT } from '../utils/dateRange';

const store = useMyWorklogStore();
const settings = useSettingsStore();
const jiraProfiles = useJiraProfilesStore();

const openAutoSyncSettings = ref(false);
const scrollContainer = ref<HTMLElement | null>(null);
const editingCell = ref<{ rowKey: string; field: 'hours' | 'comment' | 'started' } | null>(null);
const editBuffer = ref<string | number>('');
const duplicateTarget = ref<WorklogRow | null>(null);
const duplicateDate = ref('');
const deleteTarget = ref<WorklogRow | null>(null);

let unlistenResume: (() => void) | null = null;

onMounted(async () => {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 27);
  store.filters.fromDate = from.toISOString().slice(0, 10);
  store.filters.toDate = now.toISOString().slice(0, 10);

  await jiraProfiles.ensureLoaded();
  await store.loadFromCache();
  store.setupNetworkListeners();
  store.startAutoSync();
  await store.fetchFromJira(false);

  // При выходе Windows-ноутбука из спящего режима main.rs эмитит
  // "system:possible_resume" при возврате фокуса окна — форсируем ресинх.
  unlistenResume = await listen('system:possible_resume', () => {
    store.fetchFromJira(true);
  });
});

onBeforeUnmount(() => {
  store.stopAutoSync();
  unlistenResume?.();
});

const groupedByWeek = computed(() => {
  const byWeek = new Map<string, WorklogRow[]>();
  for (const row of store.filteredRows) {
    if (!byWeek.has(row.isoWeek)) byWeek.set(row.isoWeek, []);
    byWeek.get(row.isoWeek)!.push(row);
  }
  return Array.from(byWeek.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([week, rows]) => {
      const byDay = new Map<string, WorklogRow[]>();
      for (const row of rows) {
        if (!byDay.has(row.date)) byDay.set(row.date, []);
        byDay.get(row.date)!.push(row);
      }
      const days = Array.from(byDay.entries())
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([date, dayRows]) => ({
          date,
          rows: dayRows,
          totalHours: dayRows.reduce((sum, r) => sum + r.hours, 0),
        }));
      return {
        week,
        days,
        totalHours: rows.reduce((sum, r) => sum + r.hours, 0),
      };
    });
});

function dayHoursClass(hours: number) {
  if (hours < settings.workHoursPerDay) return 'hours--under';
  if (hours > settings.workHoursPerDay) return 'hours--over';
  return 'hours--ok';
}
function weekHoursClass(hours: number) {
  const target = settings.workHoursPerDay * 5;
  if (hours < target) return 'hours--under';
  if (hours > target) return 'hours--over';
  return 'hours--ok';
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('ru-RU');
}
function formatTime(started: string) {
  const d = new Date(started);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function isEditing(rowKey: string, field: string) {
  return editingCell.value?.rowKey === rowKey && editingCell.value?.field === field;
}
function startEdit(rowKey: string, field: 'hours' | 'comment' | 'started') {
  const row = store.rows.find((r) => r.rowKey === rowKey);
  if (!row) return;
  editingCell.value = { rowKey, field };
  editBuffer.value = field === 'hours' ? row.hours : field === 'comment' ? row.comment : formatTime(row.started);
}
function cancelEdit() {
  editingCell.value = null;
}
async function commitEdit(row: WorklogRow, field: 'hours' | 'comment' | 'started') {
  if (!editingCell.value) return;
  editingCell.value = null;
  if (field === 'hours') {
    const hours = Number(editBuffer.value);
    if (Number.isNaN(hours) || hours <= 0 || hours === row.hours) return;
    await store.editRow(row.rowKey, { hours });
  } else if (field === 'comment') {
    const comment = String(editBuffer.value);
    if (comment === row.comment) return;
    await store.editRow(row.rowKey, { comment });
  } else if (field === 'started') {
    const [hh, mm] = String(editBuffer.value).split(':').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return;
    const d = new Date(row.started);
    d.setHours(hh, mm, 0, 0);
    await store.editRow(row.rowKey, { started: d.toISOString() });
  }
}

function promptDuplicate(row: WorklogRow) {
  duplicateTarget.value = row;
  duplicateDate.value = row.date;
}
async function confirmDuplicate() {
  if (!duplicateTarget.value) return;
  await store.duplicateRow(duplicateTarget.value.rowKey, duplicateDate.value);
  duplicateTarget.value = null;
}

function confirmDelete(row: WorklogRow) {
  deleteTarget.value = row;
}
async function doDelete() {
  if (!deleteTarget.value) return;
  await store.deleteRow(deleteTarget.value.rowKey);
  deleteTarget.value = null;
}

async function refreshFromJira() {
  await store.fetchFromJira(true);
}

function onToggleAutoSync(e: Event) {
  const enabled = (e.target as HTMLInputElement).checked;
  settings.setAutoSync(enabled);
  store.startAutoSync();
}
function onChangeAutoSyncInterval(e: Event) {
  const minutes = Number((e.target as HTMLInputElement).value);
  settings.setAutoSync(settings.autoSyncEnabled, minutes);
  store.startAutoSync();
}

// Инерционный скролл колеса/precision touchpad не должен прерывать inline-редактирование:
// когда ячейка в редактировании, событие wheel не должно выталкивать фокус
// с <input>, но сам скролл контейнера должен оставаться работать свободно (native), поэтому
// здесь ничего не превентируется — блокировка только визуальная (см. CSS class --editing)
// и не мешает native scroll на Windows precision touchpad.
function onWheel(_e: WheelEvent) {
  // no-op: скролл остаётся естественный; редактируемая ячейка теряет focus через @blur.
}

async function exportCsv() {
  const rows = store.filteredRows;
  const header = ['Дата', 'День недели', 'Задача', 'Описание', 'Часы', 'Время старта', 'Статус'];
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push([
      formatDate(r.date),
      WEEKDAY_RU_SHORT[r.weekday],
      r.issueKey,
      `"${r.comment.replaceAll('"', '""')}"`,
      r.hours.toFixed(2),
      formatTime(r.started),
      r.syncStatus,
    ].join(';'));
  }
  const csv = lines.join('\r\n');

  const path = await save({
    title: 'Сохранить как',
    defaultPath: `worklog_${store.filters.fromDate}_${store.filters.toDate}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!path) return;
  await tauriApi.writeExportFileUtf8Bom(path, csv);
}
</script>

<style scoped src="../styles/myWorklog.css"></style>
