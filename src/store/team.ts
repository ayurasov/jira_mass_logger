// Стор экрана «Команда»: сохранённые команды (пресеты участников), период,
// загрузка worklog коллег из Jira и проверка корректности заполнения.
import { defineStore } from 'pinia';
import { tauriApi, type JiraUserDto, type TeamWorklogDto } from '../lib/tauriApi';
import { useJiraProfilesStore } from './jiraProfiles';
import { useSettingsStore } from './settings';
import { addDaysIso, localIsoDate, parseIsoDate } from '../utils/time';
import { buildMemberReport, datesInRange, type CheckOptions, type MemberReport } from '../utils/worklogChecks';

export interface TeamMember { id: string; displayName: string; email?: string | null }
export interface TeamPreset { id: string; name: string; members: TeamMember[] }

export type PeriodPreset = 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';

export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: 'this_week', label: 'Эта неделя' },
  { id: 'last_week', label: 'Прошлая неделя' },
  { id: 'this_month', label: 'Этот месяц' },
  { id: 'last_month', label: 'Прошлый месяц' },
  { id: 'custom', label: 'Период…' },
];

const TEAMS_KEY = 'jiratime-teams';
const ACTIVE_KEY = 'jiratime-team-active';
const PERIOD_KEY = 'jiratime-team-period';

function mondayOf(iso: string): string {
  const dow = parseIsoDate(iso).getDay();
  return addDaysIso(iso, dow === 0 ? -6 : 1 - dow);
}

