// «Собрать день»: подбор привычных задач для добивки дня до нужного числа часов.
// Модуль чистый (без Vue/Tauri) — алгоритм легко тестировать.
//
// 1. Из истории worklog за последние недели находим «привычные» задачи: как часто
//    они встречаются в рабочие дни, типичную длительность, время начала и описание.
// 2. Встречи календаря на этот день (с подобранной задачей) идут первыми — в своё время.
// 3. Добиваем оставшиеся часы привычными задачами по убыванию «привычности»,
//    последнюю подрезаем, при нехватке — растягиваем самую объёмную.
// 4. Раскладываем записи по свободным слотам дня, не пересекаясь с уже
//    залогированным, обедом и друг с другом.

export interface HistoryWorklog {
  issueKey: string;
  issueSummary?: string | null;
  /** Jira started: "2026-10-20T09:00:00.000+0300" (локальное время записи). */
  started: string;
  timeSpentSeconds: number;
  comment?: string | null;
}

export interface HabitTask {
  issueKey: string;
  issueSummary: string | null;
  /** Доля рабочих дней окна, в которые задача логировалась (0..1). */
  frequency: number;
  /** Доля таких же дней недели (все понедельники и т. п.). */
  sameWeekdayFrequency: number;
  /** Типичная длительность за день, мин (медиана, кратна шагу). */
  typicalMinutes: number;
  /** Типичное время начала, минуты от полуночи (медиана). */
  typicalStart: number;
  typicalComment: string;
  daysSeen: number;
  score: number;
}

export interface ComposerMeeting {
  issueKey: string;
  issueSummary?: string | null;
  subject: string;
  /** Начало в минутах от полуночи (локально). */
  start: number;
  minutes: number;
}

export type ProposalSource = 'meeting' | 'habit' | 'manual';

export interface ProposalItem {
  id: string;
  issueKey: string;
  issueSummary: string | null;
  start: number;
  minutes: number;
  comment: string;
  source: ProposalSource;
  /** Пояснение, почему задача предложена. */
  reason: string;
  include: boolean;
}

