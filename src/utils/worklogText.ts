export interface WorklogTextContext { date: string; issue: string; week: string; }
export function getIsoWeek(dateIso: string): string {
  const date = new Date(dateIso);
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
export function renderWorklogText(template: string, ctx: WorklogTextContext): string {
  return template.replaceAll('{date}', ctx.date).replaceAll('{issue}', ctx.issue).replaceAll('{week}', ctx.week);
}
