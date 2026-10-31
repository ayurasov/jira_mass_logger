// Обращения к Jira: одинаковые одновременные запросы объединяются в один.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createFakeBackend, type FakeBackend } from '../../test/fakeBackend';

const h = vi.hoisted(() => ({ backend: null as null | { invoke: (cmd: string, args?: any) => Promise<unknown> } }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: any) => h.backend!.invoke(cmd, args),
}));

import { useDayFromCalendarStore } from '../dayFromCalendar';
import { useAnalyticsStore } from '../analytics';

let backend: FakeBackend;
const jiraCalls = () => backend.state.calls.filter((c) => c.cmd === 'get_worklogs_since');

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  backend = createFakeBackend([
    { id: '1', issueKey: 'SRM-1', started: '2026-11-09T09:00:00.000+0300', timeSpentSeconds: 3600 },
  ]);
  h.backend = backend;
});

describe('объединение одинаковых запросов к Jira', () => {
  it('одновременные обновления одного дня — один запрос, кэш обновлён', async () => {
    const cal = useDayFromCalendarStore();
    await Promise.all([
      cal.refreshRangeFromJira('2026-11-09', '2026-11-09'),
      cal.refreshRangeFromJira('2026-11-09', '2026-11-09'),
      cal.refreshRangeFromJira('2026-11-09', '2026-11-09'),
    ]);
    expect(jiraCalls()).toHaveLength(1);
    expect(backend.state.cache.map((r) => r.rowKey)).toEqual(['wl:1']);
  });

  it('разные диапазоны и последовательные обновления — отдельные запросы', async () => {
    const cal = useDayFromCalendarStore();
    await Promise.all([
      cal.refreshRangeFromJira('2026-11-09', '2026-11-09'),
      cal.refreshRangeFromJira('2026-11-10', '2026-11-10'),
    ]);
    await cal.refreshRangeFromJira('2026-11-09', '2026-11-09');
    expect(jiraCalls()).toHaveLength(3);
  });

  it('дашборд: «Обновить» во время идущей синхронизации не запускает вторую', async () => {
    const analytics = useAnalyticsStore();
    await Promise.all([analytics.syncFromJira(true), analytics.syncFromJira(true)]);
    expect(jiraCalls()).toHaveLength(1);
    await analytics.syncFromJira(true);
    expect(jiraCalls()).toHaveLength(2);
  });
});