export interface ComposeOptions {
  date: string;
  targetHours: number;
  stepMinutes: number;
  /** Начало и конец рабочего дня, мин от полуночи. */
  dayStart: number;
  dayEnd: number;
  /** Обед [start, end) в минутах или null. */
  lunch: [number, number] | null;
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const minutesToHHMM = (m: number) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
export function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
export const startMinutesOf = (started: string) => {
  const m = started.match(/T(\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9 * 60;
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const roundTo = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);
const weekdayOf = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};

/**
 * Привычные задачи по истории.
 * @param workdays — список рабочих дат окна "YYYY-MM-DD" (знаменатель частоты).
 */
export function findHabits(history: HistoryWorklog[], workdays: string[], targetDate: string, stepMinutes = 15): HabitTask[] {
  const wdSet = new Set(workdays);
  const targetWeekday = weekdayOf(targetDate);
  const sameWeekdayDays = workdays.filter((d) => weekdayOf(d) === targetWeekday).length;

  // issueKey → date → { seconds, starts[], comments[] }
  const byIssue = new Map<string, { summary: string | null; days: Map<string, { seconds: number; start: number; comments: string[] }> }>();
  for (const w of history) {
    const day = w.started.slice(0, 10);
    if (!wdSet.has(day) || !w.issueKey) continue;
    let rec = byIssue.get(w.issueKey);
    if (!rec) { rec = { summary: w.issueSummary ?? null, days: new Map() }; byIssue.set(w.issueKey, rec); }
    if (!rec.summary && w.issueSummary) rec.summary = w.issueSummary;
    const d = rec.days.get(day) ?? { seconds: 0, start: 24 * 60, comments: [] };
    d.seconds += w.timeSpentSeconds;
    d.start = Math.min(d.start, startMinutesOf(w.started));
    if (w.comment && w.comment.trim()) d.comments.push(w.comment.trim());
    rec.days.set(day, d);
  }

  const total = Math.max(1, workdays.length);
  const habits: HabitTask[] = [];
  for (const [issueKey, rec] of byIssue) {
    const days = [...rec.days.entries()];
    const frequency = days.length / total;
    const sameWd = days.filter(([d]) => weekdayOf(d) === targetWeekday).length;
    const sameWeekdayFrequency = sameWeekdayDays ? sameWd / sameWeekdayDays : 0;
    // Свежесть: дни из последней недели окна весят больше.
    const lastWeek = workdays.slice(-5);
    const recent = days.filter(([d]) => lastWeek.includes(d)).length / Math.max(1, lastWeek.length);
    const commentCounts = new Map<string, number>();
    for (const [, d] of days) for (const c of d.comments) commentCounts.set(c, (commentCounts.get(c) ?? 0) + 1);
    const typicalComment = [...commentCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    habits.push({
      issueKey,
      issueSummary: rec.summary,
      frequency,
      sameWeekdayFrequency,
      typicalMinutes: roundTo(median(days.map(([, d]) => d.seconds / 60)), stepMinutes),
      typicalStart: roundTo(median(days.map(([, d]) => d.start)), stepMinutes),
      typicalComment,
      daysSeen: days.length,
      score: frequency + 0.5 * sameWeekdayFrequency + 0.5 * recent,
    });
  }
  return habits.sort((a, b) => b.score - a.score || b.typicalMinutes - a.typicalMinutes);
}

export function describeHabit(h: HabitTask): string {
  const pct = Math.round(h.frequency * 100);
  if (h.frequency >= 0.7) return `почти каждый день (${pct}% дней)`;
  if (h.sameWeekdayFrequency >= 0.6 && h.frequency < 0.5) return 'обычно в этот день недели';
  return `в ${pct}% рабочих дней`;
}

interface Interval { start: number; end: number }

/** Свободные окна рабочего дня с учётом занятых интервалов. */
function freeGaps(busy: Interval[], opts: ComposeOptions): Interval[] {
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const gaps: Interval[] = [];
  let cur = opts.dayStart;
  for (const b of sorted) {
    if (b.end <= cur) continue;
    if (b.start > cur) gaps.push({ start: cur, end: Math.min(b.start, opts.dayEnd) });
    cur = Math.max(cur, b.end);
    if (cur >= opts.dayEnd) break;
  }
  if (cur < opts.dayEnd) gaps.push({ start: cur, end: opts.dayEnd });
  return gaps.filter((g) => g.end - g.start >= opts.stepMinutes);
}

/**
 * Размещает `minutes` минут начиная с желаемого времени: целиком в первом подходящем
 * окне, а если такого нет — частями по свободным окнам. Возвращает куски [start, minutes].
 */
function allocate(busy: Interval[], preferred: number, minutes: number, opts: ComposeOptions): [number, number][] {
  const gaps = freeGaps(busy, opts);
  // Порядок окон: начиная с желаемого времени, затем более ранние.
  const ordered = [...gaps.filter((g) => g.end > preferred), ...gaps.filter((g) => g.end <= preferred)];
  for (const g of ordered) {
    const s = Math.max(g.start, Math.min(preferred, g.end - minutes));
    if (s >= g.start && s + minutes <= g.end) return [[s, minutes]];
  }
  // Целиком не влезает — делим на части, начиная с самых больших окон (меньше кусков).
  const chunks: [number, number][] = [];
  let left = minutes;
  for (const g of [...gaps].sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (left <= 0) break;
    const take = Math.min(left, g.end - g.start);
    chunks.push([g.start, take]);
    left -= take;
  }
  if (left > 0) {
    // Рабочий день закончился — остаток ставим сразу после последнего занятого интервала.
    const lastEnd = Math.max(opts.dayStart, ...busy.map((b) => b.end), ...chunks.map(([s, m]) => s + m));
    // …но не через полночь: запись должна остаться в пределах этих суток.
    chunks.push([Math.max(0, Math.min(lastEnd, 24 * 60 - left)), left]);
  }
  return chunks;
}

/**
 * Предложение по заполнению дня.
 * @param existing — уже залогированное за этот день.
 */
export function composeDay(
  existing: HistoryWorklog[],
  meetings: ComposerMeeting[],
  habits: HabitTask[],
  opts: ComposeOptions,
): ProposalItem[] {
  const step = opts.stepMinutes;
  const filledMin = existing.reduce((s, w) => s + w.timeSpentSeconds / 60, 0);
  let remaining = Math.round((opts.targetHours * 60 - filledMin) / step) * step;
  if (remaining <= 0) return [];

  const busy: Interval[] = existing.map((w) => {
    const s = startMinutesOf(w.started);
    return { start: s, end: s + Math.round(w.timeSpentSeconds / 60) };
  });
  const lunch: Interval | null = opts.lunch ? { start: opts.lunch[0], end: opts.lunch[1] } : null;
  if (lunch) busy.push(lunch);

  const loggedToday = new Set(existing.map((w) => w.issueKey));
  const out: ProposalItem[] = [];
  let seq = 0;
  const id = () => `p${++seq}`;

  // 1) Встречи — в их реальное время (если не пересекаются с уже залогированным).
  for (const m of [...meetings].sort((a, b) => a.start - b.start)) {
    if (remaining <= 0) break;
    const minutes = Math.min(roundTo(m.minutes, step), remaining);
    const clash = busy.some((b) => b !== lunch && m.start < b.end && m.start + minutes > b.start);
    if (clash) continue;
    out.push({ id: id(), issueKey: m.issueKey, issueSummary: m.issueSummary ?? null, start: m.start, minutes, comment: m.subject, source: 'meeting', reason: 'встреча в календаре', include: true });
    busy.push({ start: m.start, end: m.start + minutes });
    remaining -= minutes;
  }
  if (remaining <= 0) return out.sort((a, b) => a.start - b.start);

  // 2) Привычные задачи: регулярные (часто или в этот день недели); уже залогированные
  //    сегодня и попавшие из встреч не дублируем.
  const pool = habits.filter((h) => !loggedToday.has(h.issueKey) && !out.some((o) => o.issueKey === h.issueKey));
  let chosen = pool.filter((h) => h.frequency >= 0.4 || h.sameWeekdayFrequency >= 0.6)
    .map((h) => ({ h, minutes: h.typicalMinutes }));
  if (chosen.length === 0 && pool.length) chosen = [{ h: pool[0], minutes: pool[0].typicalMinutes }];
  if (chosen.length === 0) return out.sort((a, b) => a.start - b.start);

  // 3) Подгонка суммы: «наполнитель» — самая объёмная задача, она сжимается или
  //    растягивается; если и этого мало — отбрасываем наименее привычные.
  //    Наполнитель фиксируется один раз: после сжатия он может стать не самым длинным.
  const sum = () => chosen.reduce((s, c) => s + c.minutes, 0);
  const biggest = () => chosen.reduce((a, b) => (b.minutes > a.minutes ? b : a));
  let filler = biggest();
  while (sum() > remaining) {
    const others = sum() - filler.minutes;
    if (remaining - others >= step) { filler.minutes = remaining - others; break; }
    // Наполнителю не хватает места даже на шаг — убираем наименее привычную задачу.
    const drop = [...chosen].reverse().find((c) => c !== filler);
    if (!drop) { filler.minutes = remaining; break; }
    chosen = chosen.filter((c) => c !== drop);
  }
  let fillerNote = '';
  if (sum() < remaining) {
    filler.minutes += remaining - sum();
    fillerNote = ' · добивка до нормы';
  }

  // 4) Раскладка по свободным окнам: сначала «жёсткие» задачи в их привычное время,
  //    наполнитель — последним (он гибкий и при нехватке места делится на части).
  const order = [
    ...chosen.filter((c) => c !== filler).sort((a, b) => a.h.typicalStart - b.h.typicalStart),
    filler,
  ];
  for (const c of order) {
    const reason = describeHabit(c.h) + (c === filler ? fillerNote : '');
    for (const [start, minutes] of allocate(busy, c.h.typicalStart, c.minutes, opts)) {
      out.push({
        id: id(), issueKey: c.h.issueKey, issueSummary: c.h.issueSummary, start, minutes,
        comment: c.h.typicalComment, source: 'habit', reason, include: true,
      });
      busy.push({ start, end: start + minutes });
    }
  }
  return mergeAdjacent(out.sort((a, b) => a.start - b.start));
}

/** Склеивает идущие подряд куски одной и той же задачи в одну запись. */
function mergeAdjacent(items: ProposalItem[]): ProposalItem[] {
  const res: ProposalItem[] = [];
  for (const it of items) {
    const prev = res[res.length - 1];
    if (prev && prev.issueKey === it.issueKey && prev.source === it.source && prev.start + prev.minutes === it.start) {
      prev.minutes += it.minutes;
    } else {
      res.push({ ...it });
    }
  }
  return res;
}

/** id предложенных записей, пересекающихся с уже залогированным или друг с другом (после ручной правки). */
export function findOverlaps(items: { id: string; start: number; minutes: number }[], existing: HistoryWorklog[]): Set<string> {
  const all = [
    ...existing.map((w, i) => ({ id: `e${i}`, start: startMinutesOf(w.started), end: startMinutesOf(w.started) + Math.round(w.timeSpentSeconds / 60) })),
    ...items.map((p) => ({ id: p.id, start: p.start, end: p.start + p.minutes })),
  ].sort((a, b) => a.start - b.start);
  const bad = new Set<string>();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length && all[j].start < all[i].end; j++) {
      if (!all[i].id.startsWith('e')) bad.add(all[i].id);
      if (!all[j].id.startsWith('e')) bad.add(all[j].id);
    }
  }
  return bad;
}
