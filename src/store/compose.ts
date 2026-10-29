// Стор экрана «Собрать день»: загрузка уже залогированного, истории привычных задач
// и встреч календаря, сборка предложения (utils/dayComposer) и отправка в Jira.
//
// Модель: правки пользователя (userItems) фиксируются, всё остальное — автоматическое
// и пересобирается после каждой правки или смены цели, так что сумма дня всегда
// равна цели. Утверждённые строки не меняются вовсе: до цели добираются остальные.
// «Пересобрать» сбрасывает правки и убранные задачи, утверждённые строки оставляет.
import { defineStore } from 'pinia';
import { tauriApi, type CachedWorklogRow, type BulkResultItem } from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useSettingsStore } from './settings';
import { useDayFromCalendarStore } from './dayFromCalendar';
import { useAnalyticsStore } from './analytics';
import { useFavoriteTasksStore } from './favoriteTasks';
import { addDaysIso, formatJiraStarted, jiraStartedFromLocal, localIsoDate, zonedDayBounds } from '../utils/time';
import { datesInRange, isWorkingDay } from '../utils/worklogChecks';
import {
  buildPlan, commentSuggestions, findHabits, findOverlaps, hhmmToMinutes, minutesToHHMM, placeNewRow, startMinutesOf, unfilledDays,
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
  /** Выбор по привычным задачам: true — предлагать при сборке дня, false — не предлагать. */
  habitChoices: Record<string, boolean>;
  /** Предлагать привычные задачи, по которым выбора ещё не было (новые). */
  proposeNewHabits: boolean;
}

