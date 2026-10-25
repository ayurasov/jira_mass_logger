// Стор экрана «Собрать день»: загрузка уже залогированного, истории привычных задач
// и встреч календаря, сборка предложения (utils/dayComposer) и отправка в Jira.
//
// Модель: правки пользователя (userItems) фиксируются, всё остальное — автоматическое
// и пересобирается после каждой правки или смены цели, так что сумма дня всегда
// равна цели. «Пересобрать» сбрасывает правки и убранные задачи.
import { defineStore } from 'pinia';
import { tauriApi, type CachedWorklogRow, type BulkResultItem } from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useSettingsStore } from './settings';
import { useDayFromCalendarStore } from './dayFromCalendar';
import { useAnalyticsStore } from './analytics';
import { addDaysIso, formatJiraStarted, jiraStartedFromLocal, localIsoDate, zonedDayBounds } from '../utils/time';
import { datesInRange, isWorkingDay } from '../utils/worklogChecks';
import {
  buildPlan, commentSuggestions, findHabits, hhmmToMinutes, minutesToHHMM, startMinutesOf, unfilledDays,
  type ComposeOptions, type ComposerMeeting, type HabitTask, type ProposalItem,
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
  /** После успешной отправки сразу открывать следующий незаполненный день. */
  autoAdvance: boolean;
}

