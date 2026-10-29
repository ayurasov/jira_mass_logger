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
import { findOverlaps, startMinutesOf } from '../../utils/dayComposer';

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

describe('«Собрать день»: утверждённые строки', () => {
  const view = (rows: { issueKey: string; start: number; minutes: number; comment: string }[]) =>
    rows.map((r) => `${r.issueKey} ${r.start}+${r.minutes} ${r.comment}`).sort();
  const approvedRows = () => view(useComposeStore().proposal.filter((p) => p.approved));
  const total = () => useComposeStore().proposal.reduce((s, p) => s + p.minutes, 0);

  async function openMonday() {
    const store = setup();
    await store.load(MON);
    expect(total()).toBe(480);
    return store;
  }

  it('отметка не перестраивает день: строки остаются как были', async () => {
    const store = await openMonday();
    const before = view(store.proposal);
    store.setApproved(store.proposal[0].id, true);
    expect(view(store.proposal)).toEqual(before);
    expect(store.proposal.filter((p) => p.approved)).toHaveLength(1);
    expect(store.approvedMinutes).toBe(store.proposal.find((p) => p.approved)!.minutes);
  });

  it('удаление строки добирает часы только за счёт неутверждённых', async () => {
    const store = await openMonday();
    const [a, b] = [...store.proposal].sort((x, y) => x.start - y.start);
    store.setApproved(a.id, true);
    store.setApproved(b.id, true);
    const approved = approvedRows();
    const victim = store.proposal.find((p) => !p.approved)!;

    store.removeItem(victim.id);

    expect(approvedRows()).toEqual(approved);
    expect(total()).toBe(480);
    expect(findOverlaps(store.proposal, store.existing).size).toBe(0);
    expect(store.proposal.filter((p) => !p.approved).some((p) => p.issueKey === victim.issueKey)).toBe(false);
  });

  it('правка другой строки не урезает утверждённые', async () => {
    const store = await openMonday();
    const [a, b] = [...store.proposal].sort((x, y) => x.start - y.start);
    store.setApproved(a.id, true);
    const approved = approvedRows();

    store.editItem(b.id, { minutes: 7 * 60 });

    expect(approvedRows()).toEqual(approved);
    expect(total()).toBe(480);
  });

  it('утверждённое больше цели — остаётся перебор, строки не урезаются', async () => {
    const store = await openMonday();
    store.setAllApproved(true);
    const first = [...store.proposal].sort((x, y) => x.start - y.start)[0];
    const others = view(store.proposal.filter((p) => p.id !== first.id));

    store.editItem(first.id, { minutes: first.minutes + 120 });

    expect(total()).toBe(600);
    expect(view(store.proposal.filter((p) => p.id !== first.id))).toEqual(others);
    expect(store.proposal.every((p) => p.approved)).toBe(true);
  });

  it('«Пересобрать» забывает правки, но оставляет утверждённые строки', async () => {
    const store = await openMonday();
    const [a, b] = [...store.proposal].sort((x, y) => x.start - y.start);
    store.setApproved(a.id, true);
    const approved = approvedRows();
    store.editItem(b.id, { comment: 'временная правка' });

    store.reset();

    expect(approvedRows()).toEqual(approved);
    expect(store.proposal.some((p) => p.comment === 'временная правка')).toBe(false);
    expect(total()).toBe(480);
  });

  it('снятая отметка оставляет строку правкой, и её снова можно урезать', async () => {
    const store = await openMonday();
    const first = [...store.proposal].sort((x, y) => x.start - y.start)[0];
    store.setApproved(first.id, true);
    const id = store.proposal.find((p) => p.approved)!.id;
    store.setApproved(id, false);
    const row = store.proposal.find((p) => p.id === id)!;
    expect(row).toMatchObject({ approved: false, locked: true, minutes: first.minutes, start: first.start });
  });
});

