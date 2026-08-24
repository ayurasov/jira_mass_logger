import { defineStore } from 'pinia';
import {
  tauriApi,
  type CalendarEventDto,
  type MatchSuggestion,
  type MeetingMatchRule,
  type MeetingIssueHistoryEntry,
  type NewWorklogEntry,
  type BulkResultItem,
} from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useSettingsStore } from './settings';

export interface MeetingRow {
  event: CalendarEventDto;
  suggestion: MatchSuggestion | null;
  selectedIssueKey: string | null;
  selectedIssueSummary: string | null;
  comment: string;
  /** Округлённая длительность в секундах */
  roundedSeconds: number;
  /** Время начала в локальной ТЗ в формате Jira started: "2026-08-18T09:30:00.000+0300" */
  startedLocal: string | null;
  /** true — запись уже залогирована в этом сеансе */
  logged: boolean;
  logError: string | null;
}

export interface DayBulkPreviewItem {
  event: CalendarEventDto;
  issueKey: string;
  issueSummary: string | null;
  comment: string;
  startedLocal: string;
  roundedSeconds: number;
}

export const useDayFromCalendarStore = defineStore('dayFromCalendar', {
  state: () => ({
    selectedDate: new Date().toISOString().slice(0, 10),
    rows: [] as MeetingRow[],
    worklogTodaySeconds: 0,
    /** Кэш worklog за текущий день — для дедупликации (issueKey|date|HH:MM) */
    existingKeys: new Set<string>(),
    /** Сводка по неделе: день → задачи+часы */
    weekSummary: [] as { date: string; weekday: string; totalSeconds: number; items: { issueKey: string; seconds: number; comment: string | null }[] }[],
    weekLoading: false,
    loading: false,
    error: null as string | null,
    roundingStepMinutes: Number(localStorage.getItem('jiratime-rounding-step') ?? '15') || 15,
    rules: [] as MeetingMatchRule[],
    history: [] as MeetingIssueHistoryEntry[],
    bulkPreview: [] as DayBulkPreviewItem[],
  }),

  getters: {
    workHoursPerDay(): number { return useSettingsStore().workHoursPerDay; },
    meetingSeconds(): number { return this.rows.reduce((s, r) => s + r.roundedSeconds, 0); },
    coveredSeconds(): number { return this.meetingSeconds + this.worklogTodaySeconds; },
    normSeconds(): number { return this.workHoursPerDay * 3600; },
    uncoveredSeconds(): number { return Math.max(0, this.normSeconds - this.coveredSeconds); },
    /** ISO-дата понедельника текущей недели */
    weekStart(): string { return isoWeekStart(this.selectedDate); },
    weekEnd(): string { return addDays(this.weekStart, 6); },
    weekTotalSeconds(): number { return this.weekSummary.reduce((s, d) => s + d.totalSeconds, 0); },
  },

  actions: {
    setRoundingStep(step: number) {
      this.roundingStepMinutes = step;
      localStorage.setItem('jiratime-rounding-step', String(step));
    },

    roundDuration(durationMinutes: number): number {
      const step = this.roundingStepMinutes;
      if (step <= 0) return Math.max(0, durationMinutes) * 60;
      const rounded = Math.round(durationMinutes / step) * step;
      return Math.max(step, rounded) * 60;
    },

    /**
     * Конвертирует UTC ISO-строку в Jira "started" в локальной TZ Windows-пользователя.
     * Использует Intl.DateTimeFormat с таймзоной из settings.timezone — это даёт
     * DST-корректное смещение без риска сдвига при несовпадении зон Outlook / Windows.
     * Формат результата: "2026-08-18T09:30:00.000+0300" — ровно то, что ждёт Jira worklog started.
     */
    toJiraStarted(utcIsoStr: string): string {
      const tz = useSettingsStore().timezone;
      const dt = new Date(utcIsoStr);
      const offsetMs = getTimezoneOffsetMs(dt, tz);
      const localMs = dt.getTime() + offsetMs;
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
    },

    async loadRulesAndHistory() {
      this.rules = await tauriApi.listMeetingMatchRules();
      this.history = await tauriApi.getMeetingIssueHistory();
    },

    async loadDay(date: string, forceRefresh = false) {
      this.loading = true;
      this.error = null;
      this.selectedDate = date;
      try {
        await this.loadRulesAndHistory();
        // При явном «Обновить» — один range-refresh worklog из Jira за день в кэш.
        if (forceRefresh) await this.refreshDayFromJira(date);
        const exchangeProfile = await tauriApi
          .listExchangeProfiles()
          .then((ps) => ps.find((p) => p.isActive));
        if (!exchangeProfile)
          throw new Error('Нет активного профиля Exchange. Настройте в Настройках.');
        const connParams = tauriApi.profileToConnectionParams(exchangeProfile);
        const events = await tauriApi.getCalendarEvents(
          connParams,
          date + 'T00:00:00Z',
          date + 'T23:59:59Z',
          forceRefresh,
        );
        const wls = await tauriApi.listCachedWorklogs(date, date);
        this.worklogTodaySeconds = wls.reduce((s, w) => s + w.timeSpentSeconds, 0);
        // Дедупликация: ключ issueKey|дата|HH:MM (нормализованное локальное время начала)
        this.existingKeys = new Set(
          wls.map((w) => this.dedupKey(w.issueKey, w.started)),
        );
        this.rows = await Promise.all(
          events.map(async (ev) => {
            const suggestion = await tauriApi.suggestIssueForMeeting(
              ev.subject,
              ev.seriesMasterId ?? null,
            );
            const roundedSeconds = this.roundDuration(ev.durationMinutes);
            const startedLocal = this.toJiraStarted(ev.startAt);
            const issueKey = suggestion.issueKey ?? null;
            // Помечаем уже залогированным, если в кэше есть запись с тем же ключом
            const alreadyLogged =
              !!issueKey && this.existingKeys.has(this.dedupKey(issueKey, startedLocal));
            return {
              event: ev,
              suggestion,
              selectedIssueKey: issueKey,
              selectedIssueSummary: suggestion.issueSummary ?? null,
              comment: ev.subject,
              roundedSeconds,
              startedLocal,
              logged: alreadyLogged,
              logError: alreadyLogged ? 'Уже залогировано' : null,
            } as MeetingRow;
          }),
        );
        // Параллельно подгружаем сводку недели (без блокировки дня)
        this.loadWeek().catch(() => {});
      } catch (e: unknown) {
        this.error = String(e);
      } finally {
        this.loading = false;
      }
    },

    /** Ключ дедупликации: issueKey|YYYY-MM-DD|HH:MM (локальное время начала). */
    dedupKey(issueKey: string, startedJiraIso: string): string {
      const local = this.toLocalHHMM(startedJiraIso);
      const date = startedJiraIso.slice(0, 10);
      return `${issueKey}|${date}|${local}`;
    },

    /** Локальные HH:MM из Jira started (уже в локальной TZ с offset). */
    toLocalHHMM(startedJiraIso: string): string {
      // startedJiraIso вида «2026-08-18T09:30:00.000+0300» — берём время как есть
      const m = startedJiraIso.match(/T(\d{2}:\d{2})/);
      return m ? m[1] : '00:00';
    },

    async loadWeek() {
      this.weekLoading = true;
      try {
        const from = this.weekStart;
        const to = this.weekEnd;
        const wls = await tauriApi.listCachedWorklogs(from, to);
        // Защита от race при быстрой навигации: если неделя сменилась — выходим.
        if (from !== this.weekStart) return;
        const byDate = new Map<string, { issueKey: string; seconds: number; comment: string | null }[]>();
        for (const w of wls) {
          const d = w.started.slice(0, 10);
          if (!byDate.has(d)) byDate.set(d, []);
          byDate.get(d)!.push({
            issueKey: w.issueKey,
            seconds: w.timeSpentSeconds,
            comment: w.comment ?? null,
          });
        }
        const days: typeof this.weekSummary = [];
        for (let i = 0; i < 7; i++) {
          const date = addDays(from, i);
          const dt = new Date(date + 'T12:00:00');
          const items = byDate.get(date) ?? [];
          days.push({
            date,
            weekday: WEEKDAY_RU_FULL[dt.getDay()] ?? '',
            totalSeconds: items.reduce((s, it) => s + it.seconds, 0),
            items,
          });
        }
        this.weekSummary = days;
      } finally {
        this.weekLoading = false;
      }
    },

    /**
     * Один range-refresh worklog из Jira за выбранный день в локальный кэш.
     * Использует getWorklogsSince с since=0 + dateRange — один запрос к Jira,
     * не перегружая канал. После этого listCachedWorklogs возвращает свежие данные.
     */
    async refreshDayFromJira(date: string) {
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) return;
      try {
        const dtos = await tauriApi.getWorklogsSince(params, 0, [], {
          dateFrom: date,
          dateTo: date,
        });
        for (const dto of dtos) {
          // Минимальная CachedWorklogRow для upsert
          await tauriApi.upsertCachedWorklog({
            rowKey: `${dto.issueKey ?? 'unknown'}|${date}|${dto.started.slice(11, 16)}`,
            worklogId: dto.id,
            issueKey: dto.issueKey ?? 'unknown',
            issueSummary: null,
            projectKey: null,
            started: dto.started,
            timeSpentSeconds: dto.timeSpentSeconds,
            comment: dto.comment ?? null,
            updated: null,
            syncedAt: new Date().toISOString(),
          });
        }
      } catch {
        // Не блокируем загрузку дня, если Jira недоступен
      }
    },

    navigateDay(delta: number) {
      const next = addDays(this.selectedDate, delta);
      this.loadDay(next);
    },

    setIssueForRow(idx: number, issueKey: string, issueSummary: string | null) {
      const row = this.rows[idx];
      if (!row) return;
      row.selectedIssueKey = issueKey;
      row.selectedIssueSummary = issueSummary;
      tauriApi.rememberMeetingIssueMatch(
        row.event.subject,
        row.event.seriesMasterId ?? null,
        issueKey,
        issueSummary,
      );
    },

    async logSingleRow(idx: number) {
      const row = this.rows[idx];
      if (!row?.selectedIssueKey || !row.startedLocal) return;
      // Дедуп: повторная проверка перед отправкой в Jira
      const key = this.dedupKey(row.selectedIssueKey, row.startedLocal);
      if (this.existingKeys.has(key)) {
        row.logged = true;
        row.logError = 'Уже залогировано';
        return;
      }
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) throw new Error('Нет активного Jira профиля');
      try {
        await tauriApi.addWorklog(
          params,
          row.selectedIssueKey,
          row.startedLocal,
          row.roundedSeconds,
          row.comment,
        );
        await tauriApi.rememberMeetingIssueMatch(
          row.event.subject,
          row.event.seriesMasterId ?? null,
          row.selectedIssueKey,
          row.selectedIssueSummary,
        );
        this.existingKeys.add(key);
        row.logged = true;
        row.logError = null;
        this.loadWeek().catch(() => {});
      } catch (e: unknown) {
        row.logError = String(e);
      }
    },

    buildBulkPreview(): DayBulkPreviewItem[] {
      this.bulkPreview = this.rows
        .filter((r) => r.selectedIssueKey && r.startedLocal && !r.logged)
        .filter((r) => !this.existingKeys.has(this.dedupKey(r.selectedIssueKey!, r.startedLocal!)))
        .map((r) => ({
          event: r.event,
          issueKey: r.selectedIssueKey!,
          issueSummary: r.selectedIssueSummary,
          comment: r.comment,
          startedLocal: r.startedLocal!,
          roundedSeconds: r.roundedSeconds,
        }));
      return this.bulkPreview;
    },

    async logBulk(items: DayBulkPreviewItem[]) {
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) throw new Error('Нет активного Jira профиля');
      // Повторная проверка дедупа прямо перед отправкой: preview мог устареть.
      const toSend = items.filter(
        (i) => !this.existingKeys.has(this.dedupKey(i.issueKey, i.startedLocal)),
      );
      // Уже залогированные помечаем как есть.
      items.forEach((i) => {
        if (this.existingKeys.has(this.dedupKey(i.issueKey, i.startedLocal))) {
          const rowIdx = this.rows.findIndex((r) => r.event.id === i.event.id);
          if (rowIdx >= 0) {
            this.rows[rowIdx].logged = true;
            this.rows[rowIdx].logError = 'Уже залогировано';
          }
        }
      });
      if (toSend.length === 0) return [] as BulkResultItem[];
      const entries: NewWorklogEntry[] = toSend.map((i) => ({
        issueKey: i.issueKey,
        startedAt: i.startedLocal,
        timeSpentSeconds: i.roundedSeconds,
        comment: i.comment,
      }));
      const results: BulkResultItem[] = await tauriApi.bulkAddWorklogs(
        params,
        entries,
      );
      // Результаты соответствуют toSend, не исходным items.
      results.forEach((res, i) => {
        const item = toSend[i];
        if (!item) return;
        const rowIdx = this.rows.findIndex((r) => r.event.id === item.event.id);
        if (rowIdx >= 0) {
          this.rows[rowIdx].logged = res.success;
          if (!res.success) this.rows[rowIdx].logError = res.error ?? 'Ошибка';
        }
        if (res.success) {
          this.existingKeys.add(this.dedupKey(item.issueKey, item.startedLocal));
          tauriApi.rememberMeetingIssueMatch(
            item.event.subject,
            item.event.seriesMasterId ?? null,
            item.issueKey,
            item.issueSummary,
          );
        }
      });
      this.loadWeek().catch(() => {});
      return results;
    },
  },
});

/**
 * Вычисляет смещение часового пояса tz в мс для даты dt.
 * Использует Intl.DateTimeFormat — даёт точное DST-корректное смещение.
 */
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

const WEEKDAY_RU_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function isoWeekStart(isoDate: string): string {
  const d = new Date(isoDate + 'T12:00:00Z');
  // Понедельник = 1 в UTC
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow; // к понедельнику
  return addDays(isoDate, diff);
}
