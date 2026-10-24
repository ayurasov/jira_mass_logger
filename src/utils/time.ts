// Общие хелперы дат/времени.
//
// Важно: строку "YYYY-MM-DD" нельзя передавать в `new Date(...)` напрямую —
// она парсится как UTC-полночь, и getDay()/getDate()/toLocaleDateString() в
// часовых поясах западнее UTC дают предыдущий день. Аналогично
// `new Date().toISOString().slice(0, 10)` — это дата в UTC, а не локальная:
// с 00:00 до 03:00 по Москве она возвращает вчерашний день.

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Локальная календарная дата "YYYY-MM-DD" (по умолчанию — сегодня). */
export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DD" → Date в локальную полночь этого дня. */
export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** День недели (0=Вс … 6=Сб) календарной даты "YYYY-MM-DD" (или начала Jira started). */
export function weekdayOfIso(iso: string): number {
  return parseIsoDate(iso).getDay();
}

/** Сдвиг календарной даты "YYYY-MM-DD" на `days` дней. */
export function addDaysIso(iso: string, days: number): string {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

/** Дата `days` дней назад от сегодня (локально). */
export function daysAgoIso(days: number): string {
  return addDaysIso(localIsoDate(), -days);
}

/** "YYYY-MM-DD" → "ДД.ММ.ГГГГ" без сдвига часового пояса. */
export function formatRuDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** Смещение часового пояса `tz` относительно UTC (мс) в момент `dt`, DST-корректно. */
export function getTimezoneOffsetMs(dt: Date, tz: string): number {
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
    // Intl отбрасывает миллисекунды — сравниваем с моментом, округлённым до секунды.
    return localMs - Math.floor(dt.getTime() / 1000) * 1000;
  } catch {
    return -dt.getTimezoneOffset() * 60000;
  }
}

function formatOffset(offsetMs: number, withColon: boolean): string {
  const sign = offsetMs >= 0 ? '+' : '-';
  const absMin = Math.round(Math.abs(offsetMs) / 60000);
  return `${sign}${pad(Math.floor(absMin / 60))}${withColon ? ':' : ''}${pad(absMin % 60)}`;
}

/**
 * Момент времени → строка Jira `started` в часовом поясе `tz`:
 * "2026-08-18T09:30:00.000+0300".
 */
export function formatJiraStarted(date: Date, tz: string): string {
  const offsetMs = getTimezoneOffsetMs(date, tz);
  const local = new Date(date.getTime() + offsetMs);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.000` +
    formatOffset(offsetMs, false)
  );
}

/** Момент локальной полуночи дня `iso` в часовом поясе `tz` (UTC ms). */
function zonedMidnightMs(iso: string, tz: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Двойная итерация — корректно и в день перехода на летнее/зимнее время.
  let ms = guess - getTimezoneOffsetMs(new Date(guess), tz);
  ms = guess - getTimezoneOffsetMs(new Date(ms), tz);
  return ms;
}

function formatRfc3339InTz(ms: number, tz: string): string {
  const offsetMs = getTimezoneOffsetMs(new Date(ms), tz);
  const local = new Date(ms + offsetMs);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    formatOffset(offsetMs, true)
  );
}

/**
 * Границы календарного дня `iso` в часовом поясе `tz` в виде RFC3339 со смещением:
 * { from: "2026-10-23T00:00:00+03:00", to: "2026-10-23T23:59:59+03:00" }.
 */
export function zonedDayBounds(iso: string, tz: string): { from: string; to: string } {
  const start = zonedMidnightMs(iso, tz);
  const end = zonedMidnightMs(addDaysIso(iso, 1), tz) - 1000;
  return { from: formatRfc3339InTz(start, tz), to: formatRfc3339InTz(end, tz) };
}

/**
 * Локальные дата+время (как ввёл пользователь) → строка Jira `started` со смещением
 * часового пояса `tz` на эту дату: ("2026-10-23", "09:30", "Europe/Moscow") →
 * "2026-10-23T09:30:00.000+0300". Время не пересчитывается — только добавляется offset.
 */
export function jiraStartedFromLocal(dateIso: string, hhmm: string, tz: string): string {
  const [y, m, d] = dateIso.slice(0, 10).split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  const offsetMs = getTimezoneOffsetMs(new Date(guess - getTimezoneOffsetMs(new Date(guess), tz)), tz);
  return `${dateIso.slice(0, 10)}T${pad(hh || 0)}:${pad(mm || 0)}:00.000${formatOffset(offsetMs, false)}`;
}
