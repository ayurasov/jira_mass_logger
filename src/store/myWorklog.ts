// Pinia-стор экрана "Мой worklog": редактируемая таблица с оптимистичным UI,
// очередью несинхронизированных изменений и обработкой конфликтов версий.
import { defineStore } from 'pinia';
import { tauriApi, parseConflictError, type WorklogDto, type JiraConnectionParams, type CachedWorklogRow } from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useSettingsStore } from './settings';
import { getIsoWeek } from '../utils/worklogText';

export interface WorklogRow {
  rowKey: string;
  worklogId?: string | null;
  issueKey: string;
  issueSummary?: string | null;
  projectKey?: string | null;
  date: string;
  weekday: number;
  isoWeek: string;
  started: string;
  hours: number;
  comment: string;
  updated?: string | null;
  syncStatus: 'synced' | 'pending' | 'error' | 'local-only';
  syncError?: string | null;
}

function rowKeyOf(worklogId: string | null | undefined, issueKey: string, started: string): string {
  return worklogId ? `wl:${worklogId}` : `local:${issueKey}:${started}:${Math.random().toString(36).slice(2, 8)}`;
}

function formatJiraStartedInTimezone(date: Date, timezone: string): string {
  const offsetMs = getTimezoneOffsetMs(date, timezone);
  const localMs = date.getTime() + offsetMs;
  const local = new Date(localMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const sign = offsetMs >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMs) / 60000;
  const hh = pad(Math.floor(absMin / 60));
  const mm = pad(absMin % 60);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.000` +
    `${sign}${hh}${mm}`
  );
}

function getTimezoneOffsetMs(dt: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(dt).map((p) => [p.type, p.value]));
    const localMs = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    return localMs - dt.getTime();
  } catch {
    return -dt.getTimezoneOffset() * 60000;
  }
}

function dtoToRow(dto: WorklogDto, projectKey?: string | null, issueSummary?: string | null): WorklogRow {
  const started = dto.started;
  const date = started.slice(0, 10);
  const weekday = new Date(started).getDay();
  return {
    rowKey: rowKeyOf(dto.id, dto.issueKey ?? '', started),
    worklogId: dto.id,
    issueKey: dto.issueKey ?? '',
    issueSummary: issueSummary ?? dto.issueSummary ?? null,
    projectKey: projectKey ?? (dto.issueKey ? dto.issueKey.split('-')[0] : null),
    date,
    weekday,
    isoWeek: getIsoWeek(date),
    started,
    hours: Math.round((dto.timeSpentSeconds / 3600) * 100) / 100,
    comment: dto.comment ?? '',
    updated: dto.updated,
    syncStatus: 'synced',
  };
}

function cachedToRow(row: CachedWorklogRow): WorklogRow {
  const date = row.started.slice(0, 10);
  return {
    rowKey: row.rowKey,
    worklogId: row.worklogId,
    issueKey: row.issueKey,
    issueSummary: row.issueSummary,
    projectKey: row.projectKey,
    date,
    weekday: new Date(row.started).getDay(),
    isoWeek: getIsoWeek(date),
    started: row.started,
    hours: Math.round((row.timeSpentSeconds / 3600) * 100) / 100,
    comment: row.comment ?? '',
    updated: row.updated,
    syncStatus: row.worklogId ? 'synced' : 'local-only',
  };
}

function rowToCached(row: WorklogRow): CachedWorklogRow {
  return {
    rowKey: row.rowKey,
    worklogId: row.worklogId,
    issueKey: row.issueKey,
    issueSummary: row.issueSummary,
    projectKey: row.projectKey,
    started: row.started,
    timeSpentSeconds: Math.round(row.hours * 3600),
    comment: row.comment,
    updated: row.updated,
  };
}

export const useMyWorklogStore = defineStore('myWorklog', {
  state: () => ({
    rows: [] as WorklogRow[],
    loading: false,
    isOnline: navigator.onLine,
    lastSyncedAt: localStorage.getItem('jiratime-worklog-last-sync') || null,
    filters: {
      fromDate: '',
      toDate: '',
      issueKey: '',
      projectKey: '',
      searchText: '',
    },
    sort: {
      key: 'date' as 'date' | 'issue' | 'hours' | 'status',
      dir: 'desc' as 'asc' | 'desc',
    },
    pendingConflict: null as { local: WorklogRow; remote: WorklogDto } | null,
    autoSyncTimer: null as ReturnType<typeof setInterval> | null,
    fetchInfo: null as string | null,
    fetchError: null as string | null,
  }),
  getters: {
    filteredRows(state): WorklogRow[] {
      const { issueKey, projectKey, searchText, fromDate, toDate } = state.filters;
      return state.rows.filter((r) => {
        if (issueKey && !r.issueKey.toLowerCase().includes(issueKey.toLowerCase())) return false;
        if (projectKey && r.projectKey !== projectKey) return false;
        if (fromDate && r.date < fromDate) return false;
        if (toDate && r.date > toDate) return false;
        if (searchText && !r.comment.toLowerCase().includes(searchText.toLowerCase())) return false;
        return true;
      });
    },
    sortedRows(): WorklogRow[] {
      const rows = [...this.filteredRows];
      const { key, dir } = this.sort;
      const mul = dir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        let av: number | string;
        let bv: number | string;
        if (key === 'hours') { av = a.hours; bv = b.hours; }
        else if (key === 'issue') { av = a.issueKey; bv = b.issueKey; }
        else if (key === 'status') { av = a.syncStatus; bv = b.syncStatus; }
        else { av = a.started; bv = b.started; }
        if (av < bv) return -1 * mul;
        if (av > bv) return 1 * mul;
        return 0;
      });
      return rows;
    },
    hasPendingSync(state): boolean {
      return state.rows.some((r) => r.syncStatus === 'pending' || r.syncStatus === 'local-only');
    },
  },
  actions: {
    activeConnectionParams(): JiraConnectionParams | null {
      const profiles = useJiraProfilesStore();
      return profiles.activeConnectionParams;
    },

    async loadFromCache() {
      const cached = await tauriApi.listCachedWorklogs(this.filters.fromDate || '1970-01-01', this.filters.toDate || '2999-12-31');
      this.rows = cached.map(cachedToRow);
    },

    async fetchFromJira(force = false) {
      if (this.loading) return;
      const params = this.activeConnectionParams();
      if (!params) return;
      this.loading = true;
      try {
        const watermarkKey = `jiratime-worklog-watermark-v2-${params.baseUrl}-${params.email}-${params.instanceType}`;
        const since = force ? 0 : Number(localStorage.getItem(watermarkKey) ?? '0');
        const cachedKeys = new Set(this.rows.map((r) => r.issueKey).filter(Boolean));
        if (this.filters.issueKey) cachedKeys.add(this.filters.issueKey);
        const issueKeysForFallback = Array.from(cachedKeys);
        const dateRange = this.filters.fromDate || this.filters.toDate
          ? {
              dateFrom: this.filters.fromDate || '1970-01-01',
              dateTo: this.filters.toDate || new Date().toISOString().slice(0, 10),
              issueFilter: this.filters.issueKey || undefined,
            }
          : undefined;
        // allowEmptyRange=true, когда диапазон дат указан явно (клик по дню/неделе,
        // выходной или праздник) — Jira вернувшая 0 worklog в таком случае это ВАЛИДНЫЙ
        // результат ('0 часов'), а не ошибка, и не должна показываться как сбой сети/auth.
        const dtos = await tauriApi.getWorklogsSince(params, since, issueKeysForFallback, dateRange, !!dateRange);
        if (!Array.isArray(dtos)) {
          throw new Error('Jira вернула некорректный ответ при загрузке worklog.');
        }
        for (const dto of dtos) {
          const row = dtoToRow(dto);
          await tauriApi.upsertCachedWorklog(rowToCached(row));
        }
        localStorage.setItem(watermarkKey, String(Date.now()));
        localStorage.setItem('jiratime-worklog-last-sync', new Date().toISOString());
        this.lastSyncedAt = new Date().toISOString();
        await this.loadFromCache();
        this.fetchError = null;
        this.fetchInfo = dtos.length === 0
          ? 'Jira вернула 0 worklog за выбранный период. Проверьте период, фильтр и что записи существуют.'
          : `Загружено ${dtos.length} записей из Jira.`;
      } catch (e: any) {
        this.fetchError = String(e?.message ?? e);
        this.fetchInfo = this.fetchError;
      } finally {
        this.loading = false;
      }
      await this.drainSyncQueue();
    },

    async editRow(rowKey: string, patch: Partial<Pick<WorklogRow, 'hours' | 'comment' | 'started'>>) {
      const row = this.rows.find((r) => r.rowKey === rowKey);
      if (!row) return;
      const previous = { ...row };
      Object.assign(row, patch);
      if (patch.started) {
        row.date = patch.started.slice(0, 10);
        row.weekday = new Date(patch.started).getDay();
        row.isoWeek = getIsoWeek(row.date);
      }
      row.syncStatus = 'pending';
      row.syncError = null;
      await tauriApi.upsertCachedWorklog(rowToCached(row));

      const params = this.activeConnectionParams();
      if (!params || !row.worklogId) {
        row.syncStatus = 'local-only';
        return;
      }
      if (!this.isOnline) {
        await this.queueOffline(row, 'update');
        return;
      }
      try {
        const settings = useSettingsStore();
        await tauriApi.updateWorklog(params, row.issueKey, row.worklogId, {
          startedAt: patch.started ? formatJiraStartedInTimezone(new Date(patch.started), settings.timezone) : undefined,
          timeSpentSeconds: patch.hours !== undefined ? Math.round(row.hours * 3600) : undefined,
          comment: patch.comment,
          expectedUpdated: previous.updated,
        });
        const fresh = await tauriApi.getWorklogById(params, row.issueKey, row.worklogId);
        row.started = fresh.started;
        row.date = fresh.started.slice(0, 10);
        row.weekday = new Date(fresh.started).getDay();
        row.isoWeek = getIsoWeek(row.date);
        row.updated = fresh.updated;
        row.syncStatus = 'synced';
        row.syncError = null;
        await tauriApi.upsertCachedWorklog(rowToCached(row));
      } catch (err) {
        const conflict = parseConflictError(err);
        if (conflict) {
          this.pendingConflict = { local: { ...row }, remote: conflict };
          row.syncStatus = 'error';
          row.syncError = 'Конфликт версий: запись изменена в Jira';
          return;
        }
        Object.assign(row, previous);
        row.syncStatus = 'error';
        row.syncError = String(err);
        await tauriApi.upsertCachedWorklog(rowToCached(row));
      }
    },

    async deleteRow(rowKey: string) {
      const row = this.rows.find((r) => r.rowKey === rowKey);
      if (!row) return;
      this.rows = this.rows.filter((r) => r.rowKey !== rowKey);
      await tauriApi.deleteCachedWorklog(rowKey);

      const params = this.activeConnectionParams();
      if (!params || !row.worklogId) return;
      if (!this.isOnline) {
        await this.queueOffline(row, 'delete');
        return;
      }
      try {
        await tauriApi.deleteWorklog(params, row.issueKey, row.worklogId, row.updated);
      } catch (err) {
        const conflict = parseConflictError(err);
        if (conflict) {
          this.pendingConflict = { local: row, remote: conflict };
          this.rows.push(row);
          await tauriApi.upsertCachedWorklog(rowToCached(row));
          return;
        }
        row.syncStatus = 'error';
        row.syncError = String(err);
        this.rows.push(row);
        await tauriApi.upsertCachedWorklog(rowToCached(row));
      }
    },

    async duplicateRow(rowKey: string, newDate: string, overrides?: { hours?: number; comment?: string; time?: string }) {
      const row = this.rows.find((r) => r.rowKey === rowKey);
      if (!row) return;
      let newStarted = row.started.replace(row.date, newDate);
      if (overrides?.time) {
        const [hh, mm] = overrides.time.split(':').map(Number);
        if (!Number.isNaN(hh) && !Number.isNaN(mm)) {
          newStarted = newStarted.replace(/T\d{2}:\d{2}:\d{2}/, `T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
        }
      }
      const newRow: WorklogRow = {
        ...row,
        rowKey: rowKeyOf(null, row.issueKey, newStarted),
        worklogId: null,
        date: newDate,
        weekday: new Date(newStarted).getDay(),
        isoWeek: getIsoWeek(newDate),
        started: newStarted,
        hours: overrides?.hours !== undefined && overrides.hours > 0 ? overrides.hours : row.hours,
        comment: overrides?.comment !== undefined ? overrides.comment : row.comment,
        syncStatus: 'pending',
      };
      this.rows.push(newRow);
      await tauriApi.upsertCachedWorklog(rowToCached(newRow));

      const params = this.activeConnectionParams();
      if (!params) { newRow.syncStatus = 'local-only'; return; }
      if (!this.isOnline) { await this.queueOffline(newRow, 'create'); return; }
      try {
        const id = await tauriApi.addWorklog(params, newRow.issueKey, formatJiraStartedInTimezone(new Date(newStarted), useSettingsStore().timezone), Math.round(newRow.hours * 3600), newRow.comment);
        const oldRowKey = newRow.rowKey;
        newRow.worklogId = id;
        newRow.rowKey = rowKeyOf(id, newRow.issueKey, newStarted);
        newRow.syncStatus = 'synced';
        await tauriApi.upsertCachedWorklog(rowToCached(newRow));
        if (oldRowKey !== newRow.rowKey) await tauriApi.deleteCachedWorklog(oldRowKey);
      } catch (err) {
        newRow.syncStatus = 'error';
        newRow.syncError = String(err);
        await tauriApi.upsertCachedWorklog(rowToCached(newRow));
      }
    },

    async resolveConflict(resolution: 'keep-local' | 'keep-remote') {
      if (!this.pendingConflict) return;
      const { local, remote } = this.pendingConflict;
      const params = this.activeConnectionParams();
      const row = this.rows.find((r) => r.rowKey === local.rowKey);
      if (resolution === 'keep-remote') {
        if (row) {
          Object.assign(row, dtoToRow(remote), { rowKey: local.rowKey });
          await tauriApi.upsertCachedWorklog(rowToCached(row));
        }
      } else if (resolution === 'keep-local' && params && row && row.worklogId) {
        await tauriApi.updateWorklog(params, row.issueKey, row.worklogId, {
          timeSpentSeconds: Math.round(row.hours * 3600),
          comment: row.comment,
          startedAt: row.started,
          expectedUpdated: remote.updated,
        });
        const fresh = await tauriApi.getWorklogById(params, row.issueKey, row.worklogId);
        row.started = fresh.started;
        row.date = fresh.started.slice(0, 10);
        row.weekday = new Date(fresh.started).getDay();
        row.isoWeek = getIsoWeek(row.date);
        row.updated = fresh.updated;
        row.syncStatus = 'synced';
        await tauriApi.upsertCachedWorklog(rowToCached(row));
      }
      this.pendingConflict = null;
    },

    async queueOffline(row: WorklogRow, operation: 'update' | 'delete' | 'create' | 'duplicate') {
      row.syncStatus = 'pending';
      await tauriApi.enqueueSyncOperation(row.rowKey, operation, JSON.stringify(rowToCached(row)));
    },

    async drainSyncQueue() {
      if (!this.isOnline) return;
      const params = this.activeConnectionParams();
      if (!params) return;
      const queue = await tauriApi.listSyncQueue();
      for (const item of queue) {
        try {
          const payload = JSON.parse(item.payloadJson) as CachedWorklogRow;
          if (item.operation === 'update' && payload.worklogId) {
            await tauriApi.updateWorklog(params, payload.issueKey, payload.worklogId, {
              startedAt: payload.started,
              timeSpentSeconds: payload.timeSpentSeconds,
              comment: payload.comment,
              expectedUpdated: payload.updated,
            });
          } else if (item.operation === 'delete' && payload.worklogId) {
            await tauriApi.deleteWorklog(params, payload.issueKey, payload.worklogId, payload.updated);
          } else if (item.operation === 'create' || item.operation === 'duplicate') {
            const id = await tauriApi.addWorklog(params, payload.issueKey, payload.started, payload.timeSpentSeconds, payload.comment);
            const oldRowKey = payload.rowKey;
            payload.worklogId = id;
            payload.rowKey = rowKeyOf(id, payload.issueKey, payload.started);
            await tauriApi.upsertCachedWorklog(payload);
            if (oldRowKey !== payload.rowKey) await tauriApi.deleteCachedWorklog(oldRowKey);
          }
          await tauriApi.removeSyncQueueItem(item.id);
        } catch (err) {
          await tauriApi.markSyncAttemptFailed(item.id, String(err));
        }
      }
      await this.loadFromCache();
    },

    async setPeriod(from: string, to: string, fetch = true) {
      this.filters.fromDate = from;
      this.filters.toDate = to;
      this.persistFilters();
      if (fetch) await this.fetchFromJira(true);
      else await this.loadFromCache();
    },

    setFilters(patch: Partial<{ issueKey: string; projectKey: string; searchText: string; fromDate: string; toDate: string }>) {
      Object.assign(this.filters, patch);
      this.persistFilters();
    },

    setSort(key: 'date' | 'issue' | 'hours' | 'status') {
      if (this.sort.key === key) {
        this.sort.dir = this.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        this.sort.key = key;
        this.sort.dir = key === 'date' ? 'desc' : 'asc';
      }
      this.persistFilters();
    },

    persistFilters() {
      try {
        localStorage.setItem('jiratime-worklog-filters', JSON.stringify({ filters: this.filters, sort: this.sort }));
      } catch { }
    },

    restoreFilters() {
      try {
        const raw = localStorage.getItem('jiratime-worklog-filters');
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved?.filters) Object.assign(this.filters, saved.filters);
        if (saved?.sort) Object.assign(this.sort, saved.sort);
      } catch { }
    },

    async refreshFromJira() {
      await this.loadFromCache();
      await this.fetchFromJira(false);
    },

    async fetchFromJiraFull() {
      if (this.loading) return;
      const params = this.activeConnectionParams();
      if (!params) return;
      this.loading = true;
      try {
        const from = this.filters.fromDate || '1970-01-01';
        const to = this.filters.toDate || new Date().toISOString().slice(0, 10);
        const dtos = await tauriApi.getWorklogsSince(params, 0, [], {
          dateFrom: from,
          dateTo: to,
        }, true);
        const inRange = dtos.filter((d) => {
          const day = d.started.slice(0, 10);
          return day >= from && day <= to;
        });
        const rows: CachedWorklogRow[] = inRange.map((dto) => ({
          rowKey: rowKeyOf(dto.id, dto.issueKey ?? '', dto.started),
          worklogId: dto.id ?? null,
          issueKey: dto.issueKey ?? 'unknown',
          issueSummary: dto.issueSummary ?? null,
          projectKey: (dto.issueKey ?? 'unknown').split('-')[0] ?? null,
          started: dto.started,
          timeSpentSeconds: dto.timeSpentSeconds,
          comment: dto.comment ?? null,
          updated: dto.updated ?? null,
          syncedAt: new Date().toISOString(),
        }));
        await tauriApi.replaceCachedWorklogsRange(from, to, rows);
        localStorage.setItem('jiratime-worklog-last-sync', new Date().toISOString());
        this.lastSyncedAt = new Date().toISOString();
        await this.loadFromCache();
        this.fetchInfo = `Загружено ${rows.length} записей из Jira (полная ресинхронизация периода).`;
        this.fetchError = null;
      } catch (e) {
        this.fetchError = e instanceof Error ? e.message : String(e);
        this.fetchInfo = `Ошибка Jira: ${this.fetchError}`;
      } finally {
        this.loading = false;
      }
    },

    setupNetworkListeners() {
      window.addEventListener('online', () => { this.isOnline = true; this.drainSyncQueue(); });
      window.addEventListener('offline', () => { this.isOnline = false; });
    },

    startAutoSync() {
      const settings = useSettingsStore();
      this.stopAutoSync();
      if (!settings.autoSyncEnabled) return;
      this.autoSyncTimer = setInterval(() => {
        this.fetchFromJira(false);
      }, Math.max(1, settings.autoSyncIntervalMinutes) * 60_000);
    },

    stopAutoSync() {
      if (this.autoSyncTimer) {
        clearInterval(this.autoSyncTimer);
        this.autoSyncTimer = null;
      }
    },
  },
});
