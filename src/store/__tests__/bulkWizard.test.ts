// Мастер массового логирования: предпросмотр «не превышать норму дня» и отправка без дублей.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createFakeBackend, type FakeBackend } from '../../test/fakeBackend';

const h = vi.hoisted(() => ({ backend: null as null | { invoke: (cmd: string, args?: any) => Promise<unknown> } }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: any) => h.backend!.invoke(cmd, args),
}));

import { useBulkWizardStore } from '../bulkWizard';

const params = { baseUrl: 'https://jira.example.com' } as never;
let backend: FakeBackend;

function wizard(seed: Parameters<typeof createFakeBackend>[0] = []) {
  backend = createFakeBackend(seed);
  backend.syncCache();
  h.backend = backend;
  const w = useBulkWizardStore();
  w.issueKey = 'SRM-101';
  w.periodFrom = '2026-11-02'; // пн
  w.periodTo = '2026-11-08'; // вс; 4 ноября — праздник
  w.hoursPerDay = 8;
  w.startTime = '09:00';
  return w;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('jiratime-work-schedule', JSON.stringify({ workdayHours: 8, workdays: [1, 2, 3, 4, 5], timezone: 'Europe/Moscow' }));
  setActivePinia(createPinia());
});

describe('generatePreview', () => {
  it('без выходных и праздников, время начала — как в параметрах', async () => {
    const w = wizard();
    await w.generatePreview(params);
    expect(w.previewRows.map((r) => r.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06']);
    expect(w.previewRows.every((r) => r.hours === 8 && r.startedAt.startsWith(`${r.date}T09:00:00.000+0300`))).toBe(true);
    expect(w.totalHours).toBe(32);
  });

  it('«не превышать норму»: заполненный день пропускается, частичный — урезается и сдвигается', async () => {
    const w = wizard([
      { id: '1', issueKey: 'OPS-12', started: '2026-11-02T09:00:00.000+0300', timeSpentSeconds: 8 * 3600 },
      { id: '2', issueKey: 'OPS-12', started: '2026-11-03T09:00:00.000+0300', timeSpentSeconds: 6 * 3600 },
    ]);
    await w.generatePreview(params);
    const [mon, tue, thu] = w.previewRows;
    expect(mon).toMatchObject({ skipped: true, note: 'день уже заполнен (8 ч)' });
    expect(tue).toMatchObject({ skipped: false, hours: 2 });
    expect(tue.startedAt.startsWith('2026-11-03T15:00')).toBe(true);
    expect(tue.note).toBe('до нормы: уже 6 ч; начало 15:00 — после уже залогированного');
    expect(thu).toMatchObject({ hours: 8, skipped: false });
    expect(w.totalHours).toBe(18);
  });

  it('выключенная галочка — норма дня не учитывается', async () => {
    const w = wizard([{ id: '1', issueKey: 'OPS-12', started: '2026-11-02T09:00:00.000+0300', timeSpentSeconds: 8 * 3600 }]);
    w.fillToNorm = false;
    await w.generatePreview(params);
    expect(w.previewRows.every((r) => !r.skipped && r.hours === 8)).toBe(true);
  });

  it('свой worklog по этой задаче в тот же день — конфликт', async () => {
    const w = wizard([{ id: '1', issueKey: 'SRM-101', started: '2026-11-05T09:00:00.000+0300', timeSpentSeconds: 3600 }]);
    await w.generatePreview(params);
    expect(w.previewRows.find((r) => r.date === '2026-11-05')?.conflict).toBe(true);
    expect(w.conflictsCount).toBe(1);
  });
});

describe('правка и отправка', () => {
  it('время начала строки — из поля ЧЧ:ММ, дата остаётся датой строки', async () => {
    const w = wizard();
    await w.generatePreview(params);
    const row = w.previewRows[0];
    w.setPreviewRowStartedAtLocal(row.id, `${row.date}T11:30`);
    expect(w.previewRows[0].startedAt).toBe('2026-11-02T11:30:00.000+0300');
  });

  it('отправляет только не убранные строки, повтор не создаёт дублей', async () => {
    const w = wizard();
    await w.generatePreview(params);
    w.removePreviewRow(w.previewRows[1].id);
    await w.submit(params);
    expect(backend.state.jira.length).toBe(3);
    expect(w.previewRows.filter((r) => r.status === 'success').length).toBe(3);
    // Созданное сразу попадает в локальный кэш (дашборд и «Собрать день» видят его без синхронизации).
    expect(backend.state.cache.length).toBe(3);
    await w.submit(params);
    expect(backend.state.jira.length).toBe(3);
  });
});
