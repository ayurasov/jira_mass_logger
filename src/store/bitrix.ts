// Стор раздела «Битрикс24» (необязательная интеграция): подключение через входящий вебхук,
// список своих задач (ответственный/наблюдатель/соисполнитель/постановщик), карточка задачи,
// комментарии и результаты. Вебхук хранится только в системном хранилище секретов.
import { defineStore } from 'pinia';
import {
  tauriApi, type BitrixRole, type BitrixStatusFilter, type BitrixTask, type BitrixTaskDetail, type BitrixUser,
} from '../lib/tauriApi';

const SETTINGS_KEY = 'jiratime-bitrix';
const SECRET_REF = 'bitrix-webhook';

interface BitrixSettings {
  /** Раздел включён (пункт меню виден). */
  enabled: boolean;
  /** Кто подключён — показывается в настройках и для ссылок на задачи. */
  user: BitrixUser | null;
  role: BitrixRole;
  status: BitrixStatusFilter;
}

function loadSettings(): BitrixSettings {
  const def: BitrixSettings = { enabled: false, user: null, role: 'all', status: 'active' };
  try { return { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return def; }
}

export const BITRIX_ROLES: { id: BitrixRole; label: string; hint: string }[] = [
  { id: 'all', label: 'Все мои', hint: 'задачи, где вы в любой роли' },
  { id: 'responsible', label: 'Я исполнитель', hint: 'вы ответственный' },
  { id: 'auditor', label: 'Наблюдаю', hint: 'вы наблюдатель' },
  { id: 'accomplice', label: 'Соисполнитель', hint: 'вы соисполнитель' },
  { id: 'originator', label: 'Поставил я', hint: 'вы постановщик' },
];

export const BITRIX_STATUS: Record<string, { label: string; tone: 'new' | 'work' | 'wait' | 'done' | 'off' }> = {
  '1': { label: 'Новая', tone: 'new' },
  '2': { label: 'Ждёт выполнения', tone: 'new' },
  '3': { label: 'Выполняется', tone: 'work' },
  '4': { label: 'Ждёт контроля', tone: 'wait' },
  '5': { label: 'Завершена', tone: 'done' },
  '6': { label: 'Отложена', tone: 'off' },
  '7': { label: 'Отклонена', tone: 'off' },
};

let listSeq = 0;
let searchTimer: number | null = null;

export const useBitrixStore = defineStore('bitrix', {
  state: () => ({
    settings: loadSettings(),
    search: '',
    tasks: [] as BitrixTask[],
    total: 0,
    next: null as number | null,
    loading: false,
    loadingMore: false,
    error: '' as string,
    selectedId: null as string | null,
    detail: null as BitrixTaskDetail | null,
    detailLoading: false,
    detailError: '' as string,
    sending: false,
    connecting: false,
  }),

  getters: {
    connected: (state) => !!state.settings.user,
    /** Ссылка на задачу в веб-интерфейсе портала. */
    taskUrl: (state) => (id: string) => {
      const u = state.settings.user;
      return u ? `${u.portal}/company/personal/user/${u.id}/tasks/task/view/${id}/` : '';
    },
  },

  actions: {
    saveSettings() {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
    },

    setEnabled(on: boolean) {
      this.settings.enabled = on;
      this.saveSettings();
    },

    /** Сохраняет вебхук в хранилище секретов и проверяет его. Ошибку бросает наружу. */
    async connect(webhook: string): Promise<BitrixUser> {
      this.connecting = true;
      try {
        await tauriApi.saveSecret(SECRET_REF, webhook.trim());
        const user = await tauriApi.bitrixTest(SECRET_REF);
        this.settings.user = user;
        this.settings.enabled = true;
        this.saveSettings();
        this.tasks = [];
        return user;
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : String(e));
      } finally {
        this.connecting = false;
      }
    },

    /** Перепроверка сохранённого вебхука. */
    async recheck(): Promise<BitrixUser> {
      const user = await tauriApi.bitrixTest(SECRET_REF);
      this.settings.user = user;
      this.saveSettings();
      return user;
    },

    async disconnect() {
      await tauriApi.deleteSecret(SECRET_REF).catch(() => {});
      this.settings.user = null;
      this.tasks = [];
      this.detail = null;
      this.selectedId = null;
      this.saveSettings();
    },

    setRole(role: BitrixRole) {
      this.settings.role = role;
      this.saveSettings();
      this.loadTasks();
    },

    setStatus(status: BitrixStatusFilter) {
      this.settings.status = status;
      this.saveSettings();
      this.loadTasks();
    },

    /** Поиск с задержкой: запрос уходит, когда пользователь перестал печатать. */
    setSearch(q: string) {
      this.search = q;
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => this.loadTasks(), 350);
    },

    async loadTasks() {
      if (!this.connected) return;
      const token = ++listSeq;
      this.loading = true;
      this.error = '';
      try {
        const page = await tauriApi.bitrixListTasks(SECRET_REF, this.settings.role, this.settings.status, this.search.trim() || null, 0);
        if (token !== listSeq) return;
        this.tasks = page.tasks;
        this.total = page.total;
        this.next = page.next ?? null;
        // Выбранная задача пропала из выборки — открываем первую.
        if (!this.tasks.some((t) => t.id === this.selectedId)) {
          if (this.tasks[0]) this.openTask(this.tasks[0].id);
          else { this.selectedId = null; this.detail = null; }
        }
      } catch (e) {
        if (token === listSeq) this.error = e instanceof Error ? e.message : String(e);
      } finally {
        if (token === listSeq) this.loading = false;
      }
    },

    async loadMore() {
      if (this.next === null || this.loadingMore) return;
      const token = listSeq;
      this.loadingMore = true;
      try {
        const page = await tauriApi.bitrixListTasks(SECRET_REF, this.settings.role, this.settings.status, this.search.trim() || null, this.next);
        if (token !== listSeq) return;
        const seen = new Set(this.tasks.map((t) => t.id));
        this.tasks.push(...page.tasks.filter((t) => !seen.has(t.id)));
        this.next = page.next ?? null;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loadingMore = false;
      }
    },

    async openTask(id: string) {
      this.selectedId = id;
      this.detailLoading = true;
      this.detailError = '';
      try {
        const d = await tauriApi.bitrixGetTask(SECRET_REF, id);
        if (this.selectedId === id) this.detail = d;
      } catch (e) {
        if (this.selectedId === id) { this.detail = null; this.detailError = e instanceof Error ? e.message : String(e); }
      } finally {
        if (this.selectedId === id) this.detailLoading = false;
      }
    },

    /** Комментарий к открытой задаче (и, при желании, отметка «результат»). Возвращает текст итога. */
    async addComment(text: string, asResult: boolean): Promise<{ ok: boolean; message: string }> {
      const id = this.selectedId;
      if (!id) return { ok: false, message: 'Задача не выбрана' };
      this.sending = true;
      try {
        const r = await tauriApi.bitrixAddComment(SECRET_REF, id, text, asResult);
        await this.openTask(id);
        if (asResult && !r.resultAdded) {
          return { ok: false, message: `Комментарий добавлен, но отметить его результатом не удалось: ${r.resultError ?? 'нет доступа'}` };
        }
        return { ok: true, message: asResult ? 'Результат добавлен в задачу.' : 'Комментарий добавлен.' };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      } finally {
        this.sending = false;
      }
    },
  },
});

/** Текст из Битрикс24 без BB-кодов ([B], [URL=…], [USER=…]) — для спокойного показа. */
export function plainBitrixText(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/\[(?:USER|URL)=[^\]]*\]([^[]*)\[\/(?:USER|URL)\]/gi, '$1')
    .replace(/\[\/?[A-Z*]+(?:=[^\]]*)?\]/gi, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}