const DEFAULT_PREFS: ComposePrefs = {
  dayStart: '09:00', dayEnd: '18:00', lunchEnabled: true, lunchStart: '13:00', lunchEnd: '14:00',
  historyWeeks: 4, useMeetings: true, autoAdvance: true, habitChoices: {}, proposeNewHabits: true,
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
/** История окна уже подтягивалась из Jira в этом сеансе — повторно не ходим. */
const historyRefreshed = new Set<string>();
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

/** Всё, что нужно для сборки одного дня. */
interface DayContext {
  existing: CachedWorklogRow[];
  history: CachedWorklogRow[];
  habits: HabitTask[];
  meetings: ComposerMeeting[];
  meetingsNote: string;
  /** Привычных задач по истории нет — подставлена избранная задача. */
  favoriteFallback: boolean;
}

/** Результат заполнения одного дня в пакетном режиме. */
export interface FillDayResult {
  date: string;
  ok: boolean;
  /** Сколько минут залогировано. */
  minutes: number;
  entries: number;
  /** Почему день пропущен или что пошло не так. */
  message: string;
}

/** Созданная запись — для «Отменить». */
interface CreatedWorklog { issueKey: string; worklogId: string | null; rowKey: string }

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
    /** Пакетное заполнение («одним нажатием»): прогресс и итог. */
    batch: {
      running: false,
      total: 0,
      done: 0,
      current: '' as string,
      results: [] as FillDayResult[],
    },
    /** Записи последнего пакетного заполнения — их можно отменить одним нажатием. */
    lastBatchCreated: [] as CreatedWorklog[],
    undoing: false,
    favoriteFallback: false,
  }),

  getters: {
    filledMinutes(state): number {
      return Math.round(state.existing.reduce((s, w) => s + w.timeSpentSeconds, 0) / 60);
    },
    proposedMinutes(state): number {
      return state.proposal.reduce((s, p) => s + (Number(p.minutes) || 0), 0);
    },
    approvedMinutes(state): number {
      return state.proposal.reduce((s, p) => s + (p.approved ? Number(p.minutes) || 0 : 0), 0);
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
    /** Предлагается ли привычная задача при сборке дня (её можно добавить вручную в любом случае). */
    isHabitProposed(state): (issueKey: string) => boolean {
      return (issueKey) => state.prefs.habitChoices[issueKey] ?? state.prefs.proposeNewHabits;
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
      // Новый день — новые правки; старое предложение сразу убираем.
      this.proposal = [];
      this.userItems = [];
      this.dismissedKeys = [];
      this.dismissedMeetings = [];
      try {
        const ctx = await this.dayContext(date, refreshDay);
        if (token !== seq) return;
        this.existing = ctx.existing;
        this.history = ctx.history;
        this.habits = ctx.habits;
        this.meetings = ctx.meetings;
        this.meetingsNote = ctx.meetingsNote;
        this.favoriteFallback = ctx.favoriteFallback;
        this.rebuild();
        this.refreshUnfilled().catch(() => {});
      } catch (e) {
        if (token === seq) this.error = e instanceof Error ? e.message : String(e);
      } finally {
        if (token === seq) this.loading = false;
      }
    },

    /**
     * Данные для сборки дня, без изменения состояния экрана (используется и пакетным
     * заполнением): уже залогированное, история окна, привычные задачи, встречи.
     */
    async dayContext(date: string, refreshDay: boolean): Promise<DayContext> {
      const settings = useSettingsStore();
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      // Свежие данные дня из Jira (best-effort): чтобы «уже заполнено» было точным.
      if (refreshDay && jp.activeConnectionParams) {
        await useDayFromCalendarStore().refreshRangeFromJira(date, date).catch(() => {});
      }
      const historyWeeks = this.prefs.historyWeeks;
      const from = addDaysIso(date, -7 * historyWeeks);
      const to = addDaysIso(date, -1);
      let [existing, history] = await Promise.all([
        tauriApi.listCachedWorklogs(date, date),
        tauriApi.listCachedWorklogs(from, to),
      ]);
      // Истории в кэше нет (новая установка, долго не открывали дашборд) — один раз за сеанс
      // подтягиваем окно из Jira, иначе привычных задач не будет и день не соберётся до нормы.
      const windowKey = `${from}..${to}`;
      if (history.length < 3 && jp.activeConnectionParams && !historyRefreshed.has(windowKey)) {
        historyRefreshed.add(windowKey);
        await useDayFromCalendarStore().refreshRangeFromJira(from, to).catch(() => {});
        history = await tauriApi.listCachedWorklogs(from, to);
      }
      existing = existing.sort((a, b) => a.started.localeCompare(b.started));

      const holidays = new Set(settings.holidays.map((h) => h.date));
      const workdays = datesInRange(from, to).filter((d) => isWorkingDay(d, { workdays: settings.workdays, holidays }));
      let habits = findHabits(history, workdays, date);
      // Истории нет и в Jira — берём избранную задачу (её видно и можно поменять на экране).
      let favoriteFallback = false;
      if (!habits.length) {
        const fav = useFavoriteTasksStore().items[0];
        if (fav) {
          favoriteFallback = true;
          habits = [{
            issueKey: fav.issueKey, issueSummary: fav.issueSummary ?? null, frequency: 0, sameWeekdayFrequency: 0,
            typicalMinutes: 60, typicalStart: hhmmToMinutes(this.prefs.dayStart), typicalComment: fav.issueSummary ?? '',
            daysSeen: 0, score: 0,
          }];
        }
      }
      let meetings: ComposerMeeting[] = [];
      let meetingsNote = '';
      if (this.prefs.useMeetings) ({ meetings, note: meetingsNote } = await this.loadMeetings(date, habits.filter((h) => this.isHabitProposed(h.issueKey))));
      return { existing, history, habits, meetings, meetingsNote, favoriteFallback };
    },

    /** Встречи дня с подобранной задачей (без активного Exchange — пусто, без ошибки). */
    async loadMeetings(date: string, habits: HabitTask[]): Promise<{ meetings: ComposerMeeting[]; note: string }> {
      try {
        const profile = (await tauriApi.listExchangeProfiles()).find((p) => p.isActive);
        if (!profile) return { meetings: [], note: 'Календарь не подключён — предлагаются только привычные задачи.' };
        const tz = useSettingsStore().timezone;
        const bounds = zonedDayBounds(date, tz);
        const events = await tauriApi.getCalendarEvents(tauriApi.profileToConnectionParams(profile), bounds.from, bounds.to, false);
        // Задача «по умолчанию» для встреч без правила: самая частая из истории встреч,
        // иначе самая привычная задача — чтобы день собирался без ручного выбора.
        const meetingHistory = await tauriApi.getMeetingIssueHistory().catch(() => []);
        const fallback = [...meetingHistory].sort((a, b) => b.useCount - a.useCount)[0];
        const fallbackKey = fallback?.issueKey ?? habits[0]?.issueKey ?? null;
        const fallbackSummary = fallback?.issueSummary ?? habits[0]?.issueSummary ?? null;
        const out: ComposerMeeting[] = [];
        let guessed = 0;
        for (const ev of events) {
          const s = await tauriApi.suggestIssueForMeeting(ev.subject, ev.seriesMasterId ?? null);
          const key = s.issueKey ?? fallbackKey;
          if (!key) continue;
          if (!s.issueKey) guessed++;
          out.push({
            id: ev.id, seriesId: ev.seriesMasterId ?? null, issueKey: key, issueSummary: (s.issueKey ? s.issueSummary : fallbackSummary) ?? null, subject: ev.subject,
            start: startMinutesOf(formatJiraStarted(new Date(ev.startAt), tz)), minutes: ev.durationMinutes,
            guessed: !s.issueKey,
          });
        }
        const note = guessed ? `${guessed} встреч(и) без правила — подставлена задача ${fallbackKey}; проверьте отмеченные строки.` : '';
        return { meetings: out, note };
      } catch (e) {
        return { meetings: [], note: `Календарь недоступен: ${e instanceof Error ? e.message : e}` };
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
        dismissedKeys: new Set([...this.dismissedKeys, ...this.notProposedKeys(this.habits)]),
        dismissedMeetings: new Set(this.dismissedMeetings),
        pinnedId,
      });
      // Правки, урезанные до нуля при переборе, убираем и из списка правок.
      const alive = new Set(this.proposal.map((p) => p.id));
      this.userItems = this.userItems.filter((u) => alive.has(u.id))
        .map((u) => ({ ...u, minutes: this.proposal.find((p) => p.id === u.id)!.minutes }));
    },

    /** Ключи привычных задач, которые пользователь не хочет видеть в предложении. */
    notProposedKeys(habits: HabitTask[]): string[] {
      return habits.filter((h) => !this.isHabitProposed(h.issueKey)).map((h) => h.issueKey);
    },

    /** Предлагать привычную задачу при сборке дня или нет (выбор запоминается). */
    setHabitProposed(issueKey: string, proposed: boolean) {
      this.prefs.habitChoices = { ...this.prefs.habitChoices, [issueKey]: proposed };
      this.rebuild();
    },

    /**
     * Предлагать ли новые привычные задачи сразу. При выключении текущие задачи без выбора
     * остаются предлагаемыми — меняется только поведение для задач, которые появятся позже.
     */
    setProposeNewHabits(on: boolean) {
      if (!on) {
        const choices = { ...this.prefs.habitChoices };
        for (const h of this.habits) if (choices[h.issueKey] === undefined) choices[h.issueKey] = true;
        this.prefs.habitChoices = choices;
      }
      this.prefs.proposeNewHabits = on;
      this.rebuild();
    },

    /** «Пересобрать»: забыть правки и убранные задачи, собрать день заново. Утверждённые строки остаются. */
    reset() {
      this.userItems = this.userItems.filter((u) => u.approved);
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
    editItem(id: string, patch: Partial<Pick<ProposalItem, 'start' | 'minutes' | 'issueKey' | 'comment'>>): string | null {
      const current = this.proposal.find((p) => p.id === id);
      if (!current) return null;
      let item = this.userItems.find((u) => u.id === id);
      if (!item) {
        // Новая правка получает собственный id: автоматические id (a1, a2…) переиспользуются
        // при каждой пересборке и иначе совпадали бы с id правки.
        item = { ...current, id: `u${++manualSeq}`, locked: true };
        this.userItems.push(item);
      }
      if (patch.issueKey !== undefined && patch.issueKey.trim().toUpperCase() !== item.issueKey) {
        const key = patch.issueKey.trim().toUpperCase();
        const prevAuto = this.suggestionsFor(item.issueKey)[0] ?? '';
        const habit = this.habits.find((h) => h.issueKey === key);
        item.issueKey = key;
        item.issueSummary = habit?.issueSummary ?? null;
        item.guessed = false;
        // Задачу для встречи выбрали вручную — запоминаем для этой встречи/серии,
        // чтобы в следующий раз она подставилась сама (как на экране календаря).
        const meeting = item.meetingId ? this.meetings.find((m) => m.id === item!.meetingId) : null;
        if (meeting && /^[A-Z][A-Z0-9_]+-\d+$/.test(key)) {
          tauriApi.rememberMeetingIssueMatch(meeting.subject, meeting.seriesId ?? null, key, item.issueSummary).catch(() => {});
          meeting.issueKey = key;
          meeting.guessed = false;
        }
        // Описание было автоматическим (или пустым) — подставляем типичное для новой задачи.
        if (!item.comment || item.comment === prevAuto) {
          item.comment = this.suggestionsFor(key)[0] ?? habit?.issueSummary ?? item.comment;
        }
      }
      if (patch.comment !== undefined) item.comment = patch.comment;
      if (patch.start !== undefined) item.start = Math.max(0, Math.min(24 * 60 - 15, Math.round(patch.start / 15) * 15));
      if (patch.minutes !== undefined) item.minutes = Math.max(15, Math.round(patch.minutes / 15) * 15);
      this.rebuild(item.id);
      return item.id;
    },

    /**
     * Утвердить строку (или снять отметку). Утверждённую строку автоматика не меняет:
     * при удалении и правке других строк до цели добираются только неутверждённые.
     * Сама отметка план не пересобирает — остальные строки остаются на месте.
     * Снятая отметка оставляет строку как обычную правку.
     */
    setApproved(id: string, approved: boolean) {
      const current = this.proposal.find((p) => p.id === id);
      if (!current || !!current.approved === approved) return;
      const edited = this.userItems.find((u) => u.id === id);
      if (edited) edited.approved = approved;
      // Автоматическая строка становится правкой со своим id (как в editItem).
      const item = edited ?? { ...current, id: `u${++manualSeq}`, locked: true, approved };
      if (!edited) this.userItems.push(item);
      this.proposal = this.proposal.map((p) => (p.id === id ? { ...item } : p));
    },

    /** Утвердить все строки предложения или снять отметку со всех. */
    setAllApproved(approved: boolean) {
      for (const p of [...this.proposal]) this.setApproved(p.id, approved);
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

    /**
     * Новая строка — из привычных (в её привычное время) или пустая (в конце рабочего дня).
     * Встаёт в свободное окно рабочего дня: мешают только залогированное, правки, встречи
     * и обед, автоматические строки перестраиваются вокруг неё. Длительность — привычная,
     * но не больше, чем осталось до цели после залогированного, правок и встреч.
     */
    addRow(habit?: HabitTask) {
      const opts = this.composeOptions;
      const fixed = [
        ...this.existing.map((w) => ({ start: startMinutesOf(w.started), end: startMinutesOf(w.started) + Math.round(w.timeSpentSeconds / 60) })),
        ...this.userItems.map((u) => ({ start: u.start, end: u.start + u.minutes })),
        ...this.proposal.filter((p) => p.source === 'meeting').map((p) => ({ start: p.start, end: p.start + p.minutes })),
      ];
      const room = Math.floor((this.targetMinutes - fixed.reduce((s, b) => s + b.end - b.start, 0)) / opts.stepMinutes) * opts.stepMinutes;
      const wanted = habit?.typicalMinutes ?? 60;
      const busy = [...fixed, ...(opts.lunch ? [{ start: opts.lunch[0], end: opts.lunch[1] }] : [])];
      const { start, minutes } = placeNewRow(busy, habit ? habit.typicalStart : opts.dayEnd - wanted, room >= opts.stepMinutes ? Math.min(wanted, room) : wanted, opts);
      const id = `m${++manualSeq}`;
      const key = habit?.issueKey ?? '';
      this.userItems.push({
        id,
        issueKey: key,
        issueSummary: habit?.issueSummary ?? null,
        start: Math.max(0, Math.min(start, 24 * 60 - minutes)),
        minutes,
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

    /**
     * Отправка строк дня в Jira + запись успешных в локальный кэш.
     * Возвращает результаты по строкам и созданные записи (для «Отменить»).
     */
    async sendRows(date: string, rows: ProposalItem[]): Promise<{ results: BulkResultItem[]; created: CreatedWorklog[] }> {
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) throw new Error('Нет активного профиля Jira');
      const tz = useSettingsStore().timezone;
      const entries = rows.map((p) => ({
        issueKey: p.issueKey.trim().toUpperCase(),
        startedAt: jiraStartedFromLocal(date, minutesToHHMM(p.start), tz),
        timeSpentSeconds: Math.round(p.minutes * 60),
        comment: p.comment || null,
      }));
      const results = await tauriApi.bulkAddWorklogs(params, entries);
      const created: CreatedWorklog[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const p = rows[i];
        const e = entries[i];
        if (!p || !r.success) continue;
        const rowKey = r.worklogId ? `wl:${r.worklogId}` : `local:${e.issueKey}:${e.startedAt}:${p.id}`;
        created.push({ issueKey: e.issueKey, worklogId: r.worklogId ?? null, rowKey });
        await tauriApi.upsertCachedWorklog({
          rowKey, worklogId: r.worklogId ?? null, issueKey: e.issueKey, issueSummary: p.issueSummary,
          projectKey: e.issueKey.split('-')[0] ?? null, started: e.startedAt,
          timeSpentSeconds: e.timeSpentSeconds, comment: e.comment, updated: null,
          syncedAt: new Date().toISOString(),
        }).catch(() => {});
      }
      if (created.length) useAnalyticsStore().trackBulkEntries(created.length);
      return { results, created };
    },

    async submit(): Promise<BulkResultItem[]> {
      const rows = this.proposal.filter((p) => p.issueKey.trim() && p.minutes > 0);
      if (!rows.length) return [];
      this.submitting = true;
      this.submitMessage = null;
      this.rowErrors = {};
      try {
        const { results } = await this.sendRows(this.date, rows);
        const okIds = new Set<string>();
        for (let i = 0; i < results.length; i++) {
          const p = rows[i];
          if (!p) continue;
          if (results[i].success) okIds.add(p.id);
          else this.rowErrors[p.id] = results[i].error ?? 'Ошибка Jira';
        }
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

    /**
     * План дня «как есть», без правок: то, что отправит «одним нажатием».
     * Возвращает строки и причину, по которой день отправлять нельзя (если есть).
     */
    async autoPlan(date: string, refreshDay: boolean): Promise<{ rows: ProposalItem[]; filledMinutes: number; problem: string | null; note: string }> {
      const settings = useSettingsStore();
      const target = Math.round((settings.workdayHours || 8) * 60 / 15) * 15;
      const ctx = await this.dayContext(date, refreshDay);
      const filledMinutes = Math.round(ctx.existing.reduce((s, w) => s + w.timeSpentSeconds, 0) / 60);
      const opts: ComposeOptions = { ...this.composeOptions, date, targetHours: target / 60 };
      const rows = buildPlan({
        existing: ctx.existing, meetings: ctx.meetings, habits: ctx.habits, opts,
        userItems: [], dismissedKeys: new Set(this.notProposedKeys(ctx.habits)), dismissedMeetings: new Set(),
      }).filter((p) => p.minutes > 0);
      const proposed = rows.reduce((s, p) => s + p.minutes, 0);
      const holidays = new Set(settings.holidays.map((h) => h.date));
      let problem: string | null = null;
      if (!isWorkingDay(date, { workdays: settings.workdays, holidays })) problem = 'нерабочий день';
      else if (filledMinutes >= target - 5) problem = 'уже заполнен';
      else if (ctx.favoriteFallback) problem = 'нет истории привычных задач — откройте день и выберите задачи';
      else if (!rows.length) problem = 'не из чего собрать: нет привычных задач и встреч';
      else if (Math.abs(filledMinutes + proposed - target) > 5) problem = `собирается ${Math.round((filledMinutes + proposed) / 6) / 10} ч из ${target / 60} — проверьте день вручную`;
      else if (rows.some((p) => !ISSUE_KEY_RE.test(p.issueKey.trim().toUpperCase()))) problem = 'есть строки без задачи';
      else if (findOverlaps(rows, ctx.existing).size) problem = 'записи пересекаются по времени — проверьте день вручную';
      const guessed = rows.filter((p) => p.guessed).length;
      const note = guessed ? `${guessed} встреч(и) с задачей по умолчанию` : '';
      return { rows, filledMinutes, problem, note };
    },

    /**
     * «Одним нажатием»: собирает и отправляет каждый день из списка (по возрастанию дат).
     * Дни, которые нельзя заполнить автоматически, пропускаются с причиной.
     */
    async fillDays(dates: string[]): Promise<FillDayResult[]> {
      if (this.batch.running) return [];
      const sorted = [...new Set(dates)].sort();
      if (!sorted.length) return [];
      this.batch = { running: true, total: sorted.length, done: 0, current: '', results: [] };
      this.lastBatchCreated = [];
      try {
        // Свежее состояние всех дней одним запросом — «уже заполнено» должно быть точным.
        await useDayFromCalendarStore().refreshRangeFromJira(sorted[0], sorted[sorted.length - 1]).catch(() => {});
        for (const date of sorted) {
          this.batch.current = date;
          let res: FillDayResult;
          try {
            const plan = await this.autoPlan(date, false);
            if (plan.problem) {
              res = { date, ok: false, minutes: 0, entries: 0, message: plan.problem };
            } else {
              const { results, created } = await this.sendRows(date, plan.rows);
              this.lastBatchCreated.push(...created);
              const failed = results.filter((r) => !r.success);
              const minutes = plan.rows.filter((_, i) => results[i]?.success).reduce((s, p) => s + p.minutes, 0);
              res = failed.length
                ? { date, ok: false, minutes, entries: created.length, message: `ошибка Jira: ${failed[0].error ?? 'не удалось создать запись'}` }
                : { date, ok: true, minutes, entries: created.length, message: plan.note };
            }
          } catch (e) {
            res = { date, ok: false, minutes: 0, entries: 0, message: e instanceof Error ? e.message : String(e) };
          }
          this.batch.results.push(res);
          this.batch.done++;
        }
        await this.refreshUnfilled().catch(() => {});
        // Если открыт один из заполненных дней — показываем его актуальным.
        if (sorted.includes(this.date)) await this.load(this.date, false);
        return this.batch.results;
      } finally {
        this.batch.running = false;
        this.batch.current = '';
      }
    },

    /** Отменяет последнее пакетное заполнение: удаляет созданные записи в Jira и кэше. */
    async undoLastBatch(): Promise<{ removed: number; failed: number }> {
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params || !this.lastBatchCreated.length) return { removed: 0, failed: 0 };
      this.undoing = true;
      let removed = 0;
      let failed = 0;
      try {
        const left: CreatedWorklog[] = [];
        for (const c of this.lastBatchCreated) {
          try {
            if (c.worklogId) await tauriApi.deleteWorklog(params, c.issueKey, c.worklogId, null);
            await tauriApi.deleteCachedWorklog(c.rowKey).catch(() => {});
            removed++;
          } catch {
            failed++;
            left.push(c);
          }
        }
        this.lastBatchCreated = left;
        await this.refreshUnfilled().catch(() => {});
        await this.load(this.date, false);
        return { removed, failed };
      } finally {
        this.undoing = false;
      }
    },
  },
});
