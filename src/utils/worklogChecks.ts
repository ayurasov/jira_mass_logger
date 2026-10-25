// Проверка корректности заполнения worklog: общие правила для экрана «Команда».
// Модуль чистый (без Vue/Pinia), чтобы правила было легко тестировать и переиспользовать.

import { addDaysIso } from './time';

export interface CheckWorklog {
  id: string;
  authorId: string;
  issueKey: string;
  /** Jira started: "2026-10-20T09:00:00.000+0300" — дата и время в TZ автора. */
  started: string;
  timeSpentSeconds: number;
  comment?: string | null;
  issueSummary?: string | null;
}

export interface CheckOptions {
  /** Норма часов в рабочий день. */
  normHours: number;
  /** Рабочие дни недели: 0=Вс … 6=Сб. */
  workdays: number[];
  /** Праздничные даты "YYYY-MM-DD". */
  holidays: Set<string>;
  /** Сегодня "YYYY-MM-DD" — будущие дни не считаются незаполненными. */
  today: string;
  /** Больше этого в день — ошибка (переработка/опечатка). */
  maxDayHours: number;
  /** Допуск на округление при сравнении с нормой, ч. */
  tolerance: number;
}

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'missing'      // рабочий день без записей
  | 'under'        // меньше нормы
  | 'over'         // больше нормы
  | 'too_much'     // больше maxDayHours
  | 'non_working'  // записи в выходной/праздник
  | 'future'       // запись на будущую дату
  | 'duplicate'    // одинаковые задача+время начала+длительность
  | 'overlap'      // пересекающиеся интервалы
  | 'no_comment';  // пустое описание

export interface CheckIssue {
  code: IssueCode;
  severity: Severity;
  authorId: string;
  date: string;
  message: string;
  worklogIds: string[];
}

export type DayStatus = 'ok' | 'under' | 'missing' | 'over' | 'error' | 'off' | 'off-logged' | 'future';

export interface DayCell {
  date: string;
  hours: number;
  status: DayStatus;
  worklogs: CheckWorklog[];
  issues: CheckIssue[];
}

export const ISSUE_LABELS: Record<IssueCode, string> = {
  missing: 'Нет записей',
  under: 'Меньше нормы',
  over: 'Больше нормы',
  too_much: 'Аномально много часов',
  non_working: 'Работа в выходной',
  future: 'Запись на будущее',
  duplicate: 'Дубликат',
  overlap: 'Пересечение по времени',
  no_comment: 'Без описания',
};

const fmtH = (h: number) => `${Math.round(h * 100) / 100} ч`;

/** Все даты периода включительно. */
export function datesInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

export function isWorkingDay(date: string, opts: Pick<CheckOptions, 'workdays' | 'holidays'>): boolean {
  const [y, m, d] = date.split('-').map(Number);
  return opts.workdays.includes(new Date(y, m - 1, d).getDay()) && !opts.holidays.has(date);
}