export function periodRange(preset: PeriodPreset, today = localIsoDate()): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = (yy: number, mm: number) => new Date(yy, mm, 0).getDate();
  switch (preset) {
    case 'last_week': {
      const mon = addDaysIso(mondayOf(today), -7);
      return { from: mon, to: addDaysIso(mon, 6) };
    }
    case 'this_month':
      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
    case 'last_month': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` };
    }
    case 'this_week':
    case 'custom':
    default: {
      const mon = mondayOf(today);
      return { from: mon, to: addDaysIso(mon, 6) };
    }
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

const savedPeriod = readJson<{ preset: PeriodPreset; from: string; to: string } | null>(PERIOD_KEY, null);
const initialPreset: PeriodPreset = savedPeriod?.preset ?? 'this_week';
const initialRange = initialPreset === 'custom' && savedPeriod
  ? { from: savedPeriod.from, to: savedPeriod.to }
  : periodRange(initialPreset);

let loadSeq = 0;

export const useTeamStore = defineStore('team', {
  state: () => ({
    teams: readJson<TeamPreset[]>(TEAMS_KEY, []),
    activeTeamId: localStorage.getItem(ACTIVE_KEY) || '',
    periodPreset: initialPreset,
    from: initialRange.from,
    to: initialRange.to,
    worklogs: [] as TeamWorklogDto[],
    loading: false,
    error: null as string | null,
    warnings: [] as string[],
    loadedAt: null as string | null,
    /** Больше стольких часов в день — ошибка «аномально много» (норма и график — из настроек). */
    maxDayHours: 12,
  }),

  getters: {
    activeTeam(state): TeamPreset | null {
      return state.teams.find((t) => t.id === state.activeTeamId) ?? state.teams[0] ?? null;
    },
    dates(state): string[] {
      return state.from && state.to && state.from <= state.to ? datesInRange(state.from, state.to) : [];
    },
    checkOptions(state): CheckOptions {
      const settings = useSettingsStore();
      return {
        normHours: settings.workdayHours || 8,
        workdays: settings.workdays?.length ? settings.workdays : [1, 2, 3, 4, 5],
        holidays: new Set(settings.holidays.map((h) => h.date)),
        today: localIsoDate(),
        maxDayHours: state.maxDayHours,
        tolerance: 0.05,
      };
    },
    reports(): (MemberReport & { member: TeamMember })[] {
      const team = this.activeTeam;
      if (!team) return [];
      const byAuthor = new Map<string, TeamWorklogDto[]>();
      for (const w of this.worklogs) {
        const key = w.authorId.toLowerCase();
        if (!byAuthor.has(key)) byAuthor.set(key, []);
        byAuthor.get(key)!.push(w);
      }
      return team.members.map((member) => ({
        member,
        ...buildMemberReport(member.id, this.dates, byAuthor.get(member.id.toLowerCase()) ?? [], this.checkOptions),
      }));
    },
    summary(): { totalHours: number; expectedHours: number; errors: number; warnings: number; infos: number } {
      const r = this.reports;
      const issues = r.flatMap((x) => x.issues);
      return {
        totalHours: Math.round(r.reduce((s, x) => s + x.totalHours, 0) * 100) / 100,
        expectedHours: r.reduce((s, x) => s + x.expectedHours, 0),
        errors: issues.filter((i) => i.severity === 'error').length,
        warnings: issues.filter((i) => i.severity === 'warning').length,
        infos: issues.filter((i) => i.severity === 'info').length,
      };
    },
  },

  actions: {
    persistTeams() {
      writeJson(TEAMS_KEY, this.teams);
      try { localStorage.setItem(ACTIVE_KEY, this.activeTeamId); } catch { /* private mode */ }
    },

    createTeam(name: string): TeamPreset {
      const team: TeamPreset = { id: `t${Date.now().toString(36)}`, name: name.trim() || 'Команда', members: [] };
      this.teams.push(team);
      this.activeTeamId = team.id;
      this.persistTeams();
      return team;
    },

    renameTeam(id: string, name: string) {
      const t = this.teams.find((x) => x.id === id);
      if (t && name.trim()) { t.name = name.trim(); this.persistTeams(); }
    },

    deleteTeam(id: string) {
      this.teams = this.teams.filter((t) => t.id !== id);
      if (this.activeTeamId === id) this.activeTeamId = this.teams[0]?.id ?? '';
      this.worklogs = [];
      this.persistTeams();
    },

    selectTeam(id: string) {
      this.activeTeamId = id;
      this.worklogs = [];
      this.persistTeams();
    },

    addMember(user: JiraUserDto) {
      const team = this.activeTeam ?? this.createTeam('Моя команда');
      if (team.members.some((m) => m.id.toLowerCase() === user.id.toLowerCase())) return;
      team.members.push({ id: user.id, displayName: user.displayName, email: user.email ?? null });
      this.persistTeams();
    },

    removeMember(id: string) {
      const team = this.activeTeam;
      if (!team) return;
      team.members = team.members.filter((m) => m.id !== id);
      this.worklogs = this.worklogs.filter((w) => w.authorId.toLowerCase() !== id.toLowerCase());
      this.persistTeams();
    },

    setPeriodPreset(preset: PeriodPreset) {
      this.periodPreset = preset;
      if (preset !== 'custom') Object.assign(this, periodRange(preset));
      writeJson(PERIOD_KEY, { preset, from: this.from, to: this.to });
    },

    setCustomPeriod(from: string, to: string) {
      this.periodPreset = 'custom';
      this.from = from;
      this.to = to;
      writeJson(PERIOD_KEY, { preset: 'custom', from, to });
    },

    /** Сдвиг текущего периода на его длину назад/вперёд (для стрелок ‹ ›). */
    shiftPeriod(direction: -1 | 1) {
      if (this.periodPreset === 'this_month' || this.periodPreset === 'last_month') {
        const [y, m] = this.from.split('-').map(Number);
        const d = new Date(y, m - 1 + direction, 1);
        const pad = (n: number) => String(n).padStart(2, '0');
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        this.setCustomPeriod(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(last)}`);
        return;
      }
      const len = this.dates.length || 7;
      this.setCustomPeriod(addDaysIso(this.from, direction * len), addDaysIso(this.to, direction * len));
    },

    async searchUsers(query: string): Promise<JiraUserDto[]> {
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) throw new Error('Нет активного профиля Jira');
      return tauriApi.searchJiraUsers(params, query);
    },

    /** «+ Я»: добавляет в активную команду текущего пользователя Jira. */
    async addMe() {
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) throw new Error('Нет активного профиля Jira');
      this.addMember(await tauriApi.getCurrentJiraUser(params));
    },

    async load() {
      const team = this.activeTeam;
      if (!team || team.members.length === 0) { this.worklogs = []; return; }
      if (!this.from || !this.to || this.from > this.to) { this.error = 'Некорректный период'; return; }
      if (this.dates.length > 92) { this.error = 'Период слишком длинный — выберите не больше 3 месяцев'; return; }
      const jp = useJiraProfilesStore();
      await jp.ensureLoaded();
      const params = jp.activeConnectionParams;
      if (!params) { this.error = 'Нет активного профиля Jira — настройте подключение в «Профилях».'; return; }

      const seq = ++loadSeq;
      this.loading = true;
      this.error = null;
      try {
        const res = await tauriApi.getTeamWorklogs(params, team.members.map((m) => m.id), this.from, this.to);
        if (seq !== loadSeq) return;
        this.worklogs = res.worklogs;
        this.warnings = [
          ...(res.truncated ? ['Слишком много задач за период — показана только часть данных. Сократите период или состав команды.'] : []),
          ...res.errors.slice(0, 5).map((e) => `Не удалось загрузить: ${e}`),
        ];
        this.loadedAt = new Date().toISOString();
      } catch (e) {
        if (seq === loadSeq) this.error = e instanceof Error ? e.message : String(e);
      } finally {
        if (seq === loadSeq) this.loading = false;
      }
    },
  },
});
