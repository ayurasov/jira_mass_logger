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
  worklogs: DigestWorklog[];
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

export function summarize(data: DigestData, since: string): DigestSummary {
  const transitions = data.updated.reduce((s, i) => s + i.changes.filter((c) => c.field.toLowerCase() === 'status').length, 0);
  const done = data.updated.filter((i) => i.statusCategory === 'done' && i.changes.some((c) => c.field.toLowerCase() === 'status')).length;
  return {
    updatedIssues: data.updated.length,
    transitions,
    done,
    created: data.updated.filter((i) => i.created.slice(0, 10) >= since).length,
    worklogHours: Math.round(data.worklogs.reduce((s, w) => s + w.timeSpentSeconds, 0) / 36) / 100,
    stale: data.stale.length,
  };
}
