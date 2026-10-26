// Аналитика дайджеста Jira: лента изменений, активность людей, «тишина» в задачах.
// Чистые функции поверх ответа get_jira_digest.

export interface DigestChange {
  authorId?: string | null;
  authorName?: string | null;
  created: string;
  field: string;
  from?: string | null;
  to?: string | null;
}

export interface DigestIssue {
  key: string;
  summary: string;
  status: string;
  /** "new" | "indeterminate" | "done" */
  statusCategory: string;
  issueType?: string | null;
  priority?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  created: string;
  updated: string;
  dueDate?: string | null;
  projectKey?: string | null;
  changes: DigestChange[];
}

export interface DigestWorklog {
  id: string;
  authorId: string;
  authorName: string;
  issueKey: string;
  issueSummary?: string | null;
  started: string;
  timeSpentSeconds: number;
  comment?: string | null;
}

export interface DigestData {
  updated: DigestIssue[];
  stale: DigestIssue[];
  overdue: DigestIssue[];
  unassigned: DigestIssue[];
  worklogs: DigestWorklog[];
  /** Точное число задач в Jira (загруженных может быть меньше при очень больших выборках). */
  staleTotal?: number;
  overdueTotal?: number;
  unassignedTotal?: number;
  /** Применённый лимит для изменённых задач и задач с worklog. */
  limit?: number;
  truncated: boolean;
  errors: string[];
}

/** Поля changelog, которые дублируют worklog или не несут смысла в ленте. */
const NOISE_FIELDS = new Set(['timespent', 'timeestimate', 'timeoriginalestimate', 'worklogid', 'remainingestimate', 'rank', 'workratio']);

export const FIELD_LABELS: Record<string, string> = {
  status: 'Статус',
  assignee: 'Исполнитель',
  resolution: 'Решение',
  summary: 'Название',
  description: 'Описание',
  priority: 'Приоритет',
  sprint: 'Спринт',
  labels: 'Метки',
  'fix version': 'Версия',
  fixversions: 'Версия',
  duedate: 'Срок',
  reporter: 'Автор',
  issuetype: 'Тип',
  link: 'Связь',
  comment: 'Комментарий',
  attachment: 'Вложение',
  'story points': 'Story points',
  component: 'Компонент',
};

export const fieldLabel = (f: string) => FIELD_LABELS[f.toLowerCase()] ?? f;

export interface FeedEntry extends DigestChange {
  issueKey: string;
  issueSummary: string;
  kind: 'status' | 'assignee' | 'resolution' | 'other';
}

/** Лента изменений: новые сверху, шумовые поля убраны. */
export function buildFeed(issues: DigestIssue[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const i of issues) {
    for (const c of i.changes) {
      const f = c.field.toLowerCase();
      if (NOISE_FIELDS.has(f)) continue;
      out.push({
        ...c,
        issueKey: i.key,
        issueSummary: i.summary,
        kind: f === 'status' ? 'status' : f === 'assignee' ? 'assignee' : f === 'resolution' ? 'resolution' : 'other',
      });
    }
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

/** Группировка ленты по дню (дата из строки Jira — уже в TZ сервера/пользователя). */
export function groupByDay<T extends { created: string }>(entries: T[]): { date: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const e of entries) {
    const d = e.created.slice(0, 10);
    if (!map.has(d)) map.set(d, []);
    map.get(d)!.push(e);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, items]) => ({ date, items }));
}

export interface PersonActivity {
  id: string;
  name: string;
  changes: number;
  transitions: number;
  worklogHours: number;
  issues: Set<string>;
  /** Последняя активность (изменение или worklog), строка Jira-даты. */
  lastActivity: string | null;
  silent: boolean;
}

/**
 * Активность людей. `members` — состав команды (для скоупа «команда»: молчащие
 * участники тоже попадут в список); для проекта — все, кто проявился в данных.
 */
export function buildPeople(data: DigestData, members: { id: string; displayName: string }[] = []): PersonActivity[] {
  const map = new Map<string, PersonActivity>();
  const norm = (id: string) => id.toLowerCase();
  const get = (id: string, name: string) => {
    const k = norm(id);
    let p = map.get(k);
    if (!p) {
      p = { id, name: name || id, changes: 0, transitions: 0, worklogHours: 0, issues: new Set(), lastActivity: null, silent: true };
      map.set(k, p);
    }
    if (name && p.name === p.id) p.name = name;
    return p;
  };
  const touch = (p: PersonActivity, when: string) => {
    p.silent = false;
    if (!p.lastActivity || when > p.lastActivity) p.lastActivity = when;
  };
  for (const m of members) get(m.id, m.displayName);
  const memberSet = new Set(members.map((m) => norm(m.id)));
  const include = (id: string) => memberSet.size === 0 || memberSet.has(norm(id));

  for (const i of data.updated) {
    for (const c of i.changes) {
      if (!c.authorId || !include(c.authorId) || NOISE_FIELDS.has(c.field.toLowerCase())) continue;
      const p = get(c.authorId, c.authorName ?? '');
      p.changes++;
      if (c.field.toLowerCase() === 'status') p.transitions++;
      p.issues.add(i.key);
      touch(p, c.created);
    }
  }
  for (const w of data.worklogs) {
    if (!include(w.authorId)) continue;
    const p = get(w.authorId, w.authorName);
    p.worklogHours += w.timeSpentSeconds / 3600;
    p.issues.add(w.issueKey);
    touch(p, w.started);
  }
  return [...map.values()].sort((a, b) =>
    Number(a.silent) - Number(b.silent) || b.changes + b.worklogHours - (a.changes + a.worklogHours));
}

