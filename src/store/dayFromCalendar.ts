import { localIsoDate, daysAgoIso, addDaysIso, formatJiraStarted, zonedDayBounds } from '../utils/time';
import { defineStore } from 'pinia';
import {
  tauriApi,
  type CalendarEventDto,
  type MatchSuggestion,
  type MeetingMatchRule,
  type MeetingIssueHistoryEntry,
  type NewWorklogEntry,
  type BulkResultItem,
  type CachedWorklogRow,
} from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useSettingsStore } from './settings';
import { useFavoriteTasksStore } from './favoriteTasks';

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
  /** Мягкое предупреждение о возможном дубле (та же задача в тот же день, но другое время) — не блокирует логирование. */
  dedupWarning: string | null;
}

export interface DayBulkPreviewItem {
  event: CalendarEventDto;
  issueKey: string;
  issueSummary: string | null;
  comment: string;
  startedLocal: string;
  roundedSeconds: number;
}

let loadDaySeq = 0;
/** Обновления диапазонов, которые уже идут: повторный вызов ждёт их, а не шлёт второй запрос в Jira. */
const rangeRefreshes = new Map<string, Promise<void>>();

export const useDayFromCalendarStore = defineStore('dayFromCalendar', {
  state: () => ({
    selectedDate: localIsoDate(),
    rows: [] as MeetingRow[],
    worklogTodaySeconds: 0,
    /** Кэш worklog за текущий день — для дедупликации (issueKey|date|HH:MM) */
    existingKeys: new Set<string>(),
    /** Worklog-записи выбранного дня из кэша — для мягкой дедупликации (та же задача в тот же день). */
    existingDayWorklogs: [] as { issueKey: string; started: string; comment: string | null }[],
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
    /** «Покрыто» = только то, что реально залогировано в Jira за день.
 *  Раньше сюда плюсовались длительности календарных встреч — но встреча
     *  в календаре ещё не значит «часы списаны», поэтому подсветка заполненности
     *  считается именно по worklog из Jira. */
    coveredSeconds(): number { return this.worklogTodaySeconds; },
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
      return formatJiraStarted(new Date(utcIsoStr), useSettingsStore().timezone);
    },

    async loadRulesAndHistory() {
      this.rules = await tauriApi.listMeetingMatchRules();
      this.history = await tauriApi.getMeetingIssueHistory();
    },

    async loadDay(date: string, forceRefresh = false) {
      // Защита от гонки при быстрой навигации по дням: результат устаревшего
      // запроса не должен перезаписать строки уже выбранного дня.
      const token = ++loadDaySeq;
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
        // Границы ЛОКАЛЬНОГО дня (часовой пояс из настроек), а не UTC-суток:
        // иначе во Владивостоке встреча в 09:00 (= 23:00Z прошлого дня) терялась.
        const bounds = zonedDayBounds(date, useSettingsStore().timezone);
        const events = await tauriApi.getCalendarEvents(
          connParams,
          bounds.from,
          bounds.to,
          forceRefresh,
        );
        if (token !== loadDaySeq) return;
        const wls = await tauriApi.listCachedWorklogs(date, date);
        this.worklogTodaySeconds = wls.reduce((s, w) => s + w.timeSpentSeconds, 0);
        // Дедупликация: ключ issueKey|дата|HH:MM (нормализованное локальное время начала)
        this.existingKeys = new Set(
          wls.map((w) => this.dedupKey(w.issueKey, w.started)),
        );
        this.existingDayWorklogs = wls.map((w) => ({
          issueKey: w.issueKey,
          started: w.started,
          comment: w.comment ?? null,
        }));
        const rows = await Promise.all(
          events.map(async (ev) => {
            const suggestion = await tauriApi.suggestIssueForMeeting(
              ev.subject,
              ev.seriesMasterId ?? null,
            );
            const roundedSeconds = this.roundDuration(ev.durationMinutes);
            const startedLocal = this.toJiraStarted(ev.startAt);
            const issueKey = suggestion.issueKey ?? null;
            // Жёсткая дедупликация: точное совпадение issueKey+дата+HH:MM
            // либо совпадение по теме (comment содержит subject совещания).
            const alreadyLogged =
              !!issueKey && startedLocal && this.isExactAlreadyLogged(issueKey, startedLocal, ev.subject);
            // Мягкое предупреждение: в этот день уже есть worklog по той же задаче,
            // но в другое время — возможно дубль, но не блокируем.
            const sameIssue = issueKey && startedLocal && this.hasSameIssueSameDay(issueKey, startedLocal, ev.subject);
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
              dedupWarning: !alreadyLogged && sameIssue
                ? 'В этот день уже есть worklog по этой задаче — проверьте дубль'
                : null,
            } as MeetingRow;
          }),
        );
        if (token !== loadDaySeq) return;
        this.rows = rows;
        // Параллельно подгружаем сводку недели (без блокировки дня)
        this.loadWeek().catch(() => {});
        this.seedFavoritesFromRecent().catch(() => {});
        try { localStorage.setItem('jiratime-calendar-date', date); } catch { /* private mode */ }
      } catch (e: unknown) {
        if (token === loadDaySeq) this.error = String(e);
      } finally {
        if (token === loadDaySeq) this.loading = false;
      }
    },

    /** Ключ дедупликации: issueKey|YYYY-MM-DD|HH:MM (локальное время начала). */
    dedupKey(issueKey: string, startedJiraIso: string): string {
      const local = this.toLocalHHMM(startedJiraIso);
      const date = startedJiraIso.slice(0, 10);
      return `${issueKey}|${date}|${local}`;
    },

    /** Нормализует строку для сравнения тем: нижний регистр, без лишних пробелов/пунктуации. */
    normSubject(s: string | null | undefined): string {
      if (!s) return '';
      return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?—\-()«»\"']+/g, ' ').trim();
    },

    /** Жёсткая дедупликация: точное совпадение issueKey+дата+HH:MM
     *  либо совпадение по теме (comment worklog содержит subject совещания или наоборот). */
    isExactAlreadyLogged(issueKey: string, startedLocal: string, subject?: string | null): boolean {
      // 1) точное совпадение по времени
      if (this.existingKeys.has(this.dedupKey(issueKey, startedLocal))) return true;
      // 2) совпадение по теме: та же задача + тот же день + comment содержит subject
      //    (мягче: comment содержит subject целиком, либо наоборот).
      const date = startedLocal.slice(0, 10);
      const subj = this.normSubject(subject);
      if (subj) {
        for (const w of this.existingDayWorklogs) {
          if (w.issueKey !== issueKey) continue;
          if (w.started.slice(0, 10) !== date) continue;
          const c = this.normSubject(w.comment);
          if (c && (c === subj || c.includes(subj) || subj.includes(c))) return true;
        }
      }
      return false;
    },

    /** Мягкая дедупликация: та же задача в тот же день, но в другое время. Не блокирует. */
    hasSameIssueSameDay(issueKey: string, startedLocal: string, subject?: string | null): boolean {
      if (this.isExactAlreadyLogged(issueKey, startedLocal, subject)) return false;
      const date = startedLocal.slice(0, 10);
      return this.existingDayWorklogs.some(
        (w) => w.issueKey === issueKey && w.started.slice(0, 10) === date,
      );
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
     * не перегружая канал. Полный полученный набор заменяет кэш этого дня
     * целиком (replace-range), поэтому удалённые в Jira записи и старые дубли
     * (из-за прежнего рассогласования row_key) пропадают, а не накапливаются.
     */
    async refreshDayFromJira(date: string) {
      return this.refreshRangeFromJira(date, date);
    },

    /** Ресинхронизирует диапазон дат [from,to] целиком: полный fetch из Jira
     *  (since=0 + dateRange) + replace-range в кэше. В отличие от watermark-
     *  синхронизации в myWorklog, здесь получаем ПОЛНЫЙ набор worklog за
     *  период, поэтому safe удалять из кэша всё, чего нет в свежем ответе. */
    async refreshRangeFromJira(from: string, to: string) {
      const key = `${from}|${to}`;
      const running = rangeRefreshes.get(key);
      if (running) return running;
      const job = this.fetchRangeFromJira(from, to).finally(() => rangeRefreshes.delete(key));
      rangeRefreshes.set(key, job);
      return job;
    },

    async fetchRangeFromJira(from: string, to: string) {
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) return;
      try {
        const dtos = await tauriApi.getWorklogsSince(params, 0, [], {
          dateFrom: from,
          dateTo: to,
        }, true);
        // allowEmptyRange=true: «0 worklog в Jira за диапазон» — это валидный
        // результат (записи были удалены в Jira напрямую), кэш диапазона нужно
        // очистить, а не молча пропустить.
        // Подстраховка: bulk/JQL fallback внутри бэкенда иногда возвращает более
        // широкий диапазон, чем запрошенный — жёстко фильтруем перед replace,
        // чтобы не задеть кэш соседних дней/недель.
        const inRange = dtos.filter((d) => {
          const day = d.started.slice(0, 10);
          return day >= from && day <= to;
        });
        const rows: CachedWorklogRow[] = inRange.map((dto) => ({
          rowKey: dto.id ? `wl:${dto.id}` : `local:${dto.issueKey ?? 'unknown'}:${dto.started}:${Math.random().toString(36).slice(2, 8)}`,
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
      } catch {
        // Не блокируем загрузку дня, если Jira недоступен
      }
    },

    /** Ресинхронизирует всю ISO-неделю (Пн-Вс), содержащую selectedDate, из Jira
     *  и перезагружает состояние дня, чтобы дедуп сбросился для записей,
     *  удалённых в Jira напрямую (без этого приложения). */
    async refreshWeekFromJira() {
      const weekStart = isoWeekStart(this.selectedDate);
      const weekEnd = addDays(weekStart, 6);
      await this.refreshRangeFromJira(weekStart, weekEnd);
      await this.reloadDayWorklogs(this.selectedDate);
      await this.loadWeek();
    },

    navigateDay(delta: number) {
      const next = addDays(this.selectedDate, delta);
      this.loadDay(next);
    },

    /** Bootstrap «любимых задач» из кэша worklog за последние ~90 дней
     *  (только новые — не удаляет user-pinned). Вызывается при загрузке дня. */
    async seedFavoritesFromRecent() {
      const to = localIsoDate();
      const from = daysAgoIso(90);
      const rows = await tauriApi.listCachedWorklogs(from, to);
      useFavoriteTasksStore().seedFromRecent(rows.map((r) => ({
        issueKey: r.issueKey,
        issueSummary: r.issueSummary ?? null,
        timeSpentSeconds: r.timeSpentSeconds,
      })));
    },

    /** Пересчитывает worklogTodaySeconds/existingKeys/existingDayWorklogs из кэша
     *  без повторной загрузки календарных событий Exchange. Вызывается после
     *  успешного логирования, чтобы дедуп и "покрыто" были актуальны сразу,
     *  а не только после ручного "Обновить". */
    async reloadDayWorklogs(date: string) {
      const wls = await tauriApi.listCachedWorklogs(date, date);
      this.worklogTodaySeconds = wls.reduce((s, w) => s + w.timeSpentSeconds, 0);
      this.existingKeys = new Set(wls.map((w) => this.dedupKey(w.issueKey, w.started)));
      this.existingDayWorklogs = wls.map((w) => ({
        issueKey: w.issueKey,
        started: w.started,
        comment: w.comment ?? null,
      }));
    },

    /** Фиксирует успешно созданный в Jira worklog: обязательное обновление
     *  in-memory состояния (дедуп/покрытие) + best-effort запись в локальный
     *  кэш, чтобы дедуп переживал перезагрузку дня и не плодил дубли в Jira. */
    async registerLoggedWorklog(opts: {
      issueKey: string; issueSummary: string | null; startedLocal: string;
      timeSpentSeconds: number; comment: string | null; worklogId: string | null; date: string;
    }) {
      try {
        await tauriApi.upsertCachedWorklog({
          rowKey: opts.worklogId ? `wl:${opts.worklogId}` : `local:${opts.issueKey}:${opts.startedLocal}:${Math.random().toString(36).slice(2, 8)}`,
          worklogId: opts.worklogId,
          issueKey: opts.issueKey,
          issueSummary: opts.issueSummary,
          projectKey: opts.issueKey.split('-')[0] ?? null,
          started: opts.startedLocal,
          timeSpentSeconds: opts.timeSpentSeconds,
          comment: opts.comment,
          updated: null,
          syncedAt: new Date().toISOString(),
        });
      } catch {
        // Успех Jira не должен зависеть от локального кэша — не бросаем.
      }
      if (opts.date === this.selectedDate) {
        try { await this.reloadDayWorklogs(opts.date); } catch {
          // fallback: минимальное in-memory обновление, если re-read из кэша не удался
          this.existingKeys.add(this.dedupKey(opts.issueKey, opts.startedLocal));
          this.existingDayWorklogs.push({ issueKey: opts.issueKey, started: opts.startedLocal, comment: opts.comment });
          this.worklogTodaySeconds += opts.timeSpentSeconds;
        }
      }
    },

    setIssueForRow(idx: number, issueKey: string, issueSummary: string | null) {
      const row = this.rows[idx];
      if (!row) return;
      row.selectedIssueKey = issueKey;
      row.selectedIssueSummary = issueSummary;
      // Пересчитываем статус дедупликации для новой выбранной задачи,
      // чтобы warning/блокировка были актуальны сразу после ручного выбора.
      if (issueKey && row.startedLocal) {
        const exact = this.isExactAlreadyLogged(issueKey, row.startedLocal, row.comment);
        row.logged = exact;
        row.logError = exact ? 'Уже залогировано' : null;
        row.dedupWarning = !exact && this.hasSameIssueSameDay(issueKey, row.startedLocal, row.comment)
          ? 'В этот день уже есть worklog по этой задаче — проверьте дубль'
          : null;
      } else {
        row.logged = false;
        row.logError = null;
        row.dedupWarning = null;
      }
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
      // Дедуп: повторная проверка перед отправкой в Jira (жёсткая — только точное совпадение/тема)
      if (this.isExactAlreadyLogged(row.selectedIssueKey, row.startedLocal, row.comment)) {
        row.logged = true;
        row.logError = 'Уже залогировано';
        return;
      }
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) throw new Error('Нет активного Jira профиля');
      try {
        const worklogId = await tauriApi.addWorklog(
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
        await this.registerLoggedWorklog({
          issueKey: row.selectedIssueKey,
          issueSummary: row.selectedIssueSummary,
          startedLocal: row.startedLocal,
          timeSpentSeconds: row.roundedSeconds,
          comment: row.comment,
          worklogId: worklogId ?? null,
          date: row.startedLocal.slice(0, 10),
        });
        useFavoriteTasksStore().touch(row.selectedIssueKey, row.selectedIssueSummary);
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
        .filter((r) => !this.isExactAlreadyLogged(r.selectedIssueKey!, r.startedLocal!, r.comment))
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
      // Повторная проверка дедупа прямо перед отправкой: preview мог устареть (жёсткая).
      const toSend = items.filter(
        (i) => !this.isExactAlreadyLogged(i.issueKey, i.startedLocal, i.comment),
      );
      // Уже залогированные помечаем как есть.
      items.forEach((i) => {
        if (this.isExactAlreadyLogged(i.issueKey, i.startedLocal, i.comment)) {
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
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const item = toSend[i];
        if (!item) continue;
        const rowIdx = this.rows.findIndex((r) => r.event.id === item.event.id);
        if (rowIdx >= 0) {
          this.rows[rowIdx].logged = res.success;
          if (!res.success) this.rows[rowIdx].logError = res.error ?? 'Ошибка';
        }
        if (res.success) {
          await this.registerLoggedWorklog({
            issueKey: item.issueKey,
            issueSummary: item.issueSummary,
            startedLocal: item.startedLocal,
            timeSpentSeconds: item.roundedSeconds,
            comment: item.comment,
            worklogId: res.worklogId ?? null,
            date: item.startedLocal.slice(0, 10),
          });
          tauriApi.rememberMeetingIssueMatch(
            item.event.subject,
            item.event.seriesMasterId ?? null,
            item.issueKey,
            item.issueSummary,
          );
          useFavoriteTasksStore().touch(item.issueKey, item.issueSummary);
        }
      }
      this.loadWeek().catch(() => {});
      return results;
    },
  },
});

const WEEKDAY_RU_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

const addDays = addDaysIso;

function isoWeekStart(isoDate: string): string {
  const dow = new Date(isoDate.slice(0, 10) + 'T12:00:00Z').getUTCDay();
  return addDays(isoDate, dow === 0 ? -6 : 1 - dow); // к понедельнику
}
