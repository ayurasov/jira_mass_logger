<template>
  <div class="worklog-screen">
    <header class="worklog-header">
      <div class="worklog-header__title">
        <h1>Мой worklog</h1>
        <span v-if="!store.isOnline" class="badge badge--offline">Оффлайн</span>
        <span v-else-if="store.hasPendingSync" class="badge badge--pending">Синхронизация…</span>
        <span v-else-if="store.loading" class="badge badge--pending">Обновление…</span>
        <span v-else-if="store.fetchError" class="badge badge--offline">Ошибка Jira</span>
        <span v-else-if="store.fetchInfo && store.fetchInfo.startsWith('Jira вернула 0')" class="badge badge--pending">Jira: 0 записей</span>
        <span v-else class="badge badge--ok">Синхронизировано</span>
      </div>
      <div class="worklog-header__actions">
        <button class="btn btn--ghost" @click="openAutoSyncSettings = !openAutoSyncSettings"><ActionIcon name="bolt" :size="15" /> Автосинхронизация</button>
        <button class="btn btn--secondary" :disabled="store.loading" @click="refreshFromJira">
          <ActionIcon name="refresh" :size="15" /> {{ store.loading ? 'Обновление…' : 'Обновить из Jira' }}
        </button>
        <button class="btn btn--primary" @click="exportCsv"><ActionIcon name="download" :size="15" /> Экспорт CSV</button>
      </div>
    </header>

    <div v-if="store.fetchInfo" class="fetch-info" :class="{ 'fetch-info--error': !!store.fetchError || store.fetchInfo.includes('ошибк') }">
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
      <div class="filters__range">
        <DatePicker v-model="store.filters.fromDate" placeholder="Дата с" class="filters__input" />
        <span class="filters__dash">—</span>
        <DatePicker v-model="store.filters.toDate" placeholder="Дата по" class="filters__input" />
      </div>
      <input v-model="store.filters.searchText" class="filters__input filters__input--search" placeholder="Поиск в описании…" />
      <label class="filters__norm">
        Норма в день, ч:
        <input v-model.number="settings.workdayHours" type="number" min="1" max="24" step="0.5" @change="persistNorm" />
      </label>
    </div>

    <div
      ref="scrollContainer"
      class="worklog-table-wrap"
      :class="{ 'worklog-table-wrap--editing': editingCell !== null }"
    >
      <table class="worklog-table">
        <colgroup>
          <col style="width: 6.5rem" />
          <col style="width: 2.75rem" />
          <col style="width: 40%" />
          <col style="width: 4.75rem" />
          <col style="width: 60%" />
          <col style="width: 4.75rem" />
          <col style="width: 5rem" />
          <col style="width: 6.5rem" />
        </colgroup>
        <thead>
          <tr>
            <th class="th-sortable" @click="store.setSort('date')">Дата <span class="sort-ind">{{ sortIndicator('date') }}</span></th>
            <th>Дн.</th>
            <th class="th-sortable" @click="store.setSort('issue')">Задача <span class="sort-ind">{{ sortIndicator('issue') }}</span></th>
            <th class="th-sortable col-hours" @click="store.setSort('hours')">Часы <span class="sort-ind">{{ sortIndicator('hours') }}</span></th>
            <th>Описание</th>
            <th class="col-start">Старт</th>
            <th class="th-sortable" @click="store.setSort('status')">Статус <span class="sort-ind">{{ sortIndicator('status') }}</span></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="group in groupedByWeek" :key="group.week">
            <tr class="week-row">
              <td colspan="8">
                <div class="group-label">
                  <span>Неделя {{ group.week.split('-W')[1] }} · {{ group.week.split('-W')[0] }}</span>
                  <span class="group-total" :class="weekHoursClass(group.totalHours)">{{ group.totalHours.toFixed(2) }} ч</span>
                </div>
              </td>
            </tr>
            <template v-for="dayGroup in group.days" :key="dayGroup.date">
              <tr class="day-row">
                <td colspan="8">
                  <div class="group-label">
                    <span>{{ formatDate(dayGroup.date) }} · {{ WEEKDAY_RU_SHORT[dayGroup.rows[0]?.weekday ?? 0] }}</span>
                    <span class="group-total" :class="dayHoursClass(dayGroup.totalHours)">{{ dayGroup.totalHours.toFixed(2) }} ч</span>
                  </div>
                </td>
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
                <td class="comment-cell" @dblclick="startEdit(row.rowKey, 'comment')">
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
                <td>
                  <div class="row-actions">
                    <button class="icon-btn" title="Изменить" @click="openRowEditor(row)"><ActionIcon name="edit" :size="15" /></button>
                    <button class="icon-btn" title="Дублировать" @click="promptDuplicate(row)"><ActionIcon name="duplicate" :size="15" /></button>
                    <button class="icon-btn icon-btn--danger" title="Удалить" @click="confirmDelete(row)"><ActionIcon name="close" :size="15" /></button>
                  </div>
                </td>
              </tr>
            </template>
          </template>
          <tr v-if="groupedByWeek.length === 0">
            <td colspan="8" class="empty-state">Нет записей за выбранный период</td>
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

    <div v-if="editTarget" class="modal-overlay">
      <div class="modal">
        <h2>Изменить запись</h2>
        <div class="edit-form">
          <label>
            Задача
            <input :value="editTarget.issueKey" type="text" disabled />
          </label>
          <label>
            Дата
            <DatePicker v-model="editForm.date" />
          </label>
          <label>
            Время начала
            <input v-model="editForm.time" type="time" />
          </label>
          <label>
            Часы
            <input v-model.number="editForm.hours" type="number" step="0.25" min="0.01" />
          </label>
          <label class="span-2">
            Описание
            <textarea v-model="editForm.comment" rows="3"></textarea>
          </label>
        </div>
        <p v-if="editFormError" class="status-text status-text--error">{{ editFormError }}</p>
        <div class="modal-actions">
          <button class="btn btn--secondary" @click="closeRowEditor">Отмена</button>
          <button class="btn btn--primary" :disabled="editFormSaving" @click="submitRowEditor">
            {{ editFormSaving ? 'Сохранение…' : 'Сохранить и отправить в Jira' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="duplicateTarget" class="modal-overlay">
      <div class="modal">
        <h2>Дублировать запись</h2>
        <div class="edit-form">
          <label>
            Задача
            <input :value="duplicateTarget.issueKey" type="text" disabled />
          </label>
          <label>
            Новая дата
            <DatePicker v-model="duplicateForm.date" />
          </label>
          <label>
            Время начала
            <input v-model="duplicateForm.time" type="time" />
          </label>
          <label>
            Часы
            <input v-model.number="duplicateForm.hours" type="number" step="0.25" min="0.01" />
          </label>
          <label class="span-2">
            Описание
            <textarea v-model="duplicateForm.comment" rows="3"></textarea>
          </label>
        </div>
        <p v-if="duplicateFormError" class="status-text status-text--error">{{ duplicateFormError }}</p>
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
import { localIsoDate, daysAgoIso, formatRuDate } from '../utils/time';
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { useRoute } from 'vue-router';
import { useMyWorklogStore, type WorklogRow } from '../store/myWorklog';
import { useSettingsStore } from '../store/settings';
import { useJiraProfilesStore } from '../store/jiraProfiles';
import { useLicenseStore } from '../store/license';
import { tauriApi } from '../lib/tauriApi';
import { WEEKDAY_RU_SHORT } from '../utils/dateRange';
import ActionIcon from '../components/ActionIcon.vue';
import DatePicker from '../components/DatePicker.vue';

const store = useMyWorklogStore();
const settings = useSettingsStore();
const jiraProfiles = useJiraProfilesStore();
const license = useLicenseStore();
const route = useRoute();

const openAutoSyncSettings = ref(false);
const scrollContainer = ref<HTMLElement | null>(null);
const editingCell = ref<{ rowKey: string; field: 'hours' | 'comment' | 'started' } | null>(null);
const editBuffer = ref<string | number>('');
const editTarget = ref<WorklogRow | null>(null);
const editForm = ref<{ date: string; time: string; hours: number; comment: string }>({ date: '', time: '', hours: 0, comment: '' });
const editFormError = ref('');
const editFormSaving = ref(false);

const duplicateTarget = ref<WorklogRow | null>(null);
const duplicateForm = ref<{ date: string; time: string; hours: number; comment: string }>({ date: '', time: '', hours: 0, comment: '' });
const duplicateFormError = ref('');
const deleteTarget = ref<WorklogRow | null>(null);

let unlistenResume: (() => void) | null = null;

onMounted(async () => {
  store.restoreFilters();
  const qFrom = (route.query.from as string) || '';
  const qTo = (route.query.to as string) || '';
  if (qFrom || qTo) {
    const from = qFrom || daysAgoIso(27);
    const to = qTo || localIsoDate();
    store.filters.fromDate = from;
    store.filters.toDate = to;
  } else if (!store.filters.fromDate || !store.filters.toDate) {
    store.filters.fromDate = daysAgoIso(27);
    store.filters.toDate = localIsoDate();
  }
  store.persistFilters();

  await jiraProfiles.ensureLoaded();
  await store.loadFromCache();
  store.setupNetworkListeners();
  store.startAutoSync();
  await store.fetchFromJira(false);

  unlistenResume = await listen('system:possible_resume', () => {
    store.refreshFromJira();
  });
});

watch(
  () => [route.query.from as string, route.query.to as string],
  ([from, to]) => {
    if (!from && !to) return;
    const f = from || daysAgoIso(27);
    const t = to || localIsoDate();
    if (f !== store.filters.fromDate || t !== store.filters.toDate) {
      store.filters.fromDate = f;
      store.filters.toDate = t;
      store.persistFilters();
      store.refreshFromJira();
    }
  },
);

onBeforeUnmount(() => {
  store.stopAutoSync();
  unlistenResume?.();
});

const groupedByWeek = computed(() => {
  const byWeek = new Map<string, WorklogRow[]>();
  for (const row of store.sortedRows) {
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

// Допуск на округление: часы строк округлены до сотых (3 × 2.67 = 8.01 ≠ 8).
const HOURS_EPS = 0.05;
function dayHoursClass(hours: number) {
  if (hours < settings.workHoursPerDay - HOURS_EPS) return 'hours--under';
  if (hours > settings.workHoursPerDay + HOURS_EPS) return 'hours--over';
  return 'hours--ok';
}
function weekHoursClass(hours: number) {
  // Норма недели = норма дня × число рабочих дней из графика (а не всегда 5).
  const target = settings.workHoursPerDay * (settings.workdays.length || 5);
  if (hours < target - HOURS_EPS) return 'hours--under';
  if (hours > target + HOURS_EPS) return 'hours--over';
  return 'hours--ok';
}

function formatDate(iso: string) {
  return formatRuDate(iso);
}
function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('ru-RU');
}
function formatTime(started: string) {
  const m = started.match(/T(\d{2}:\d{2})/);
  return m?.[1] ?? new Date(started).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function isEditing(rowKey: string, field: string) {
  return editingCell.value?.rowKey === rowKey && editingCell.value?.field === field;
}
function startEdit(rowKey: string, field: 'hours' | 'comment' | 'started') {
  if (!license.guardWrite()) return;
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
    const started = row.started.replace(/T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}/, `T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000${row.started.slice(-5)}`);
    if (started === row.started) return;
    await store.editRow(row.rowKey, { started });
  }
}

function openRowEditor(row: WorklogRow) {
  if (!license.guardWrite()) return;
  editTarget.value = row;
  editForm.value = {
    date: row.date,
    time: formatTime(row.started),
    hours: row.hours,
    comment: row.comment || '',
  };
  editFormError.value = '';
}
function closeRowEditor() {
  editTarget.value = null;
}
async function submitRowEditor() {
  if (!editTarget.value) return;
  editFormError.value = '';
  const { date, time, hours, comment } = editForm.value;
  if (!date) { editFormError.value = 'Укажите дату.'; return; }
  const [hh, mm] = String(time || '09:00').split(':').map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) { editFormError.value = 'Некорректное время начала.'; return; }
  if (!hours || Number.isNaN(hours) || hours <= 0) { editFormError.value = 'Часы должны быть больше нуля.'; return; }

  const row = editTarget.value;
  const tzSuffix = row.started.slice(-5);
  const started = `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000${tzSuffix}`;

  const patch: Partial<Pick<WorklogRow, 'hours' | 'comment' | 'started'>> = {};
  if (started !== row.started) patch.started = started;
  if (hours !== row.hours) patch.hours = hours;
  if (comment !== (row.comment || '')) patch.comment = comment;

  if (Object.keys(patch).length === 0) {
    editTarget.value = null;
    return;
  }

  editFormSaving.value = true;
  try {
    await store.editRow(row.rowKey, patch);
    const refreshed = store.rows.find((r) => r.rowKey === row.rowKey);
    if (refreshed?.syncStatus === 'error') {
      editFormError.value = refreshed.syncError || 'Не удалось отправить изменения в Jira.';
      return;
    }
    editTarget.value = null;
  } finally {
    editFormSaving.value = false;
  }
}

function promptDuplicate(row: WorklogRow) {
  if (!license.guardWrite()) return;
  duplicateTarget.value = row;
  duplicateForm.value = {
    date: row.date,
    time: formatTime(row.started),
    hours: row.hours,
    comment: row.comment || '',
  };
  duplicateFormError.value = '';
}
async function confirmDuplicate() {
  if (!duplicateTarget.value) return;
  duplicateFormError.value = '';
  const { date, time, hours, comment } = duplicateForm.value;
  if (!date) { duplicateFormError.value = 'Укажите дату.'; return; }
  if (!hours || Number.isNaN(hours) || hours <= 0) { duplicateFormError.value = 'Часы должны быть больше нуля.'; return; }
  await store.duplicateRow(duplicateTarget.value.rowKey, date, { hours, comment, time });
  duplicateTarget.value = null;
}

function confirmDelete(row: WorklogRow) {
  if (!license.guardWrite()) return;
  deleteTarget.value = row;
}
async function doDelete() {
  if (!deleteTarget.value) return;
  await store.deleteRow(deleteTarget.value.rowKey);
  deleteTarget.value = null;
}

async function refreshFromJira() {
  await store.refreshFromJira();
}

// Норма из фильтра сохраняется в рабочий график (раньше жила только до перезапуска).
function persistNorm() {
  const h = Number(settings.workdayHours);
  if (!h || h <= 0 || h > 24) return;
  settings.setWorkSchedule({ workdayHours: h, workdays: settings.workdays, timezone: settings.timezone });
}

function sortIndicator(key: 'date' | 'issue' | 'hours' | 'status'): string {
  if (store.sort.key !== key) return '';
  return store.sort.dir === 'asc' ? '▲' : '▼';
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
      // Excel в русской локали ожидает десятичную запятую.
      r.hours.toFixed(2).replace('.', ','),
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
