export interface WorklogTextContext { date: string; issue: string; week: string; }
export function getIsoWeek(dateIso: string): string {
  // Разбираем компоненты вручную: new Date('YYYY-MM-DD') — это UTC-полночь,
  // и getFullYear()/getDate() западнее UTC дали бы предыдущий день.
  const [y, m, d] = dateIso.slice(0, 10).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1, d));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
const WEEKDAY_RU_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

/** Описание переменных шаблонов — единый источник для страницы «Шаблоны» и мастера. */
export const WORKLOG_TEXT_VARIABLES: { token: string; desc: string }[] = [
  { token: 'date',          desc: 'Дата записи, например: 18.08.2026' },
  { token: 'week',          desc: 'День недели, например: вторник' },
  { token: 'week_number',   desc: 'Номер недели в году (ISO), например: 34' },
  { token: 'issue',         desc: 'Ключ задачи Jira' },
  { token: 'meeting_title', desc: 'Тема встречи из календаря (если есть)' },
];

/**
 * Подставляет переменные в шаблон описания. Раньше страница «Шаблоны» и мастер
 * понимали {week} по-разному (день недели / ISO-неделя), а {week_number} и
 * {meeting_title} мастер не подставлял вовсе — теперь правило одно.
 * `ctx.date` — "YYYY-MM-DD".
 */
export function renderWorklogText(template: string, ctx: WorklogTextContext & { meetingTitle?: string }): string {
  const [y, m, d] = ctx.date.slice(0, 10).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const weekNumber = String(Number((ctx.week || getIsoWeek(ctx.date)).split('-W')[1]));
  return template
    .replaceAll('{date}', `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`)
    .replaceAll('{week_number}', weekNumber)
    .replaceAll('{week}', WEEKDAY_RU_FULL[dt.getDay()])
    .replaceAll('{issue}', ctx.issue)
    .replaceAll('{meeting_title}', ctx.meetingTitle ?? '');
}
