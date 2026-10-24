// Стор экрана «Собрать день»: загрузка уже залогированного, истории привычных задач
// и встреч календаря, сборка предложения (utils/dayComposer) и отправка в Jira.
import { defineStore } from 'pinia';
import { tauriApi, type CachedWorklogRow, type BulkResultItem } from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useSettingsStore } from './settings';
import { useDayFromCalendarStore } from './dayFromCalendar';
import { useAnalyticsStore } from './analytics';
import { addDaysIso, formatJiraStarted, jiraStartedFromLocal, localIsoDate, zonedDayBounds } from '../utils/time';
import { datesInRange, isWorkingDay } from '../utils/worklogChecks';
import {
  composeDay, findHabits, hhmmToMinutes, minutesToHHMM, startMinutesOf,
  type ComposerMeeting, type HabitTask, type ProposalItem,
} from '../utils/dayComposer';

const PREFS_KEY = 'jiratime-compose-prefs';

interface ComposePrefs {
  dayStart: string;
  dayEnd: string;
  lunchEnabled: boolean;
  lunchStart: string;
  lunchEnd: string;
  historyWeeks: number;
  useMeetings: boolean;
}

const DEFAULT_PREFS: ComposePrefs = {
  dayStart: '09:00', dayEnd: '18:00', lunchEnabled: true, lunchStart: '13:00', lunchEnd: '14:00',
  historyWeeks: 4, useMeetings: true,
};

function loadPrefs(): ComposePrefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let seq = 0;
let manualSeq = 0;

