import { defineStore } from 'pinia';
import {
  tauriApi,
  type JiraProfileDto,
  type JiraConnectionParams,
} from '../lib/tauriApi';

export const useJiraProfilesStore = defineStore('jiraProfiles', {
  state: () => ({
    profiles: [] as JiraProfileDto[],
    loading: false,
    error: null as string | null,
  }),

  getters: {
    activeProfile(): JiraProfileDto | undefined {
      return this.profiles.find((p) => p.isActive);
    },
    activeConnectionParams(): JiraConnectionParams {
      const p = this.activeProfile;
      if (!p) throw new Error('Нет активного профиля Jira');
      return {
        baseUrl: p.baseUrl,
        email: p.email,
        secretRef: p.secretRef,
        instanceType: p.instanceType,
        extraRootCaPemPath: p.extraRootCaPemPath,
        proxy: p.proxyUrl ? { url: p.proxyUrl, username: p.proxyUsername } : null,
        userTimezone: p.userTimezone,
      };
    },
  },

  actions: {
    async load() {
      this.loading = true;
      this.error = null;
      try {
        this.profiles = await tauriApi.listJiraProfiles();
      } catch (e: unknown) {
        this.error = String(e);
      } finally {
        this.loading = false;
      }
    },

    async saveProfile(profile: JiraProfileDto, token?: string): Promise<number> {
      // Сохраняем токен в keychain до записи профиля
      if (token) {
        await tauriApi.saveSecret(profile.secretRef, token);
      }
      const id = await tauriApi.saveJiraProfile(profile);
      await this.load();
      return id;
    },

    async deleteProfile(id: number) {
      const p = this.profiles.find((pr) => pr.id === id);
      if (p) {
        try { await tauriApi.deleteSecret(p.secretRef); } catch (_) { /* keychain может не иметь */ }
      }
      await tauriApi.deleteJiraProfile(id);
      await this.load();
    },

    async setActive(id: number) {
      await tauriApi.setActiveJiraProfile(id);
      await this.load();
    },

    async testProfile(profile: JiraProfileDto): Promise<boolean> {
      const params: JiraConnectionParams = {
        baseUrl: profile.baseUrl,
        email: profile.email,
        secretRef: profile.secretRef,
        instanceType: profile.instanceType,
        extraRootCaPemPath: profile.extraRootCaPemPath,
        proxy: profile.proxyUrl ? { url: profile.proxyUrl, username: profile.proxyUsername } : null,
        userTimezone: profile.userTimezone,
      };
      return tauriApi.testConnection(params);
    },
  },
});
