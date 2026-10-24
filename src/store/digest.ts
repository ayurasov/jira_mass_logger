// Стор экрана «Дайджест»: скоуп (проекты или команда), период, порог «тишины».
import { defineStore } from 'pinia';
import { tauriApi, type ProjectDto } from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useTeamStore } from './team';
import { addDaysIso, localIsoDate } from '../utils/time';
import type { DigestData } from '../utils/digest';

const PREFS_KEY = 'jiratime-digest-prefs';

interface DigestPrefs {
  scopeType: 'project' | 'team' | 'jql';
  jql: string;
  projectKeys: string[];
  teamId: string;
  periodDays: number;
  staleDays: number;
}

function loadPrefs(): DigestPrefs {
  const def: DigestPrefs = { scopeType: 'project', jql: '', projectKeys: [], teamId: '', periodDays: 7, staleDays: 14 };
  try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return def; }
}

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
        const data = await tauriApi.getJiraDigest(params, scope, this.since, this.today, this.staleBefore);
        if (token !== seq) return;
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