export const useComposeStore = defineStore('compose', {
  state: () => ({
    date: localIsoDate(),
    targetHours: 0,
    prefs: loadPrefs(),
    existing: [] as CachedWorklogRow[],
    history: [] as CachedWorklogRow[],
    habits: [] as HabitTask[],
    meetings: [] as ComposerMeeting[],
    meetingsNote: '' as string,
    proposal: [] as ProposalItem[],
    loading: false,
    refreshingHistory: false,
    submitting: false,
    error: null as string | null,
    submitMessage: null as { ok: boolean; text: string } | null,
    rowErrors: {} as Record<string, string>,
  }),

  getters: {
    filledMinutes(state): number {
      return Math.round(state.existing.reduce((s, w) => s + w.timeSpentSeconds, 0) / 60);
    },
    proposedMinutes(state): number {
      return state.proposal.filter((p) => p.include).reduce((s, p) => s + (Number(p.minutes) || 0), 0);
    },
    targetMinutes(state): number {
      return Math.round((Number(state.targetHours) || 0) * 60);
    },
    isWorkday(state): boolean {
      const settings = useSettingsStore();
      return isWorkingDay(state.date, {
        workdays: settings.workdays,
        holidays: new Set(settings.holidays.map((h) => h.date)),
      });
    },
  },

  actions: {
    savePrefs() {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* private mode */ }
    },

    historyRange(): { from: string; to: string } {
      return { from: addDaysIso(this.date, -7 * this.prefs.historyWeeks), to: addDaysIso(this.date, -1) };
    },

    /** Загружает всё нужное для даты и сразу собирает предложение. */
    async load(date?: string, refreshDay = true) {
      date = date ?? this.date;
      const token = ++seq;
      const settings = useSettingsStore();
      if (!this.targetHours) this.targetHours = settings.workdayHours || 8;
      this.date = date;
      this.loading = true;
      this.error = null;
      this.submitMessage = null;
      this.rowErrors = {};
      try {
        const jp = useJiraProfilesStore();
        await jp.ensureLoaded();
        // Свежие данные дня из Jira (best-effort): чтобы «уже заполнено» было точным.
        if (refreshDay && jp.activeConnectionParams) {
          await useDayFromCalendarStore().refreshRangeFromJira(date, date).catch(() => {});
        }
        const { from, to } = this.historyRange();
        const [existing, history] = await Promise.all([
          tauriApi.listCachedWorklogs(date, date),
          tauriApi.listCachedWorklogs(from, to),
        ]);
        if (token !== seq) return;
        this.existing = existing.sort((a, b) => a.started.localeCompare(b.started));
        this.history = history;

        const holidays = new Set(settings.holidays.map((h) => h.date));
        const workdays = datesInRange(from, to).filter((d) => isWorkingDay(d, { workdays: settings.workdays, holidays }));
        this.habits = findHabits(history, workdays, date);

        this.meetings = this.prefs.useMeetings ? await this.loadMeetings(date) : [];
        if (token !== seq) return;
        this.compose();
      } catch (e) {
        if (token === seq) this.error = e instanceof Error ? e.message : String(e);
      } finally {
        if (token === seq) this.loading = false;
      }
    },

    /** Встречи дня с подобранной задачей (без активного Exchange — пусто, без ошибки). */
    async loadMeetings(date: string): Promise<ComposerMeeting[]> {
      this.meetingsNote = '';
      try {
        const profile = (await tauriApi.listExchangeProfiles()).find((p) => p.isActive);
        if (!profile) { this.meetingsNote = 'Календарь не подключён — предлагаются только привычные задачи.'; return []; }
        const tz = useSettingsStore().timezone;
        const bounds = zonedDayBounds(date, tz);
        const events = await tauriApi.getCalendarEvents(tauriApi.profileToConnectionParams(profile), bounds.from, bounds.to, false);
        const out: ComposerMeeting[] = [];
        let unmatched = 0;
        for (const ev of events) {
          const s = await tauriApi.suggestIssueForMeeting(ev.subject, ev.seriesMasterId ?? null);
          if (!s.issueKey) { unmatched++; continue; }
          out.push({
            issueKey: s.issueKey, issueSummary: s.issueSummary ?? null, subject: ev.subject,
            start: startMinutesOf(formatJiraStarted(new Date(ev.startAt), tz)), minutes: ev.durationMinutes,
          });
        }
        if (unmatched) this.meetingsNote = `${unmatched} встреч(и) без задачи — сопоставьте их на экране «Календарь → Jira».`;
        return out;
      } catch (e) {
        this.meetingsNote = `Календарь недоступен: ${e instanceof Error ? e.message : e}`;
        return [];
      }
    },

    /** Пересобирает предложение по текущим данным и настройкам. */
    compose() {
      this.savePrefs();
      this.rowErrors = {};
      this.proposal = composeDay(
        this.existing,
        this.meetings,
        this.habits,
        {
          date: this.date,
          targetHours: Number(this.targetHours) || 0,
          stepMinutes: 15,
          dayStart: hhmmToMinutes(this.prefs.dayStart),
          dayEnd: hhmmToMinutes(this.prefs.dayEnd),
          lunch: this.prefs.lunchEnabled ? [hhmmToMinutes(this.prefs.lunchStart), hhmmToMinutes(this.prefs.lunchEnd)] : null,
        },
      );
    },

    /** Подтягивает историю за окно из Jira и пересобирает (если кэш неполный). */
    async refreshHistory() {
      this.refreshingHistory = true;
      try {
        const { from, to } = this.historyRange();
        await useDayFromCalendarStore().refreshRangeFromJira(from, to);
        await this.load(this.date, true);
      } finally {
        this.refreshingHistory = false;
      }
    },

    addRow(habit?: HabitTask) {
      const lastEnd = [...this.existing.map((w) => startMinutesOf(w.started) + Math.round(w.timeSpentSeconds / 60)),
        ...this.proposal.map((p) => p.start + p.minutes)].reduce((m, v) => Math.max(m, v), hhmmToMinutes(this.prefs.dayStart));
      const remaining = Math.max(15, this.targetMinutes - this.filledMinutes - this.proposedMinutes);
      this.proposal.push({
        id: `m${++manualSeq}`,
        issueKey: habit?.issueKey ?? '',
        issueSummary: habit?.issueSummary ?? null,
        start: lastEnd,
        minutes: Math.min(habit?.typicalMinutes ?? remaining, remaining),
        comment: habit?.typicalComment ?? '',
        source: 'manual',
        reason: habit ? 'добавлено вручную из привычных' : 'добавлено вручную',
        include: true,
      });
    },

    removeRow(id: string) {
      this.proposal = this.proposal.filter((p) => p.id !== id);
    },

    async submit(): Promise<BulkResultItem[]> {
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) throw new Error('Нет активного профиля Jira');
      const tz = useSettingsStore().timezone;
      const rows = this.proposal.filter((p) => p.include && p.issueKey.trim() && p.minutes > 0);
      if (!rows.length) return [];
      this.submitting = true;
      this.submitMessage = null;
      this.rowErrors = {};
      try {
        const entries = rows.map((p) => ({
          issueKey: p.issueKey.trim().toUpperCase(),
          startedAt: jiraStartedFromLocal(this.date, minutesToHHMM(p.start), tz),
          timeSpentSeconds: Math.round(p.minutes * 60),
          comment: p.comment || null,
        }));
        const results = await tauriApi.bulkAddWorklogs(params, entries);
        const okIds = new Set<string>();
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const p = rows[i];
          const e = entries[i];
          if (!p) continue;
          if (r.success) {
            okIds.add(p.id);
            await tauriApi.upsertCachedWorklog({
              rowKey: r.worklogId ? `wl:${r.worklogId}` : `local:${e.issueKey}:${e.startedAt}:${p.id}`,
              worklogId: r.worklogId ?? null, issueKey: e.issueKey, issueSummary: p.issueSummary,
              projectKey: e.issueKey.split('-')[0] ?? null, started: e.startedAt,
              timeSpentSeconds: e.timeSpentSeconds, comment: e.comment, updated: null,
              syncedAt: new Date().toISOString(),
            }).catch(() => {});
          } else {
            this.rowErrors[p.id] = r.error ?? 'Ошибка Jira';
          }
        }
        if (okIds.size) useAnalyticsStore().trackBulkEntries(okIds.size);
        this.proposal = this.proposal.filter((p) => !okIds.has(p.id));
        this.existing = (await tauriApi.listCachedWorklogs(this.date, this.date)).sort((a, b) => a.started.localeCompare(b.started));
        const failed = results.length - okIds.size;
        this.submitMessage = failed
          ? { ok: false, text: `Залогировано ${okIds.size}, с ошибкой ${failed} — исправьте отмеченные строки и повторите.` }
          : { ok: true, text: `Готово: залогировано ${okIds.size} ${okIds.size === 1 ? 'запись' : 'записей'}.` };
        return results;
      } finally {
        this.submitting = false;
      }
    },
  },
});