describe('«Собрать день»: строки из привычных задач', () => {
  async function openMonday(extra: { id: string; issueKey: string; issueSummary?: string; started: string; timeSpentSeconds: number; comment?: string }[] = []) {
    const store = setup([...seedHistory(HISTORY_DAYS), ...extra]);
    await store.load(MON);
    return store;
  }
  const total = () => useComposeStore().proposal.reduce((s, p) => s + p.minutes, 0);
  // Задача, которую логируют в 11:00 по часу в каждый третий день.
  const qa = HISTORY_DAYS.filter((_, i) => i % 3 === 0)
    .map((d, i) => ({ id: `qa${i}`, issueKey: 'QA-5', issueSummary: 'Тестирование', started: `${d}T11:00:00.000+0300`, timeSpentSeconds: 3600, comment: 'Тесты' }));

  it('встаёт в привычное время внутри рабочего дня, а не после конца дня', async () => {
    const store = await openMonday(qa);
    store.addRow(store.habits.find((h) => h.issueKey === 'QA-5'));
    const row = store.proposal.find((p) => p.issueKey === 'QA-5')!;
    expect(row).toMatchObject({ start: 11 * 60, minutes: 60, locked: true });
    expect(total()).toBe(480);
    expect(findOverlaps(store.proposal, store.existing).size).toBe(0);
    expect(store.proposal.every((p) => p.start + p.minutes <= 18 * 60)).toBe(true);
  });

  it('плотный день: строка укорачивается до свободного окна, а не уезжает за конец дня', async () => {
    const logged = (id: string, from: string, hours: number) => ({ id, issueKey: 'OPS-12', started: `${MON}T${from}:00.000+0300`, timeSpentSeconds: hours * 3600 });
    const store = await openMonday([logged('l1', '09:00', 2), logged('l2', '11:30', 1.5), logged('l3', '14:00', 3)]);
    store.addRow(store.habits.find((h) => h.issueKey === 'DOC-7'));
    const row = store.proposal.find((p) => p.issueKey === 'DOC-7' && p.locked)!;
    expect(row).toMatchObject({ start: 17 * 60, minutes: 60 });
    expect(store.filledMinutes + total()).toBe(480);
    expect(findOverlaps(store.proposal, store.existing).size).toBe(0);
    expect(store.proposal.every((p) => p.start + p.minutes <= 18 * 60)).toBe(true);
  });

  it('несколько добавленных подряд не наезжают друг на друга и остаются в рабочем дне', async () => {
    const store = await openMonday(qa);
    for (const key of ['QA-5', 'DOC-7', 'SRM-204']) store.addRow(store.habits.find((h) => h.issueKey === key));
    store.addRow();
    expect(findOverlaps(store.proposal, store.existing).size).toBe(0);
    expect(store.proposal.every((p) => p.start >= 9 * 60 && p.start + p.minutes <= 18 * 60)).toBe(true);
    expect(store.proposal.every((p) => p.start + p.minutes <= 13 * 60 || p.start >= 14 * 60)).toBe(true);
    expect(total()).toBe(480);
  });
});

describe('«Собрать день»: какие привычные задачи предлагать', () => {
  const keysOf = (rows: { issueKey: string }[]) => new Set(rows.map((r) => r.issueKey));

  it('снятая задача не предлагается ни на экране, ни «одним нажатием», но добавляется вручную', async () => {
    const store = setup();
    await store.load(MON);
    expect(keysOf(store.proposal).has('DOC-7')).toBe(true);

    store.setHabitProposed('DOC-7', false);
    expect(keysOf(store.proposal).has('DOC-7')).toBe(false);
    expect(store.proposal.reduce((s, p) => s + p.minutes, 0)).toBe(480);
    expect(keysOf((await store.autoPlan(TUE, false)).rows).has('DOC-7')).toBe(false);

    store.addRow(store.habits.find((h) => h.issueKey === 'DOC-7'));
    expect(keysOf(store.proposal).has('DOC-7')).toBe(true);
  });

  it('выбор запоминается между запусками', async () => {
    const store = setup();
    await store.load(MON);
    store.setHabitProposed('SRM-204', false);

    setActivePinia(createPinia());
    const again = setup();
    await again.load(TUE);
    expect(again.isHabitProposed('SRM-204')).toBe(false);
    expect(keysOf(again.proposal).has('SRM-204')).toBe(false);
  });

  it('«новые не предлагать»: текущие остаются, новая задача из истории не появляется', async () => {
    const store = setup();
    await store.load(MON);
    const before = keysOf(store.proposal);
    store.setProposeNewHabits(false);
    expect(keysOf(store.proposal)).toEqual(before);

    // В истории появилась новая регулярная задача — сама в предложение не попадает.
    for (const d of HISTORY_DAYS) backend.state.jira.push({ id: `new-${d}`, issueKey: 'NEW-1', started: `${d}T08:00:00.000+0300`, timeSpentSeconds: 3600 });
    backend.syncCache();
    await store.load(TUE);
    expect(store.habits.some((h) => h.issueKey === 'NEW-1')).toBe(true);
    expect(keysOf(store.proposal).has('NEW-1')).toBe(false);
    store.setHabitProposed('NEW-1', true);
    expect(keysOf(store.proposal).has('NEW-1')).toBe(true);
  });
});
