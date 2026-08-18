export interface DateRangePreset {
  id: string;
  label: string;
  range: () => { from: string; to: string };
}

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function startOfWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function endOfWeek(d: Date): Date { const s = startOfWeek(d); const e = new Date(s); e.setDate(e.getDate() + 6); return e; }
function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

export const DATE_RANGE_PRESETS: DateRangePreset[] = [
  { id: 'this_week', label: 'Эта неделя', range: () => { const now = new Date(); return { from: iso(startOfWeek(now)), to: iso(endOfWeek(now)) }; } },
  { id: 'this_month', label: 'Этот месяц', range: () => { const now = new Date(); return { from: iso(startOfMonth(now)), to: iso(endOfMonth(now)) }; } },
  { id: 'last_2_weeks', label: 'Последние 2 недели', range: () => { const now = new Date(); const from = new Date(now); from.setDate(from.getDate() - 13); return { from: iso(from), to: iso(now) }; } },
  { id: 'custom', label: 'С даты X по дату Y', range: () => { const now = new Date(); return { from: iso(now), to: iso(now) }; } },
];

export const RU_HOLIDAYS_FALLBACK_2026: string[] = ['2026-01-01','2026-01-02','2026-01-05','2026-01-06','2026-01-07','2026-01-08','2026-02-23','2026-03-09','2026-05-01','2026-05-11','2026-06-12','2026-11-04'];
export function enumerateDates(fromIso: string, toIso: string): Date[] { const from = new Date(fromIso); const to = new Date(toIso); const out: Date[] = []; const cursor = new Date(from); while (cursor <= to) { out.push(new Date(cursor)); cursor.setDate(cursor.getDate() + 1); } return out; }
export interface WeekdayFilter { mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean; }
export const DEFAULT_WEEKDAY_FILTER: WeekdayFilter = { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false };
const WEEKDAY_INDEX: (keyof WeekdayFilter)[] = ['sun','mon','tue','wed','thu','fri','sat'];
export function isWeekdayEnabled(d: Date, filter: WeekdayFilter): boolean { return filter[WEEKDAY_INDEX[d.getDay()]]; }
export const WEEKDAY_RU_SHORT: Record<number, string> = { 0: 'Вс', 1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб' };
export function toIsoDate(d: Date): string { return iso(d); }
export function buildWorkingDates(fromIso: string, toIso: string, weekdayFilter: WeekdayFilter, excludeHolidays: boolean, holidays: string[]): Date[] {
  const holidaySet = new Set(holidays);
  return enumerateDates(fromIso, toIso).filter((d) => isWeekdayEnabled(d, weekdayFilter) && (!excludeHolidays || !holidaySet.has(iso(d))));
}
