import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

export interface JiraProfile {
  id?: number;
  name: string;
  baseUrl: string;
  email: string;
  /** 'cloud' | 'server' — пришедшее с backend как instanceType (camelCase, см. jira_profiles.rs) */
  type: 'cloud' | 'server';
  instanceType?: 'cloud' | 'server';
  authType?: string;
  // apiToken/PAT хранится не здесь, а в OS keychain (keyring), тут только secretRef
  secretRef: string;
  isActive?: boolean;
}

interface BackendJiraProfile {
  id?: number | null;
  name: string;
  instanceType: string;
  authType?: string | null;
  baseUrl: string;
  email: string;
  secretRef?: string | null;
  isActive?: boolean | null;
}

export const useJiraProfilesStore = defineStore('jiraProfiles', {
  state: () => ({
    profiles: [] as JiraProfile[],
    loaded: false,
    loading: false,
    error: '' as string,
  }),
  getters: {
    /** Активный профиль — тот, у которого isActive === true, или первый в списке, если активный не пометчен. */
    activeProfile(state): JiraProfile | null {
      return state.profiles.find((p) => p.isActive) ?? state.profiles[0] ?? null;
    },
  },
  actions: {
    /**
     * Загружает список Jira-профилей из SQLite через Rust-команду `list_jira_profiles`.
     * Вызывайте при старте любого экрана, которому нужен активный профиль (BulkLogWizard и т.п.).
     */
    async loadProfiles() {
      this.loading = true;
      this.error = '';
      try {
        const rows = await invoke<BackendJiraProfile[]>('list_jira_profiles');
        this.profiles = rows.map((r) => ({
          id: r.id ?? undefined,
          name: r.name,
          baseUrl: r.baseUrl,
          email: r.email,
          type: (r.instanceType as 'cloud' | 'server') ?? 'cloud',
          instanceType: (r.instanceType as 'cloud' | 'server') ?? 'cloud',
          authType: r.authType ?? undefined,
          secretRef: r.secretRef ?? '',
          isActive: r.isActive ?? false,
        }));
        this.loaded = true;
      } catch (e) {
        this.error = String(e);
        console.error('[jiraProfiles] loadProfiles:', e);
      } finally {
        this.loading = false;
      }
    },

    /** Перезагружает список, если он ещё ни разу не загружался в этой сессии. */
    async ensureLoaded() {
      if (!this.loaded && !this.loading) {
        await this.loadProfiles();
      }
    },
  },
});
