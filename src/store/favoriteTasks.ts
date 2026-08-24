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
    /** Обновляет «свежесть» задачи при каждом логировании: если задача уже в
     *  списке — обновляет summary и поднимает наверх (most-recently-used);
     *  если нет — добавляет как недавнюю. Так список любимых = последние
     *  используемые задачи, без ручного поддержания. */
    touch(issueKey: string, issueSummary?: string | null) {
      const key = issueKey.trim();
      if (!key) return;
      const existing = this.items.find((t) => t.issueKey === key);
      if (existing) {
        if (issueSummary) existing.issueSummary = issueSummary;
        existing.addedAt = new Date().toISOString();
        // поднимаем наверх (MRU)
        this.items = [existing, ...this.items.filter((t) => t.issueKey !== key)];
        save(this.items);
      } else {
        this.add(key, issueSummary);
      }
    },
    /** Bootstrap из кэша worklog за последние ~90 дней: топ задач по часам
     *  добавляется в список (только отсутствующие — не удаляет user-pinned).
     *  Вызывается при загрузке календаря, чтобы чипы «любимых» появились сразу. */
    seedFromRecent(rows: { issueKey: string; issueSummary?: string | null; timeSpentSeconds: number }[]) {
      const agg = new Map<string, { hours: number; summary?: string | null }>();
      for (const r of rows) {
        const k = (r.issueKey || '').trim();
        if (!k) continue;
        const prev = agg.get(k) ?? { hours: 0 };
        prev.hours += (r.timeSpentSeconds ?? 0) / 3600;
        if (r.issueSummary) prev.summary = r.issueSummary;
        agg.set(k, prev);
      }
      const top = Array.from(agg.entries())
        .sort((a, b) => b[1].hours - a[1].hours)
        .slice(0, 8)
        .map(([key, v]) => ({ issueKey: key, issueSummary: v.summary ?? null }));
      let changed = false;
      for (const t of top) {
        if (!this.items.some((x) => x.issueKey === t.issueKey)) {
          this.items.push({ issueKey: t.issueKey, issueSummary: t.issueSummary, addedAt: new Date().toISOString() });
          changed = true;
        }
      }
      if (changed) {
        this.items = this.items.slice(0, MAX_FAVORITES);
        save(this.items);
      }
    },
  },
});
