// Перенос настроек: сбор данных приложения в файл и применение файла на другом компьютере.
// Пароли, токены и вебхуки не переносятся — подключения из файла предлагаются к добавлению
// с заполненной формой, где остаётся ввести только пароль или токен.
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open, save } from '@tauri-apps/plugin-dialog';
import { tauriApi } from '../lib/tauriApi';
import { localIsoDate } from '../utils/time';
import {
  SETTINGS_FILE_FORMAT, SETTINGS_FILE_VERSION, TRANSFER_PREF_KEYS, describePlan, parseSettingsFile, planImport,
  type CurrentState, type SectionId, type SettingsFile, type TransferExchangeProfile, type TransferJiraProfile,
} from '../utils/settingsTransfer';

const PENDING_KEY = 'jiratime-pending-connections';

export interface PendingConnections { jira: TransferJiraProfile[]; exchange: TransferExchangeProfile[] }

export function loadPending(): PendingConnections {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
    return { jira: Array.isArray(v.jira) ? v.jira : [], exchange: Array.isArray(v.exchange) ? v.exchange : [] };
  } catch {
    return { jira: [], exchange: [] };
  }
}

function savePending(p: PendingConnections) {
  try {
    if (!p.jira.length && !p.exchange.length) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch { /* private mode */ }
}

interface BackendJiraProfile {
  name: string; instanceType: string; authType?: string | null; baseUrl: string; email: string;
  isActive?: boolean | null; acceptInvalidCerts?: boolean | null;
}

export const useSettingsTransferStore = defineStore('settingsTransfer', {
  state: () => ({
    pending: loadPending(),
    busy: false,
  }),

  actions: {
    /** Собирает файл настроек из текущего состояния приложения. */
    async collect(): Promise<SettingsFile> {
      const prefs: Record<string, string> = {};
      for (const k of TRANSFER_PREF_KEYS) {
        const v = localStorage.getItem(k);
        if (v !== null) prefs[k] = v;
      }
      let bitrix: SettingsFile['bitrix'] = null;
      try {
        const b = JSON.parse(localStorage.getItem('jiratime-bitrix') || 'null');
        if (b) bitrix = { role: b.role, status: b.status };
      } catch { /* битое значение — пропускаем */ }
      const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
      const [jira, exchange, templates, wizard, rules, holidays, recent, scheduler, appVersion] = await Promise.all([
        safe(invoke<BackendJiraProfile[]>('list_jira_profiles'), []),
        safe(tauriApi.listExchangeProfiles(), []),
        safe(tauriApi.listTemplates(), []),
        safe(tauriApi.listWizardTemplates(), []),
        safe(tauriApi.listMeetingMatchRules(), []),
        safe(tauriApi.getCustomHolidays(), []),
        safe(tauriApi.getRecentIssues(), []),
        safe(tauriApi.getSchedulerSettings().then((s) => s as SettingsFile['scheduler']), null),
        safe(getVersion(), ''),
      ]);
      return {
        format: SETTINGS_FILE_FORMAT,
        version: SETTINGS_FILE_VERSION,
        exportedAt: new Date().toISOString(),
        appVersion,
        prefs,
        bitrix,
        jiraProfiles: jira.map((p) => ({
          name: p.name, instanceType: p.instanceType, authType: p.authType ?? null, baseUrl: p.baseUrl, email: p.email,
          isActive: !!p.isActive, acceptInvalidCerts: !!p.acceptInvalidCerts,
        })),
        exchangeProfiles: exchange.map((p: any) => ({
          name: p.name, authMode: p.authMode, ewsUrl: p.ewsUrl ?? null, ewsAuthType: p.ewsAuthType ?? null, username: p.username,
          tenantId: p.tenantId ?? null, clientId: p.clientId ?? null, minEventMinutes: p.minEventMinutes ?? 0,
          excludeFreeBusy: p.excludeFreeBusy ?? true, excludeDeclined: p.excludeDeclined ?? true, isActive: !!p.isActive,
        })),
        textTemplates: templates.map((t) => ({ name: t.name, text: t.text, issueKey: t.issueKey ?? null, isPinned: !!t.isPinned })),
        wizardTemplates: wizard.map((t) => ({ name: t.name, configJson: t.configJson })),
        meetingRules: rules.map(({ id: _id, ...r }) => r),
        customHolidays: holidays,
        favoriteIssues: recent.filter((r) => r.isFavorite).map((r) => ({ issueKey: r.issueKey, summary: r.summary ?? null })),
        scheduler,
      };
    },

    /** «Сохранить настройки в файл». Возвращает путь или null, если пользователь передумал. */
    async exportToFile(): Promise<string | null> {
      const path = await save({
        title: 'Сохранить настройки JiraTime',
        defaultPath: `JiraTime-настройки-${localIsoDate()}.json`,
        filters: [{ name: 'Настройки JiraTime', extensions: ['json'] }],
      });
      if (!path) return null;
      this.busy = true;
      try {
        const file = await this.collect();
        await tauriApi.writeExportFile(path, JSON.stringify(file, null, 2));
        return path;
      } finally {
        this.busy = false;
      }
    },

    /** Выбор и разбор файла. Ошибки формата — с понятным текстом. */
    async pickFile(): Promise<SettingsFile | null> {
      const path = await open({
        title: 'Файл настроек JiraTime',
        multiple: false,
        directory: false,
        filters: [{ name: 'Настройки JiraTime', extensions: ['json'] }],
      });
      if (!path || Array.isArray(path)) return null;
      return parseSettingsFile(await tauriApi.readTextFile(path));
    },

    async currentState(): Promise<CurrentState> {
      const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
      const [templates, wizard, rules, holidays, recent, jira, exchange] = await Promise.all([
        safe(tauriApi.listTemplates(), []),
        safe(tauriApi.listWizardTemplates(), []),
        safe(tauriApi.listMeetingMatchRules(), []),
        safe(tauriApi.getCustomHolidays(), []),
        safe(tauriApi.getRecentIssues(), []),
        safe(invoke<BackendJiraProfile[]>('list_jira_profiles'), []),
        safe(tauriApi.listExchangeProfiles(), []),
      ]);
      return {
        textTemplates: templates.map((t) => ({ name: t.name, text: t.text, issueKey: t.issueKey ?? null, isPinned: !!t.isPinned })),
        wizardTemplateNames: wizard.map((t) => t.name),
        meetingRules: rules,
        customHolidays: holidays,
        favoriteIssueKeys: recent.filter((r) => r.isFavorite).map((r) => r.issueKey),
        jiraProfiles: jira.map((p) => ({ baseUrl: p.baseUrl, email: p.email })),
        exchangeProfiles: exchange.map((p: any) => ({ username: p.username, authMode: p.authMode })),
      };
    },

    /**
     * Применяет выбранные разделы файла. Ничего не удаляет: шаблоны, правила и избранное
     * добавляются без дублей, настройки экранов заменяются значениями из файла.
     * После импорта интерфейс нужно перезагрузить — сторы читают настройки при старте.
     */
    async apply(file: SettingsFile, sections: Set<SectionId>): Promise<string[]> {
      this.busy = true;
      try {
        const plan = planImport(file, await this.currentState(), sections);
        for (const [k, v] of Object.entries(plan.prefs)) localStorage.setItem(k, v);
        if (plan.bitrix) {
          let cur: Record<string, unknown> = {};
          try { cur = JSON.parse(localStorage.getItem('jiratime-bitrix') || '{}') ?? {}; } catch { /* битое значение */ }
          localStorage.setItem('jiratime-bitrix', JSON.stringify({ ...cur, ...Object.fromEntries(Object.entries(plan.bitrix).filter(([, v]) => v)) }));
        }
        for (const t of plan.textTemplates) await tauriApi.saveTemplate({ id: null, ...t });
        for (const t of plan.wizardTemplates) await tauriApi.saveWizardTemplate(t.name, t.configJson);
        for (const r of plan.meetingRules) await tauriApi.saveMeetingMatchRule({ id: null, ...r });
        if (plan.customHolidays) await tauriApi.importHolidays(plan.customHolidays);
        for (const f of plan.favoriteIssues) {
          await tauriApi.touchRecentIssue(f.issueKey, f.summary);
          await tauriApi.setIssueFavorite(f.issueKey, true);
        }
        if (plan.scheduler) await tauriApi.saveSchedulerSettings(plan.scheduler);
        if (plan.pendingJira.length || plan.pendingExchange.length) {
          const p = loadPending();
          const jiraKey = (x: TransferJiraProfile) => `${x.baseUrl}|${x.email}`.toLowerCase();
          const exchKey = (x: TransferExchangeProfile) => `${x.authMode}|${x.username}`.toLowerCase();
          const seenJ = new Set(p.jira.map(jiraKey));
          const seenE = new Set(p.exchange.map(exchKey));
          p.jira.push(...plan.pendingJira.filter((x) => !seenJ.has(jiraKey(x))));
          p.exchange.push(...plan.pendingExchange.filter((x) => !seenE.has(exchKey(x))));
          savePending(p);
          this.pending = p;
        }
        return describePlan(plan);
      } finally {
        this.busy = false;
      }
    },

    /** Подключение из файла добавлено или не нужно — убираем из списка. */
    dismissPending(kind: 'jira' | 'exchange', index: number) {
      const p = loadPending();
      p[kind].splice(index, 1);
      savePending(p);
      this.pending = p;
    },

    /** После сохранения профиля: убрать совпадающее подключение из списка ожидающих. */
    resolveJira(baseUrl: string, email: string) {
      const p = loadPending();
      const key = `${baseUrl.replace(/\/+$/, '')}|${email}`.toLowerCase();
      p.jira = p.jira.filter((x) => `${x.baseUrl.replace(/\/+$/, '')}|${x.email}`.toLowerCase() !== key);
      savePending(p);
      this.pending = p;
    },

    resolveExchange(authMode: string, username: string) {
      const p = loadPending();
      p.exchange = p.exchange.filter((x) => `${x.authMode}|${x.username}`.toLowerCase() !== `${authMode}|${username}`.toLowerCase());
      savePending(p);
      this.pending = p;
    },
  },
});
