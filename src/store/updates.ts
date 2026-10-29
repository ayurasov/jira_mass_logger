// Автообновление приложения: проверка при запуске и вручную, загрузка с прогрессом,
// установка и перезапуск. Канал (ключ подписи + адрес latest.json) зашивается в сборку
// релизным workflow; если его нет — экран настроек честно пишет, что обновления ставятся вручную.
import { defineStore } from 'pinia';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { tauriApi } from '../lib/tauriApi';

const PREFS_KEY = 'jiratime-updates';
/** Автопроверка при запуске — не чаще раза в 6 часов. */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdatePrefs {
  /** Проверять обновления при запуске приложения. */
  autoCheck: boolean;
  /** ISO-время последней успешной проверки. */
  lastCheckAt: string | null;
  /** Версия, о которой пользователь попросил не напоминать (плашка «Позже»). */
  dismissedVersion: string | null;
  /** Последняя проверка нашла эту версию — при следующем запуске проверяем сразу, без паузы. */
  knownUpdate: string | null;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  /** Дата выпуска YYYY-MM-DD, если канал её сообщил. */
  date: string | null;
  notes: string;
}

type Phase = 'idle' | 'downloading' | 'installing' | 'restarting';

function loadPrefs(): UpdatePrefs {
  const def: UpdatePrefs = { autoCheck: true, lastCheckAt: null, dismissedVersion: null, knownUpdate: null };
  try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return def; }
}

/** Дата из канала обновлений → YYYY-MM-DD. Tauri отдаёт и RFC 3339, и «2026-10-30 10:00:00.0 +00:00:00». */
export function releaseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return m ? m[1] : null;
}

/** Нужна ли автопроверка сейчас. */
export function isAutoCheckDue(prefs: UpdatePrefs, now: number): boolean {
  if (!prefs.autoCheck) return false;
  // Обновление уже нашли, но не поставили — напоминаем при каждом запуске.
  if (prefs.knownUpdate || !prefs.lastCheckAt) return true;
  const last = Date.parse(prefs.lastCheckAt);
  return Number.isNaN(last) || now - last >= AUTO_CHECK_INTERVAL_MS;
}

// Объект обновления — ресурс Tauri с идентификатором; в реактивное состояние его не кладём.
let pending: Update | null = null;

export const useUpdatesStore = defineStore('updates', {
  state: () => ({
    prefs: loadPrefs(),
    /** null — ещё не выяснили, настроен ли канал в этой сборке. */
    configured: null as boolean | null,
    endpoint: null as string | null,
    checking: false,
    /** Итог последней проверки для строки статуса. */
    status: '' as string,
    error: '' as string,
    available: null as AvailableUpdate | null,
    phase: 'idle' as Phase,
    downloaded: 0,
    total: 0,
  }),

  getters: {
    /** Плашка «Доступна новая версия» в шапке. */
    showBanner: (s) => !!s.available && s.available.version !== s.prefs.dismissedVersion,
    progressPercent: (s) => (s.total > 0 ? Math.min(100, Math.round((s.downloaded / s.total) * 100)) : null),
    busy: (s) => s.phase !== 'idle',
    /** Строка хода установки для плашки и настроек. */
    progressText(): string {
      if (this.phase === 'installing') return 'Установка обновления…';
      if (this.phase === 'restarting') return 'Перезапуск…';
      if (this.phase !== 'downloading') return '';
      const mb = (n: number) => (n / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
      return this.total > 0
        ? `Загрузка ${this.progressPercent}% · ${mb(this.downloaded)} из ${mb(this.total)} МБ`
        : `Загрузка… ${mb(this.downloaded)} МБ`;
    },
  },

  actions: {
    savePrefs() {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* private mode */ }
    },

    setAutoCheck(on: boolean) {
      this.prefs.autoCheck = on;
      this.savePrefs();
    },

    async init() {
      if (this.configured !== null) return;
      try {
        const info = await tauriApi.updateChannelInfo();
        this.configured = info.configured;
        this.endpoint = info.endpoint;
      } catch {
        this.configured = false;
      }
    },

    /** Тихая проверка при запуске: без сообщений об ошибках, не чаще раза в 6 часов. */
    async autoCheck() {
      await this.init();
      if (!this.configured || !isAutoCheckDue(this.prefs, Date.now())) return;
      await this.check(true);
    },

    async check(silent = false) {
      await this.init();
      if (!this.configured || this.checking || this.busy) return;
      this.checking = true;
      this.error = '';
      if (!silent) this.status = '';
      try {
        const upd = await check({ timeout: 30_000 });
        if (pending && pending !== upd) pending.close().catch(() => {});
        pending = upd;
        this.prefs.lastCheckAt = new Date().toISOString();
        this.prefs.knownUpdate = upd?.version ?? null;
        this.savePrefs();
        if (upd) {
          this.available = {
            version: upd.version,
            currentVersion: upd.currentVersion,
            date: releaseDate(upd.date),
            notes: (upd.body ?? '').trim(),
          };
          this.status = `Доступна версия ${upd.version}.`;
        } else {
          this.available = null;
          this.status = 'Установлена последняя версия.';
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!silent) this.error = `Не удалось проверить обновления: ${msg}`;
      } finally {
        this.checking = false;
      }
    },

    /** «Позже»: не показывать плашку для этой версии (в настройках обновление остаётся доступным). */
    dismiss() {
      if (!this.available) return;
      this.prefs.dismissedVersion = this.available.version;
      this.savePrefs();
    },

    /**
     * Скачивает и ставит обновление. На Windows установщик сам закрывает и снова открывает
     * приложение; на macOS после установки перезапускаем вручную.
     */
    async install() {
      if (!pending || this.busy) return;
      this.error = '';
      this.downloaded = 0;
      this.total = 0;
      this.phase = 'downloading';
      try {
        await pending.downloadAndInstall((ev) => {
          if (ev.event === 'Started') this.total = ev.data.contentLength ?? 0;
          else if (ev.event === 'Progress') this.downloaded += ev.data.chunkLength;
          else if (ev.event === 'Finished') this.phase = 'installing';
        });
        this.phase = 'restarting';
        await relaunch();
      } catch (e) {
        this.phase = 'idle';
        this.error = `Не удалось установить обновление: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
});