const DEFAULT_PREFS: ComposePrefs = {
  dayStart: '09:00', dayEnd: '18:00', lunchEnabled: true, lunchStart: '13:00', lunchEnd: '14:00',
  historyWeeks: 4, useMeetings: true, autoAdvance: true,
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
    /** Строки, которые правил пользователь: при пересборке не меняются. */
    userItems: [] as ProposalItem[],
    dismissedKeys: [] as string[],
    dismissedMeetings: [] as string[],
    /** Незаполненные рабочие дни за последние 2 недели (для быстрого перехода). */
    unfilled: [] as { date: string; minutes: number }[],
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
      return state.proposal.reduce((s, p) => s + (Number(p.minutes) || 0), 0);
    },
    composeOptions(state): ComposeOptions {
      return {
        date: state.date,
        targetHours: Number(state.targetHours) || 0,
        stepMinutes: 15,
        dayStart: hhmmToMinutes(state.prefs.dayStart),
        dayEnd: hhmmToMinutes(state.prefs.dayEnd),
        lunch: state.prefs.lunchEnabled ? [hhmmToMinutes(state.prefs.lunchStart), hhmmToMinutes(state.prefs.lunchEnd)] : null,
      };
    },
    /** Следующий незаполненный день (кроме текущего) — для перехода после отправки. */
    nextUnfilled(state): string | null {
      return state.unfilled.find((d) => d.date !== state.date)?.date ?? null;
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
      // Новый день — новые правки.
      this.userItems = [];
      this.dismissedKeys = [];
      this.dismissedMeetings = [];
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
        this.rebuild();
        this.refreshUnfilled().catch(() => {});
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
        // Задача «по умолчанию» для встреч без правила: самая частая из истории встреч,
        // иначе самая привычная задача — чтобы день собирался без ручного выбора.
        const meetingHistory = await tauriApi.getMeetingIssueHistory().catch(() => []);
        const fallback = [...meetingHistory].sort((a, b) => b.useCount - a.useCount)[0];
        const fallbackKey = fallback?.issueKey ?? this.habits[0]?.issueKey ?? null;
        const fallbackSummary = fallback?.issueSummary ?? this.habits[0]?.issueSummary ?? null;
        const out: ComposerMeeting[] = [];
        let guessed = 0;
        for (const ev of events) {
          const s = await tauriApi.suggestIssueForMeeting(ev.subject, ev.seriesMasterId ?? null);
          const key = s.issueKey ?? fallbackKey;
          if (!key) continue;
          if (!s.issueKey) guessed++;
          out.push({
            id: ev.id, issueKey: key, issueSummary: (s.issueKey ? s.issueSummary : fallbackSummary) ?? null, subject: ev.subject,
            start: startMinutesOf(formatJiraStarted(new Date(ev.startAt), tz)), minutes: ev.durationMinutes,
            guessed: !s.issueKey,
          });
        }
        if (guessed) this.meetingsNote = `${guessed} встреч(и) без правила — подставлена задача ${fallbackKey}; проверьте отмеченные строки.`;
        return out;
      } catch (e) {
        this.meetingsNote = `Календарь недоступен: ${e instanceof Error ? e.message : e}`;
        return [];
      }
    },

    /** Пересчитывает план: правки пользователя + автоматическое остальное (сумма = цели). */
    rebuild(pinnedId?: string) {
      this.savePrefs();
      this.proposal = buildPlan({
        existing: this.existing,
        meetings: this.meetings,
        habits: this.habits,
        opts: this.composeOptions,
        userItems: this.userItems,
        dismissedKeys: new Set(this.dismissedKeys),
        dismissedMeetings: new Set(this.dismissedMeetings),
        pinnedId,
      });
      // Правки, урезанные до нуля при переборе, убираем и из списка правок.
      const alive = new Set(this.proposal.map((p) => p.id));
      this.userItems = this.userItems.filter((u) => alive.has(u.id))
        .map((u) => ({ ...u, minutes: this.proposal.find((p) => p.id === u.id)!.minutes }));
    },

    /** «Пересобрать»: забыть правки и убранные задачи, собрать день заново. */
    reset() {
      this.userItems = [];
      this.dismissedKeys = [];
      this.dismissedMeetings = [];
      this.rowErrors = {};
      this.rebuild();
    },

    /** Подсказки описания для задачи — из прошлых описаний. */
    suggestionsFor(issueKey: string): string[] {
      return commentSuggestions([...this.history, ...this.existing], issueKey.trim().toUpperCase());
    },

    /**
     * Правка строки (время, длительность, задача, описание): строка фиксируется,
     * остальное автоматически перестраивается под цель.
     */
    editItem(id: string, patch: Partial<Pick<ProposalItem, 'start' | 'minutes' | 'issueKey' | 'comment'>>) {
      const current = this.proposal.find((p) => p.id === id);
      if (!current) return;
      let item = this.userItems.find((u) => u.id === id);
      if (!item) {
        item = { ...current, locked: true };
        this.userItems.push(item);
      }
      if (patch.issueKey !== undefined && patch.issueKey.trim().toUpperCase() !== item.issueKey) {
        const key = patch.issueKey.trim().toUpperCase();
        const prevAuto = this.suggestionsFor(item.issueKey)[0] ?? '';
        const habit = this.habits.find((h) => h.issueKey === key);
        item.issueKey = key;
        item.issueSummary = habit?.issueSummary ?? null;
        item.guessed = false;
        // Описание было автоматическим (или пустым) — подставляем типичное для новой задачи.
        if (!item.comment || item.comment === prevAuto) {
          item.comment = this.suggestionsFor(key)[0] ?? habit?.issueSummary ?? item.comment;
        }
      }
      if (patch.comment !== undefined) item.comment = patch.comment;
      if (patch.start !== undefined) item.start = Math.max(0, Math.min(24 * 60 - 15, Math.round(patch.start / 15) * 15));
      if (patch.minutes !== undefined) item.minutes = Math.max(15, Math.round(patch.minutes / 15) * 15);
      this.rebuild(id);
    },

    /** Убрать строку: её задача/встреча больше не предлагается до «Пересобрать». */
    removeItem(id: string) {
      const p = this.proposal.find((x) => x.id === id);
      if (!p) return;
      this.userItems = this.userItems.filter((u) => u.id !== id);
      if (p.meetingId) this.dismissedMeetings.push(p.meetingId);
      else if (p.source !== 'manual') this.dismissedKeys.push(p.issueKey);
      this.rebuild();
    },

    addRow(habit?: HabitTask) {
      const lastEnd = [...this.existing.map((w) => startMinutesOf(w.started) + Math.round(w.timeSpentSeconds / 60)),
        ...this.proposal.map((p) => p.start + p.minutes)].reduce((m, v) => Math.max(m, v), hhmmToMinutes(this.prefs.dayStart));
      const id = `m${++manualSeq}`;
      const key = habit?.issueKey ?? '';
      this.userItems.push({
        id,
        issueKey: key,
        issueSummary: habit?.issueSummary ?? null,
        start: Math.min(lastEnd, 24 * 60 - 60),
        minutes: habit?.typicalMinutes ?? 60,
        comment: key ? (this.suggestionsFor(key)[0] ?? habit?.typicalComment ?? '') : '',
        source: 'manual',
        reason: habit ? 'добавлено из привычных' : 'добавлено вручную',
        include: true,
        locked: true,
      });
      if (habit) this.dismissedKeys = this.dismissedKeys.filter((k) => k !== habit.issueKey);
      this.rebuild(id);
    },

    /** Незаполненные рабочие дни за 2 недели до сегодня. */
    async refreshUnfilled() {
      const settings = useSettingsStore();
      const today = localIsoDate();
      const from = addDaysIso(today, -13);
      const rows = await tauriApi.listCachedWorklogs(from, today);
      const holidays = new Set(settings.holidays.map((h) => h.date));
      const workdays = datesInRange(from, today).filter((d) => isWorkingDay(d, { workdays: settings.workdays, holidays }));
      this.unfilled = unfilledDays(rows, workdays, today, (settings.workdayHours || 8) * 60).reverse();
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

    async submit(): Promise<BulkResultItem[]> {
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) throw new Error('Нет активного профиля Jira');
      const tz = useSettingsStore().timezone;
      const rows = this.proposal.filter((p) => p.issueKey.trim() && p.minutes > 0);
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
        this.existing = (await tauriApi.listCachedWorklogs(this.date, this.date)).sort((a, b) => a.started.localeCompare(b.started));
        // Отправленное стало «уже залогированным»; неотправленные строки остаются правками.
        const failedRows = rows.filter((p) => !okIds.has(p.id));
        this.userItems = failedRows.map((p) => ({ ...p, locked: true }));
        this.rebuild();
        await this.refreshUnfilled().catch(() => {});
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