/** Минуты от начала суток по started (локальное время записи). */
function startMinutes(started: string): number {
  const m = started.match(/T(\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Проверяет один день одного автора. */
export function checkDay(authorId: string, date: string, worklogs: CheckWorklog[], opts: CheckOptions): DayCell {
  const hours = worklogs.reduce((s, w) => s + w.timeSpentSeconds, 0) / 3600;
  const working = isWorkingDay(date, opts);
  const future = date > opts.today;
  const issues: CheckIssue[] = [];
  const push = (code: IssueCode, severity: Severity, message: string, ids: string[] = []) =>
    issues.push({ code, severity, authorId, date, message, worklogIds: ids });
  const allIds = worklogs.map((w) => w.id);

  if (future && worklogs.length > 0) push('future', 'error', `Запись на будущую дату (${fmtH(hours)})`, allIds);
  if (!working && worklogs.length > 0) push('non_working', 'info', `Списано ${fmtH(hours)} в нерабочий день`, allIds);
  if (working && !future) {
    if (worklogs.length === 0) push('missing', 'error', 'Рабочий день без записей');
    else if (hours < opts.normHours - opts.tolerance) push('under', 'warning', `${fmtH(hours)} из ${fmtH(opts.normHours)}`, allIds);
  }
  if (hours > opts.maxDayHours) push('too_much', 'error', `${fmtH(hours)} за день — проверьте опечатку`, allIds);
  else if (working && hours > opts.normHours + opts.tolerance) push('over', 'warning', `Переработка: ${fmtH(hours)}`, allIds);

  // Дубликаты: та же задача, то же время начала и длительность.
  const seen = new Map<string, string>();
  for (const w of worklogs) {
    const key = `${w.issueKey}|${w.started.slice(0, 16)}|${w.timeSpentSeconds}`;
    const prev = seen.get(key);
    if (prev) push('duplicate', 'error', `${w.issueKey}: две одинаковые записи`, [prev, w.id]);
    else seen.set(key, w.id);
  }

  // Пересечения интервалов (дубликаты уже учтены выше — их не дублируем).
  const sorted = [...worklogs].sort((a, b) => startMinutes(a.started) - startMinutes(b.started));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const prevEnd = startMinutes(prev.started) + prev.timeSpentSeconds / 60;
    const isDup = prev.issueKey === cur.issueKey && prev.started.slice(0, 16) === cur.started.slice(0, 16)
      && prev.timeSpentSeconds === cur.timeSpentSeconds;
    if (!isDup && startMinutes(cur.started) < prevEnd - 1) {
      push('overlap', 'warning', `${prev.issueKey} и ${cur.issueKey} пересекаются по времени`, [prev.id, cur.id]);
    }
  }

  const noComment = worklogs.filter((w) => !w.comment || !w.comment.trim());
  if (noComment.length > 0) {
    push('no_comment', 'info', `${noComment.length} ${noComment.length === 1 ? 'запись' : 'записи'} без описания`, noComment.map((w) => w.id));
  }

  let status: DayStatus;
  if (issues.some((i) => i.severity === 'error' && i.code !== 'missing')) status = 'error';
  else if (future) status = 'future';
  else if (!working) status = worklogs.length > 0 ? 'off-logged' : 'off';
  else if (worklogs.length === 0) status = 'missing';
  else if (hours < opts.normHours - opts.tolerance) status = 'under';
  else if (hours > opts.normHours + opts.tolerance) status = 'over';
  else status = 'ok';

  return { date, hours: Math.round(hours * 100) / 100, status, worklogs, issues };
}

export interface MemberReport {
  authorId: string;
  days: DayCell[];
  totalHours: number;
  /** Норма за прошедшие рабочие дни периода. */
  expectedHours: number;
  /** Доля заполнения нормы (0..∞). */
  fill: number;
  issues: CheckIssue[];
}

/** Отчёт по автору за период. */
export function buildMemberReport(authorId: string, dates: string[], worklogs: CheckWorklog[], opts: CheckOptions): MemberReport {
  const byDate = new Map<string, CheckWorklog[]>();
  for (const w of worklogs) {
    const d = w.started.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(w);
  }
  const days = dates.map((d) => checkDay(authorId, d, byDate.get(d) ?? [], opts));
  const totalHours = days.reduce((s, d) => s + d.hours, 0);
  const expectedDays = dates.filter((d) => d <= opts.today && isWorkingDay(d, opts)).length;
  const expectedHours = expectedDays * opts.normHours;
  return {
    authorId,
    days,
    totalHours: Math.round(totalHours * 100) / 100,
    expectedHours,
    fill: expectedHours > 0 ? totalHours / expectedHours : (totalHours > 0 ? 1 : 0),
    issues: days.flatMap((d) => d.issues),
  };
}

/**
 * Текст «что не заполнено» для командного чата: у кого и какие рабочие дни
 * периода пустые или недозаполнены (будущие дни не учитываются).
 */
export function unfilledReportText(
  reports: (MemberReport & { member: { displayName: string } })[],
  title: string,
  opts: Pick<CheckOptions, 'normHours' | 'today'>,
): string {
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const day = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${WD[new Date(y, m - 1, d).getDay()]} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
  };
  const h = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
  const lines = [`Незаполненный worklog — ${title}`];
  const ok: string[] = [];
  for (const r of reports) {
    const gaps = r.days.filter((d) => d.status === 'missing' || d.status === 'under');
    if (!gaps.length) { ok.push(r.member.displayName); continue; }
    const deficit = gaps.reduce((s, d) => s + Math.max(0, opts.normHours - d.hours), 0);
    const parts = gaps.map((d) => {
      const today = d.date === opts.today ? ' (сегодня)' : '';
      return d.hours > 0 ? `${day(d.date)} — ${h(d.hours)} из ${h(opts.normHours)} ч${today}` : `${day(d.date)} — пусто${today}`;
    });
    lines.push(`• ${r.member.displayName}: не хватает ${h(deficit)} ч — ${parts.join('; ')}`);
  }
  if (lines.length === 1) lines.push('✅ За период всё заполнено.');
  else if (ok.length) lines.push(`✅ Всё заполнено: ${ok.join(', ')}`);
  return lines.join('\n');
}
