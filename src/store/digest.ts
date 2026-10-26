// Стор экрана «Дайджест»: скоуп (проекты или команда), период, порог «тишины».
import { defineStore } from 'pinia';
import { tauriApi, type JiraFilterDto, type ProjectDto } from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useTeamStore } from './team';
import { addDaysIso, localIsoDate } from '../utils/time';
import type { DigestData } from '../utils/digest';

const PREFS_KEY = 'jiratime-digest-prefs';

export interface SavedJql { id: string; name: string; jql: string }

/** Варианты лимита загрузки (изменённые задачи и задачи с worklog). */
export const LIMIT_OPTIONS = [50, 100, 300, 500, 1000] as const;
const RECENT_MAX = 6;

interface DigestPrefs {
  scopeType: 'project' | 'team' | 'jql';
  jql: string;
  projectKeys: string[];
  teamId: string;
  periodDays: number;
  staleDays: number;
  /** Сколько максимум задач грузить в тяжёлых запросах. */
  limit: number;
  /** Сохранённые пользователем JQL-запросы. */
  savedJql: SavedJql[];
  /** Последние выполненные JQL (без дублей, новые первыми). */
  recentJql: string[];
}

function loadPrefs(): DigestPrefs {
  const def: DigestPrefs = {
    scopeType: 'project', jql: '', projectKeys: [], teamId: '', periodDays: 7, staleDays: 14,
    limit: 300, savedJql: [], recentJql: [],
  };
  try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return def; }
}

/** Проект, в который вы чаще всего списываете время. */
export interface PopularProject { key: string; hours: number; lastDate: string }
const POPULAR_DAYS = 90;

let seq = 0;

const SEEN_KEY = 'jiratime-digest-seen';
function readSeen(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; }
}
function writeSeen(v: Record<string, string>) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