/** Задачи «в работе», по которым за период не было ни одного списания. */
export function inProgressWithoutWorklog(data: DigestData): DigestIssue[] {
  const logged = new Set(data.worklogs.map((w) => w.issueKey));
  const seen = new Set<string>();
  return [...data.updated, ...data.stale].filter((i) => {
    if (seen.has(i.key)) return false;
    seen.add(i.key);
    return i.statusCategory === 'indeterminate' && !logged.has(i.key);
  });
}

/** Сколько полных дней прошло с даты Jira до `today` (YYYY-MM-DD). */
export function daysSince(jiraDate: string, today: string): number {
  const [y1, m1, d1] = jiraDate.slice(0, 10).split('-').map(Number);
  const [y2, m2, d2] = today.split('-').map(Number);
  return Math.max(0, Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000));
}

export interface DigestSummary {
  updatedIssues: number;
  transitions: number;
  done: number;
  created: number;
  worklogHours: number;
  stale: number;
}

/** Точное число по спискам: из Jira, а если бэкенд старый — по загруженному. */
export const staleCount = (d: DigestData) => Math.max(d.staleTotal ?? 0, d.stale.length);
export const overdueCount = (d: DigestData) => Math.max(d.overdueTotal ?? 0, d.overdue?.length ?? 0);
export const unassignedCount = (d: DigestData) => Math.max(d.unassignedTotal ?? 0, d.unassigned?.length ?? 0);

export function summarize(data: DigestData, since: string): DigestSummary {
  const transitions = data.updated.reduce((s, i) => s + i.changes.filter((c) => c.field.toLowerCase() === 'status').length, 0);
  const done = data.updated.filter((i) => i.statusCategory === 'done' && i.changes.some((c) => c.field.toLowerCase() === 'status')).length;
  return {
    updatedIssues: data.updated.length,
    transitions,
    done,
    created: data.updated.filter((i) => i.created.slice(0, 10) >= since).length,
    worklogHours: Math.round(data.worklogs.reduce((s, w) => s + w.timeSpentSeconds, 0) / 36) / 100,
    stale: staleCount(data),
  };
}

// ── Расширенная аналитика ───────────────────────────────────────────

/** Категория статуса по имени — из текущих статусов задач в выборке. */
export function statusCategories(data: DigestData): Map<string, string> {
  const m = new Map<string, string>();
  for (const i of [...data.updated, ...data.stale, ...(data.overdue ?? []), ...(data.unassigned ?? [])]) {
    if (i.status && i.statusCategory) m.set(i.status.toLowerCase(), i.statusCategory);
  }
  return m;
}

export interface TransitionStats {
  closed: string[];
  reopened: string[];
  /** Задачи, у которых статус менялся 3+ раза за период. */
  pingPong: { key: string; count: number }[];
}

export function transitionStats(data: DigestData): TransitionStats {
  const cats = statusCategories(data);
  const closed = new Set<string>();
  const reopened = new Set<string>();
  const pingPong: { key: string; count: number }[] = [];
  for (const i of data.updated) {
    const st = i.changes.filter((c) => c.field.toLowerCase() === 'status');
    for (const c of st) {
      const fromCat = cats.get((c.from ?? '').toLowerCase());
      const toCat = cats.get((c.to ?? '').toLowerCase());
      if (toCat === 'done') closed.add(i.key);
      if (fromCat === 'done' && toCat && toCat !== 'done') reopened.add(i.key);
    }
    if (st.length >= 3) pingPong.push({ key: i.key, count: st.length });
  }
  // «Закрыта» — только если и сейчас в Done (не переоткрыта следом).
  const doneNow = new Set(data.updated.filter((i) => i.statusCategory === 'done').map((i) => i.key));
  return {
    closed: [...closed].filter((k) => doneNow.has(k)),
    // Переоткрытую и снова закрытую задачу считаем закрытой, а не «вернувшейся».
    reopened: [...reopened].filter((k) => !doneNow.has(k)),
    pingPong: pingPong.sort((a, b) => b.count - a.count),
  };
}

export interface DayActivity { date: string; changes: number; hours: number }

/** Активность по дням периода: изменения и списанные часы. */
export function activityByDay(data: DigestData, dates: string[]): DayActivity[] {
  const map = new Map(dates.map((d) => [d, { date: d, changes: 0, hours: 0 }]));
  for (const e of buildFeed(data.updated)) {
    const d = map.get(e.created.slice(0, 10));
    if (d) d.changes++;
  }
  for (const w of data.worklogs) {
    const d = map.get(w.started.slice(0, 10));
    if (d) d.hours += w.timeSpentSeconds / 3600;
  }
  return [...map.values()];
}

