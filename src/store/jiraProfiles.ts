import { defineStore } from 'pinia';

export interface JiraProfile {
  id?: number;
  name: string;
  baseUrl: string;
  email: string;
  type: 'cloud' | 'server';
  // apiToken/PAT хранится не здесь, а в OS keychain (keyring), тут только secretRef
  secretRef: string;
}

export const useJiraProfilesStore = defineStore('jiraProfiles', {
  state: () => ({
    profiles: [] as JiraProfile[],
  }),
});