export const useDigestStore = defineStore('digest', {
  state: () => ({
    prefs: loadPrefs(),
    projects: [] as ProjectDto[],
    projectsError: '' as string,
    /** Ваши проекты по собственным списаниям за 90 дней (из локального кэша worklog). */
    popular: [] as PopularProject[],
    filters: [] as JiraFilterDto[],
    filtersLoading: false,
    filtersError: '' as string,
    data: null as DigestData | null,
    loading: false,
    error: null as string | null,
    loadedAt: null as string | null,
    /** Момент предыдущего просмотра этого скоупа — изменения новее помечаются «новое». */
    previousSeen: null as string | null,
  }),

  getters: {
    today: () => localIsoDate(),
    since(state): string { return addDaysIso(localIsoDate(), -(state.prefs.periodDays - 1)); },
    staleBefore(state): string { return addDaysIso(localIsoDate(), -state.prefs.staleDays); },
    team(state) {
      const t = useTeamStore();
      return t.teams.find((x) => x.id === state.prefs.teamId) ?? t.teams[0] ?? null;
    },
    scopeReady(): boolean {
      if (this.prefs.scopeType === 'jql') return this.prefs.jql.trim().length > 0;
      return this.prefs.scopeType === 'project' ? this.prefs.projectKeys.length > 0 : !!this.team?.members.length;
    },
    /** Ключ скоупа для «последнего просмотра». */
    scopeKey(): string {
      if (this.prefs.scopeType === 'jql') return `jql:${this.prefs.jql.trim()}`;
      if (this.prefs.scopeType === 'project') return `p:${[...this.prefs.projectKeys].sort().join(',')}`;
      return `t:${this.team?.id ?? ''}`;
    },
    scopeTitle(): string {
      if (this.prefs.scopeType === 'jql') return `JQL: ${this.prefs.jql.trim()}`;
      if (this.prefs.scopeType === 'project') return `Проекты ${this.prefs.projectKeys.join(', ')}`;
      return `Команда «${this.team?.name ?? ''}»`;
    },
  },

  actions: {
    savePrefs() {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* private mode */ }
    },

    async loadProjects() {
      if (this.projects.length) return;
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      if (!jp.activeConnectionParams) { this.projectsError = 'Нет активного профиля Jira'; return; }
      try {
        this.projects = (await tauriApi.getProjects(jp.activeConnectionParams)).sort((a, b) => a.key.localeCompare(b.key));
        this.projectsError = '';
      } catch (e) {
        this.projectsError = e instanceof Error ? e.message : String(e);
      }
    },

    /** Подсказки «ваши проекты»: часы по проекту из собственного worklog за 90 дней. */
    async loadPopular() {
      try {
        const today = localIsoDate();
        const rows = await tauriApi.listCachedWorklogs(addDaysIso(today, -POPULAR_DAYS), today);
        const map = new Map<string, PopularProject>();
        for (const r of rows) {
          const key = (r.projectKey || r.issueKey.split('-')[0] || '').toUpperCase();
          if (!key) continue;
          const p = map.get(key) ?? { key, hours: 0, lastDate: '' };
          p.hours += r.timeSpentSeconds / 3600;
          if (r.started.slice(0, 10) > p.lastDate) p.lastDate = r.started.slice(0, 10);
          map.set(key, p);
        }
        this.popular = [...map.values()]
          .map((p) => ({ ...p, hours: Math.round(p.hours * 10) / 10 }))
          .sort((a, b) => b.hours - a.hours)
          .slice(0, 8);
      } catch {
        this.popular = [];
      }
    },

    /** Сохранённые фильтры Jira (избранные, свои, командные). */
    async loadFilters(force = false) {
      if (this.filtersLoading || (this.filters.length && !force)) return;
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      if (!jp.activeConnectionParams) { this.filtersError = 'Нет активного профиля Jira'; return; }
      this.filtersLoading = true;
      try {
        this.filters = await tauriApi.getJiraFilters(jp.activeConnectionParams);
        this.filtersError = '';
      } catch (e) {
        this.filtersError = e instanceof Error ? e.message : String(e);
      } finally {
        this.filtersLoading = false;
      }
    },

    /** Подставить JQL (из сохранённых, недавних или фильтра Jira) и сразу показать. */
    useJql(jql: string) {
      this.prefs.jql = jql;
      this.load();
    },

    saveJql(name: string) {
      const jql = this.prefs.jql.trim();
      if (!jql) return;
      const title = name.trim() || jql.slice(0, 40);
      const existing = this.prefs.savedJql.find((q) => q.jql === jql || q.name === title);
      if (existing) { existing.name = title; existing.jql = jql; }
      else this.prefs.savedJql.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: title, jql });
      this.savePrefs();
    },

    deleteSavedJql(id: string) {
      this.prefs.savedJql = this.prefs.savedJql.filter((q) => q.id !== id);
      this.savePrefs();
    },

    setLimit(n: number) {
      this.prefs.limit = n;
      this.load();
    },

    toggleProject(key: string) {
      const set = new Set(this.prefs.projectKeys);
      if (set.has(key)) set.delete(key); else set.add(key);
      this.prefs.projectKeys = [...set];
      this.savePrefs();
    },

    async load() {
      this.savePrefs();
      if (!this.scopeReady) { this.data = null; return; }
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) { this.error = 'Нет активного профиля Jira — настройте подключение в «Профилях».'; return; }
      const scope = this.prefs.scopeType === 'jql'
        ? { jql: this.prefs.jql.trim() }
        : this.prefs.scopeType === 'project'
          ? { projectKeys: this.prefs.projectKeys }
          : { userIds: this.team!.members.map((m) => m.id) };
      const token = ++seq;
      this.loading = true;
      this.error = null;
      try {
        const data = await tauriApi.getJiraDigest(params, scope, this.since, this.today, this.staleBefore, this.prefs.limit);
        if (token !== seq) return;
        if (this.prefs.scopeType === 'jql') {
          const q = this.prefs.jql.trim();
          this.prefs.recentJql = [q, ...this.prefs.recentJql.filter((x) => x !== q)].slice(0, RECENT_MAX);
          this.savePrefs();
        }
        this.data = data;
        this.loadedAt = new Date().toISOString();
        // «Новое с прошлого просмотра»: запоминаем момент просмотра для этого скоупа.
        const seen = readSeen();
        this.previousSeen = seen[this.scopeKey] ?? null;
        seen[this.scopeKey] = this.loadedAt;
        writeSeen(seen);
      } catch (e) {
        if (token === seq) this.error = e instanceof Error ? e.message : String(e);
      } finally {
        if (token === seq) this.loading = false;
      }
    },
  },
});