export interface ProjectActivity { key: string; updated: number; changes: number; hours: number; stale: number }

export function byProject(data: DigestData): ProjectActivity[] {
  const map = new Map<string, ProjectActivity>();
  const get = (k: string) => {
    let p = map.get(k);
    if (!p) { p = { key: k, updated: 0, changes: 0, hours: 0, stale: 0 }; map.set(k, p); }
    return p;
  };
  const proj = (i: { projectKey?: string | null; key: string }) => i.projectKey || i.key.split('-')[0];
  for (const i of data.updated) {
    const p = get(proj(i));
    p.updated++;
    p.changes += i.changes.filter((c) => !NOISE_FIELDS.has(c.field.toLowerCase())).length;
  }
  for (const i of data.stale) get(proj(i)).stale++;
  for (const w of data.worklogs) get(w.issueKey.split('-')[0]).hours += w.timeSpentSeconds / 3600;
  return [...map.values()].sort((a, b) => b.changes + b.hours - (a.changes + a.hours));
}

export type Tone = 'good' | 'warn' | 'bad' | 'info';
export interface Highlight { tone: Tone; text: string; keys: string[] }

/** Склонение: 1 изменение, 2 изменения, 5 изменений. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const keysText = (keys: string[], max = 4) => keys.slice(0, max).join(', ') + (keys.length > max ? ` и ещё ${keys.length - max}` : '');

/** «Главное за период» — короткие выводы для руководителя/стендапа. */
export function highlights(data: DigestData, people: PersonActivity[], scopeIsTeam: boolean): Highlight[] {
  const out: Highlight[] = [];
  const t = transitionStats(data);
  if (t.closed.length) out.push({ tone: 'good', text: `Закрыто задач: ${t.closed.length} (${keysText(t.closed)})`, keys: t.closed });
  if (t.reopened.length) out.push({ tone: 'bad', text: `Вернулись в работу после закрытия: ${keysText(t.reopened)}`, keys: t.reopened });
  if (t.pingPong.length) out.push({ tone: 'warn', text: `Статус «скачет» (3+ смены): ${keysText(t.pingPong.map((p) => `${p.key}×${p.count}`))}`, keys: t.pingPong.map((p) => p.key) });
  const overdue = data.overdue ?? [];
  if (overdue.length) out.push({ tone: 'bad', text: `Просрочено открытых задач: ${overdueCount(data)} (${keysText(overdue.map((i) => i.key))})`, keys: overdue.map((i) => i.key) });
  const unassigned = data.unassigned ?? [];
  if (unassigned.length) out.push({ tone: 'warn', text: `Открытых задач без исполнителя: ${unassignedCount(data)}`, keys: unassigned.map((i) => i.key) });
  const noWl = inProgressWithoutWorklog(data);
  if (noWl.length) out.push({ tone: 'warn', text: `В работе, но без списаний за период: ${keysText(noWl.map((i) => i.key))}`, keys: noWl.map((i) => i.key) });
  if (data.stale.length) out.push({ tone: 'warn', text: `Без движения: ${staleCount(data)} открытых задач`, keys: data.stale.map((i) => i.key) });
  const silent = people.filter((p) => p.silent);
  if (scopeIsTeam && silent.length) out.push({ tone: 'bad', text: `Без активности: ${silent.map((p) => p.name).join(', ')}`, keys: [] });
  const active = people.filter((p) => !p.silent).sort((a, b) => b.changes + b.worklogHours - (a.changes + a.worklogHours));
  if (active.length) {
    const top = active[0];
    out.push({ tone: 'info', text: `Больше всего активности: ${top.name} — ${top.changes} изм., ${Math.round(top.worklogHours * 10) / 10} ч`, keys: [] });
  }
  const hot = [...data.updated].sort((a, b) => b.changes.length - a.changes.length)[0];
  if (hot && hot.changes.length >= 3) out.push({ tone: 'info', text: `Самая обсуждаемая задача: ${hot.key} — ${hot.changes.length} ${plural(hot.changes.length, 'изменение', 'изменения', 'изменений')}`, keys: [hot.key] });
  if (!out.length) out.push({ tone: 'good', text: 'Ничего примечательного: изменений и проблем не найдено.', keys: [] });
  return out;
}

/** Текстовая версия дайджеста для мессенджера. */
export function digestText(title: string, summary: DigestSummary, hl: Highlight[]): string {
  const icon: Record<Tone, string> = { good: '✅', warn: '🟡', bad: '🔴', info: 'ℹ️' };
  return [
    title,
    `Изменено задач: ${summary.updatedIssues} (новых ${summary.created}), смен статуса: ${summary.transitions}, закрыто: ${summary.done}, списано: ${summary.worklogHours} ч`,
    '',
    ...hl.map((h) => `${icon[h.tone]} ${h.text}`),
  ].join('\n');
}
