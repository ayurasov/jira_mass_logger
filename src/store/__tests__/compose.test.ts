// «Заполнить одним нажатием» и «Отменить заполнение» — на настоящем сторе против поддельной Jira.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createFakeBackend, seedHistory, type FakeBackend } from '../../test/fakeBackend';

const h = vi.hoisted(() => ({ backend: null as null | { invoke: (cmd: string, args?: any) => Promise<unknown> } }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: any) => h.backend!.invoke(cmd, args),
}));

import { useComposeStore } from '../compose';
import { useFavoriteTasksStore } from '../favoriteTasks';
import { startMinutesOf } from '../../utils/dayComposer';

/** Рабочие дни 12.10–06.11.2026 (4 ноября — праздник). */
const HISTORY_DAYS = (() => {
  const out: string[] = [];
  for (let d = new Date(Date.UTC(2026, 9, 12)); d <= new Date(Date.UTC(2026, 10, 6)); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && iso !== '2026-11-04') out.push(iso);
  }
  return out;
})();
const MON = '2026-11-09';
const TUE = '2026-11-10';
const SAT = '2026-11-14';

let backend: FakeBackend;

function setup(seed = seedHistory(HISTORY_DAYS), opts: { failIssues?: string[] } = {}) {
  backend = createFakeBackend(seed, opts);
  backend.syncCache();
  h.backend = backend;
  return useComposeStore();
}

/** Записи дня в Jira не пересекаются, а созданные приложением не залезают на обед 13:00–14:00. */
function expectCleanDay(date: string) {
  const created = new Set(useComposeStore().lastBatchCreated.map((c) => c.worklogId));
  const items = backend.jiraOn(date).map((w) => ({ id: w.id, s: startMinutesOf(w.started), e: startMinutesOf(w.started) + w.timeSpentSeconds / 60 }));
  for (let i = 1; i < items.length; i++) expect(items[i].s, `пересечение в ${date}`).toBeGreaterThanOrEqual(items[i - 1].e);
  expect(items.filter((x) => created.has(x.id)).every((x) => x.e <= 13 * 60 || x.s >= 14 * 60), `запись на обеде в ${date}`).toBe(true);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('jiratime-work-schedule', JSON.stringify({ workdayHours: 8, workdays: [1, 2, 3, 4, 5], timezone: 'Europe/Moscow' }));
  setActivePinia(createPinia());
});

describe('autoPlan', () => {
  it('пустой рабочий день собирается ровно до нормы', async () => {
    const store = setup();
    const plan = await store.autoPlan(MON, false);
    expect(plan.problem).toBeNull();
    expect(plan.rows.reduce((s, r) => s + r.minutes, 0)).toBe(480);
  });

  it('выходной, праздник и заполненный день не трогаются', async () => {
    const store = setup([...seedHistory(HISTORY_DAYS), { id: 'x', issueKey: 'A-1', started: `${MON}T09:00:00.000+0300`, timeSpentSeconds: 8 * 3600 }]);
    expect((await store.autoPlan(SAT, false)).problem).toBe('нерабочий день');
    expect((await store.autoPlan('2026-11-04', false)).problem).toBe('нерабочий день');
    expect((await store.autoPlan(MON, false)).problem).toBe('уже заполнен');
  });

  it('без истории с избранной задачей — день не отправляется автоматически', async () => {
    const store = setup([]);
    useFavoriteTasksStore().items = [{ issueKey: 'FAV-1', issueSummary: 'Избранное' } as never];
    const plan = await store.autoPlan(MON, false);
    expect(plan.problem).toBe('нет истории привычных задач — откройте день и выберите задачи');
  });
});

