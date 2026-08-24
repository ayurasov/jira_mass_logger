// localStorage-only стор «любимых задач» для быстрого выбора в дневной форме.
// Без SQLite/Tauri-команд: пользователь добавляет задачи, которые логирует часто,
// и видит их чипами в шапке дневной формы.
import { defineStore } from 'pinia';

export interface FavoriteTask {
  issueKey: string;
  issueSummary?: string | null;
  addedAt: string;
}

const STORAGE_KEY = 'jiratime-favorite-tasks';
const MAX_FAVORITES = 12;

function load(): FavoriteTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function save(items: FavoriteTask[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* приватный режим */ }
}

export const useFavoriteTasksStore = defineStore('favoriteTasks', {
  state: () => ({ items: load() as FavoriteTask[] }),
  getters: {
    has: (state) => state.items.length > 0,
  },
  actions: {
    isFavorite(issueKey: string): boolean {
      return this.items.some((t) => t.issueKey === issueKey);
    },
    add(issueKey: string, issueSummary?: string | null) {
      const key = issueKey.trim();
      if (!key) return;
      this.items = this.items.filter((t) => t.issueKey !== key);
      this.items.unshift({ issueKey: key, issueSummary: issueSummary ?? null, addedAt: new Date().toISOString() });
      this.items = this.items.slice(0, MAX_FAVORITES);
      save(this.items);
    },
    remove(issueKey: string) {
      this.items = this.items.filter((t) => t.issueKey !== issueKey);
      save(this.items);
    },
    toggle(issueKey: string, issueSummary?: string | null) {
      if (this.isFavorite(issueKey)) this.remove(issueKey);
      else this.add(issueKey, issueSummary);
    },
  },
});
