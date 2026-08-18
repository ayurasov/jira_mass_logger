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
        this.rows = await Promise.all(
          events.map(async (ev) => {
            const suggestion = await tauriApi.suggestIssueForMeeting(
              ev.subject,
              ev.seriesMasterId ?? null,
            );
            return {
              event: ev,
              suggestion,
              selectedIssueKey: suggestion.issueKey ?? null,
              selectedIssueSummary: suggestion.issueSummary ?? null,
              comment: ev.subject,
              roundedSeconds: this.roundDuration(ev.durationMinutes),
              startedLocal: this.toJiraStarted(ev.startAt),
              logged: false,
              logError: null,
            } as MeetingRow;
          }),
        );
      } catch (e: unknown) {
        this.error = String(e);
      } finally {
        this.loading = false;
      }
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
      const jp = useJiraProfilesStore();
      if (!jp.activeProfile) throw new Error('Нет активного Jira профиля');
      try {
        await tauriApi.addWorklog(
          jp.activeConnectionParams,
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
        row.logged = true;
        row.logError = null;
      } catch (e: unknown) {
        row.logError = String(e);
      }
    },

    buildBulkPreview(): DayBulkPreviewItem[] {
      this.bulkPreview = this.rows
        .filter((r) => r.selectedIssueKey && r.startedLocal && !r.logged)
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
      if (!jp.activeProfile) throw new Error('Нет активного Jira профиля');
      const entries: NewWorklogEntry[] = items.map((i) => ({
        issueKey: i.issueKey,
        startedAt: i.startedLocal,
        timeSpentSeconds: i.roundedSeconds,
        comment: i.comment,
      }));
      const results: BulkResultItem[] = await tauriApi.bulkAddWorklogs(
        jp.activeConnectionParams,
        entries,
      );
      results.forEach((res, i) => {
        const rowIdx = this.rows.findIndex((r) => r.event.id === items[i]?.event.id);
        if (rowIdx >= 0) {
          this.rows[rowIdx].logged = res.success;
          if (!res.success) this.rows[rowIdx].logError = res.error ?? 'Ошибка';
        }
        if (res.success && items[i]) {
          tauriApi.rememberMeetingIssueMatch(
            items[i].event.subject,
            items[i].event.seriesMasterId ?? null,
            items[i].issueKey,
            items[i].issueSummary,
          );
        }
      });
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