describe('fillDays — одним нажатием', () => {
  it('заполняет пустой и частично заполненный дни ровно до нормы, выходной пропускает', async () => {
    const seed = [...seedHistory(HISTORY_DAYS), { id: 'p1', issueKey: 'SRM-101', started: `${TUE}T09:00:00.000+0300`, timeSpentSeconds: 3 * 3600, comment: 'утро' }];
    const store = setup(seed);
    const results = await store.fillDays([SAT, TUE, MON]);

    expect(results.map((r) => [r.date, r.ok, r.minutes])).toEqual([[MON, true, 480], [TUE, true, 300], [SAT, false, 0]]);
    expect(results[2].message).toBe('нерабочий день');
    expect(backend.minutesOn(MON)).toBe(480);
    expect(backend.minutesOn(TUE)).toBe(480);
    expect(backend.minutesOn(SAT)).toBe(0);
    expectCleanDay(MON);
    expectCleanDay(TUE);
    // Уже залогированная утренняя запись осталась на месте.
    expect(backend.jiraOn(TUE)[0]).toMatchObject({ id: 'p1', timeSpentSeconds: 3 * 3600 });
    expect(store.lastBatchCreated.length).toBe(results[0].entries + results[1].entries);
  });

  it('повторное нажатие не создаёт дублей', async () => {
    const store = setup();
    await store.fillDays([MON, TUE]);
    const count = backend.state.jira.length;
    const again = await store.fillDays([MON, TUE]);
    expect(again.every((r) => !r.ok && r.message === 'уже заполнен')).toBe(true);
    expect(backend.state.jira.length).toBe(count);
  });

  it('учитывает записи, сделанные в Jira мимо приложения (свежие данные перед заполнением)', async () => {
    const store = setup();
    // Запись появилась в Jira, но локальный кэш о ней ещё не знает.
    backend.state.jira.push({ id: 'web', issueKey: 'OPS-12', started: `${MON}T10:00:00.000+0300`, timeSpentSeconds: 6 * 3600 });
    const [res] = await store.fillDays([MON]);
    expect(res).toMatchObject({ ok: true, minutes: 120 });
    expect(backend.minutesOn(MON)).toBe(480);
    expectCleanDay(MON);
  });

  it('ошибка Jira по одной задаче — день помечен, созданное можно отменить', async () => {
    const store = setup(seedHistory(HISTORY_DAYS), { failIssues: ['OPS-12'] });
    const [res] = await store.fillDays([MON]);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('ошибка Jira: Issue does not exist');
    expect(res.minutes).toBe(backend.minutesOn(MON));
    const undo = await store.undoLastBatch();
    expect(undo.failed).toBe(0);
    expect(backend.minutesOn(MON)).toBe(0);
  });
});

describe('undoLastBatch — отменить заполнение', () => {
  it('удаляет всё созданное пакетом из Jira и из кэша, чужое не трогает', async () => {
    const seed = [...seedHistory(HISTORY_DAYS), { id: 'p1', issueKey: 'SRM-101', started: `${TUE}T09:00:00.000+0300`, timeSpentSeconds: 3 * 3600 }];
    const store = setup(seed);
    const before = backend.state.jira.map((w) => w.id).sort();
    await store.fillDays([MON, TUE]);
    const created = store.lastBatchCreated.length;
    expect(created).toBeGreaterThan(0);

    const res = await store.undoLastBatch();
    expect(res).toEqual({ removed: created, failed: 0 });
    expect(backend.state.jira.map((w) => w.id).sort()).toEqual(before);
    expect(backend.state.cache.some((r) => r.started.startsWith(MON))).toBe(false);
    expect(store.lastBatchCreated).toEqual([]);
  });

  it('запись, которую не удалось удалить, остаётся для повторной отмены', async () => {
    const store = setup();
    await store.fillDays([MON]);
    const victim = store.lastBatchCreated[0];
    // Запись удалили в Jira вручную до отмены — Jira ответит «не найдено».
    backend.state.jira = backend.state.jira.filter((w) => w.id !== victim.worklogId);
    const res = await store.undoLastBatch();
    expect(res.failed).toBe(1);
    expect(store.lastBatchCreated).toEqual([victim]);
    expect(backend.minutesOn(MON)).toBe(0);
  });
});
