import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  channel: { configured: true, endpoint: 'https://example.com/latest.json' },
  update: null as null | Record<string, any>,
  checkError: null as Error | null,
  relaunch: vi.fn(async () => {}),
}));

vi.mock('../../lib/tauriApi', () => ({ tauriApi: { updateChannelInfo: async () => h.channel } }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: h.relaunch }));
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => {
    if (h.checkError) throw h.checkError;
    return h.update;
  }),
}));

import { check } from '@tauri-apps/plugin-updater';
import { AUTO_CHECK_INTERVAL_MS, isAutoCheckDue, releaseDate, useUpdatesStore } from '../updates';

function fakeUpdate(version: string, failInstall = false) {
  return {
    version, currentVersion: '1.0.12', date: '2026-11-02 10:00:00.0 +00:00:00', body: '- новое\n- исправлено',
    close: vi.fn(async () => {}),
    downloadAndInstall: vi.fn(async (onEvent: (e: any) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 2_000_000 } });
      onEvent({ event: 'Progress', data: { chunkLength: 500_000 } });
      if (failInstall) throw new Error('signature verification failed');
      onEvent({ event: 'Progress', data: { chunkLength: 1_500_000 } });
      onEvent({ event: 'Finished' });
    }),
  };
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h.channel = { configured: true, endpoint: 'https://example.com/latest.json' };
  h.update = null;
  h.checkError = null;
  h.relaunch.mockClear();
  vi.mocked(check).mockClear();
});

describe('вспомогательные функции', () => {
  it('releaseDate понимает оба формата даты Tauri', () => {
    expect(releaseDate('2026-11-02T10:00:00Z')).toBe('2026-11-02');
    expect(releaseDate('2026-11-02 10:00:00.0 +00:00:00')).toBe('2026-11-02');
    expect(releaseDate(undefined)).toBeNull();
    expect(releaseDate('нет даты')).toBeNull();
  });

  it('isAutoCheckDue: выключено, впервые, рано, пора, есть найденное обновление', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const base = { autoCheck: true, lastCheckAt: null, dismissedVersion: null, knownUpdate: null };
    expect(isAutoCheckDue({ ...base, autoCheck: false }, now)).toBe(false);
    expect(isAutoCheckDue(base, now)).toBe(true);
    expect(isAutoCheckDue({ ...base, lastCheckAt: new Date(now - 60_000).toISOString() }, now)).toBe(false);
    expect(isAutoCheckDue({ ...base, lastCheckAt: new Date(now - AUTO_CHECK_INTERVAL_MS).toISOString() }, now)).toBe(true);
    expect(isAutoCheckDue({ ...base, lastCheckAt: new Date(now - 60_000).toISOString(), knownUpdate: '1.0.13' }, now)).toBe(true);
  });
});

describe('стор обновлений', () => {
  it('канал не настроен — проверка не выполняется', async () => {
    h.channel = { configured: false, endpoint: null as unknown as string };
    const s = useUpdatesStore();
    await s.check();
    expect(s.configured).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it('находит обновление, показывает плашку и запоминает версию', async () => {
    h.update = fakeUpdate('1.0.13');
    const s = useUpdatesStore();
    await s.check();
    expect(s.available).toEqual({ version: '1.0.13', currentVersion: '1.0.12', date: '2026-11-02', notes: '- новое\n- исправлено' });
    expect(s.showBanner).toBe(true);
    expect(s.prefs.knownUpdate).toBe('1.0.13');
    expect(JSON.parse(localStorage.getItem('jiratime-updates')!).knownUpdate).toBe('1.0.13');
  });

  it('«Позже» прячет плашку только для этой версии', async () => {
    h.update = fakeUpdate('1.0.13');
    const s = useUpdatesStore();
    await s.check();
    s.dismiss();
    expect(s.showBanner).toBe(false);
    h.update = fakeUpdate('1.0.14');
    await s.check();
    expect(s.showBanner).toBe(true);
  });

  it('последняя версия — плашки нет, найденная ранее версия забывается', async () => {
    localStorage.setItem('jiratime-updates', JSON.stringify({ knownUpdate: '1.0.13' }));
    setActivePinia(createPinia());
    const s = useUpdatesStore();
    await s.check();
    expect(s.available).toBeNull();
    expect(s.status).toBe('Установлена последняя версия.');
    expect(s.prefs.knownUpdate).toBeNull();
  });

  it('тихая автопроверка не показывает ошибку сети, ручная — показывает', async () => {
    h.checkError = new Error('network down');
    const s = useUpdatesStore();
    await s.autoCheck();
    expect(s.error).toBe('');
    await s.check();
    expect(s.error).toContain('network down');
  });

  it('автопроверка уважает интервал', async () => {
    localStorage.setItem('jiratime-updates', JSON.stringify({ lastCheckAt: new Date().toISOString() }));
    setActivePinia(createPinia());
    await useUpdatesStore().autoCheck();
    expect(check).not.toHaveBeenCalled();
  });

  it('установка: прогресс, затем перезапуск', async () => {
    h.update = fakeUpdate('1.0.13');
    const s = useUpdatesStore();
    await s.check();
    await s.install();
    expect(s.downloaded).toBe(2_000_000);
    expect(s.total).toBe(2_000_000);
    expect(s.phase).toBe('restarting');
    expect(h.relaunch).toHaveBeenCalledOnce();
  });

  it('ошибка установки (например, подпись не сошлась) — без перезапуска и с понятным текстом', async () => {
    h.update = fakeUpdate('1.0.13', true);
    const s = useUpdatesStore();
    await s.check();
    await s.install();
    expect(s.phase).toBe('idle');
    expect(s.error).toBe('Не удалось установить обновление: signature verification failed');
    expect(h.relaunch).not.toHaveBeenCalled();
    expect(s.showBanner).toBe(true);
  });

  it('строка прогресса', async () => {
    const s = useUpdatesStore();
    s.phase = 'downloading';
    s.total = 10 * 1048576;
    s.downloaded = 5 * 1048576;
    expect(s.progressText).toBe('Загрузка 50% · 5 из 10 МБ');
    s.phase = 'installing';
    expect(s.progressText).toBe('Установка обновления…');
  });
});
