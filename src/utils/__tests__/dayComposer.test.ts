import { describe, expect, it } from 'vitest';
import {
  buildPlan, composeDay, findHabits, findOverlaps, firstFreeStart, hhmmToMinutes, minutesToHHMM, placeNewRow, unfilledDays,
  type ComposeOptions, type HabitTask, type HistoryWorklog,
} from '../dayComposer';

const H = (h: number, m = 0) => h * 60 + m;
const wl = (issueKey: string, date: string, hhmm: string, hours: number, comment = ''): HistoryWorklog => ({
  issueKey, started: `${date}T${hhmm}:00.000+0300`, timeSpentSeconds: Math.round(hours * 3600), comment,
});
const opts = (date: string, targetHours = 8, extra: Partial<ComposeOptions> = {}): ComposeOptions => ({
  date, targetHours, stepMinutes: 15, dayStart: H(9), dayEnd: H(18), lunch: [H(13), H(14)], ...extra,
});
const habit = (issueKey: string, typicalMinutes: number, typicalStart: number, frequency = 0.8): HabitTask => ({
  issueKey, issueSummary: issueKey, frequency, sameWeekdayFrequency: frequency, typicalMinutes, typicalStart,
  typicalComment: `работа по ${issueKey}`, daysSeen: 10, score: frequency,
});
const sum = (items: { minutes: number }[]) => items.reduce((s, p) => s + p.minutes, 0);

describe('время', () => {
  it('переводит ЧЧ:ММ туда и обратно', () => {
    expect(hhmmToMinutes('09:30')).toBe(570);
    expect(minutesToHHMM(570)).toBe('09:30');
    expect(minutesToHHMM(H(23, 45))).toBe('23:45');
  });
});

describe('firstFreeStart', () => {
  it('оставляет желаемое время, если оно свободно', () => {
    expect(firstFreeStart([], H(9), 60)).toBe(H(9));
    expect(firstFreeStart([{ start: H(12), end: H(13) }], H(9), 120)).toBe(H(9));
  });
  it('сдвигает начало за занятый интервал', () => {
    expect(firstFreeStart([{ start: H(9), end: H(11) }], H(9), 60)).toBe(H(11));
    expect(firstFreeStart([{ start: H(10), end: H(11) }], H(9), 120)).toBe(H(11));
  });
  it('находит окно между занятыми интервалами', () => {
    const busy = [{ start: H(9), end: H(10) }, { start: H(12), end: H(13) }];
    expect(firstFreeStart(busy, H(9), 120)).toBe(H(10));
    expect(firstFreeStart(busy, H(9), 180)).toBe(H(13));
  });
  it('не уходит за полночь', () => {
    expect(firstFreeStart([{ start: H(9), end: H(23) }], H(9), 120)).toBe(H(22));
  });
});

describe('placeNewRow: новая строка встаёт в рабочий день', () => {
  const o = opts('2026-11-09');
  const lunch = { start: H(13), end: H(14) };
  const at = (start: number, minutes: number) => ({ start, minutes });
  it('в желаемое время, если оно свободно', () => {
    expect(placeNewRow([lunch], H(11), 60, o)).toEqual(at(H(11), 60));
  });
  it('занято — в ближайшее свободное окно после', () => {
    expect(placeNewRow([lunch, { start: H(10), end: H(12) }], H(11), 60, o)).toEqual(at(H(12), 60));
    expect(placeNewRow([lunch, { start: H(10), end: H(12, 30) }], H(11), 60, o)).toEqual(at(H(14), 60));
  });
  it('после желаемого места нет — в ближайшее окно раньше', () => {
    expect(placeNewRow([lunch, { start: H(14), end: H(18) }], H(16), 60, o)).toEqual(at(H(12), 60));
  });
  it('не выходит за конец рабочего дня', () => {
    expect(placeNewRow([lunch], H(17, 30), 120, o)).toEqual(at(H(16), 120));
  });
  it('целиком нигде не помещается — в самое длинное окно, укороченной', () => {
    const busy = [lunch, { start: H(9), end: H(11) }, { start: H(11, 30), end: H(13) }, { start: H(14), end: H(17) }];
    expect(placeNewRow(busy, H(10), 165, o)).toEqual(at(H(17), 60));
  });
  it('день занят целиком — сразу после занятого', () => {
    expect(placeNewRow([{ start: H(9), end: H(18) }], H(11), 60, o)).toEqual(at(H(18), 60));
  });
});

describe('findOverlaps', () => {
  const existing = [wl('A-1', '2026-11-09', '09:00', 2)];
  it('находит пересечение с уже залогированным', () => {
    expect([...findOverlaps([{ id: 'p1', start: H(10), minutes: 60 }], existing)]).toEqual(['p1']);
  });
  it('стык встык — не пересечение', () => {
    expect(findOverlaps([{ id: 'p1', start: H(11), minutes: 60 }, { id: 'p2', start: H(12), minutes: 30 }], existing).size).toBe(0);
  });
  it('находит пересечение предложенных строк между собой', () => {
    expect(findOverlaps([{ id: 'p1', start: H(12), minutes: 60 }, { id: 'p2', start: H(12, 30), minutes: 60 }], []).size).toBe(2);
  });
});

describe('findHabits', () => {
  const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
  const history = days.flatMap((d, i) => [
    wl('SRM-101', d, '09:00', 4, 'Разработка'),
    ...(i % 2 === 0 ? [wl('DOC-7', d, '15:00', 1, 'Документация')] : []),
  ]);
  const habits = findHabits(history, days, '2026-11-02');

  it('частая задача идёт первой, с типичными длительностью, началом и описанием', () => {
    expect(habits[0]).toMatchObject({ issueKey: 'SRM-101', frequency: 1, typicalMinutes: 240, typicalStart: H(9), typicalComment: 'Разработка' });
  });
  it('редкая задача ниже и с меньшей частотой', () => {
    expect(habits[1]).toMatchObject({ issueKey: 'DOC-7', typicalMinutes: 60, typicalStart: H(15) });
    expect(habits[1].frequency).toBeCloseTo(0.6);
  });
  it('записи вне рабочих дней окна не учитываются', () => {
    expect(findHabits([wl('X-1', '2026-11-01', '10:00', 3)], days, '2026-11-02')).toEqual([]);
  });
});

describe('composeDay: сумма дня всегда равна цели', () => {
  const habits = [habit('SRM-101', 240, H(9)), habit('OPS-12', 120, H(14)), habit('DOC-7', 120, H(16), 0.5)];

  it('пустой день собирается ровно до нормы, без пересечений и без обеда', () => {
    const plan = composeDay([], [], habits, opts('2026-11-09'));
    expect(sum(plan)).toBe(480);
    expect(findOverlaps(plan, []).size).toBe(0);
    expect(plan.every((p) => p.start + p.minutes <= H(13) || p.start >= H(14))).toBe(true);
  });

  it('частично заполненный день добивается до нормы вокруг уже залогированного', () => {
    const existing = [wl('SRM-101', '2026-11-10', '09:00', 3)];
    const plan = composeDay(existing, [], habits, opts('2026-11-10'));
    expect(sum(plan)).toBe(300);
    expect(findOverlaps(plan, existing).size).toBe(0);
    // Задача уже залогирована сегодня — повторно не предлагается.
    expect(plan.some((p) => p.issueKey === 'SRM-101')).toBe(false);
  });

  it('заполненный день — нечего предлагать', () => {
    expect(composeDay([wl('A-1', '2026-11-10', '09:00', 8)], [], habits, opts('2026-11-10'))).toEqual([]);
  });

  it('встреча ставится в своё время, пересекающаяся с залогированным — пропускается', () => {
    const existing = [wl('SRM-101', '2026-11-11', '10:00', 1)];
    const meetings = [
      { id: 'm1', issueKey: 'OPS-12', subject: 'Планёрка', start: H(9), minutes: 30 },
      { id: 'm2', issueKey: 'OPS-12', subject: 'Синк', start: H(10, 30), minutes: 30 },
    ];
    const plan = composeDay(existing, meetings, habits, opts('2026-11-11'));
    expect(plan.find((p) => p.meetingId === 'm1')).toMatchObject({ start: H(9), minutes: 30, source: 'meeting' });
    expect(plan.some((p) => p.meetingId === 'm2')).toBe(false);
    expect(sum(plan)).toBe(420);
  });

  it('случайные дни: сумма = цели и записи не пересекаются', () => {
    // Детерминированный генератор — тест воспроизводим.
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 300; n++) {
      const date = '2026-11-12';
      const existing: HistoryWorklog[] = [];
      let cursor = H(9) + Math.floor(rnd() * 8) * 15;
      const count = Math.floor(rnd() * 4);
      for (let i = 0; i < count; i++) {
        const minutes = (1 + Math.floor(rnd() * 8)) * 15;
        if (cursor + minutes > H(18)) break;
        existing.push(wl(`E-${i}`, date, minutesToHHMM(cursor), minutes / 60));
        cursor += minutes + Math.floor(rnd() * 6) * 15;
      }
      const target = [4, 6, 7.5, 8][Math.floor(rnd() * 4)];
      const hs = [habit('SRM-101', (1 + Math.floor(rnd() * 16)) * 15, H(9) + Math.floor(rnd() * 32) * 15),
        habit('OPS-12', (1 + Math.floor(rnd() * 12)) * 15, H(9) + Math.floor(rnd() * 32) * 15, 0.5 + rnd() / 2)];
      const plan = composeDay(existing, [], hs, opts(date, target));
      const filled = sum(existing.map((w) => ({ minutes: w.timeSpentSeconds / 60 })));
      const expected = Math.max(0, Math.round((target * 60 - filled) / 15) * 15);
      expect(sum(plan), `случай ${n}`).toBe(expected);
      expect(findOverlaps(plan, existing).size, `случай ${n}`).toBe(0);
      expect(plan.every((p) => p.start >= 0 && p.start + p.minutes <= 24 * 60), `случай ${n}`).toBe(true);
    }
  });
});

describe('buildPlan: правки пользователя', () => {
  const habits = [habit('SRM-101', 240, H(9)), habit('OPS-12', 120, H(14))];
  const base = { meetings: [], habits, dismissedKeys: new Set<string>(), dismissedMeetings: new Set<string>() };

  it('правка сохраняется, остальное подстраивается под цель', () => {
    const user = [{ id: 'u1', issueKey: 'DOC-7', issueSummary: null, start: H(9), minutes: 180, comment: 'Док', source: 'manual' as const, reason: '', include: true }];
    const plan = buildPlan({ ...base, existing: [], opts: opts('2026-11-09'), userItems: user, pinnedId: 'u1' });
    expect(plan.find((p) => p.id === 'u1')).toMatchObject({ minutes: 180, start: H(9) });
    expect(sum(plan)).toBe(480);
    expect(findOverlaps(plan, []).size).toBe(0);
  });

  it('правки больше цели — урезаются поздние, последняя правка остаётся', () => {
    const user = [
      { id: 'u1', issueKey: 'A-1', issueSummary: null, start: H(9), minutes: 300, comment: '', source: 'manual' as const, reason: '', include: true },
      { id: 'u2', issueKey: 'B-1', issueSummary: null, start: H(14), minutes: 300, comment: '', source: 'manual' as const, reason: '', include: true },
    ];
    const plan = buildPlan({ ...base, existing: [], opts: opts('2026-11-09'), userItems: user, pinnedId: 'u1' });
    expect(plan.find((p) => p.id === 'u1')?.minutes).toBe(300);
    expect(plan.find((p) => p.id === 'u2')?.minutes).toBe(180);
    expect(sum(plan)).toBe(480);
  });

  it('утверждённая строка не урезается — урезается обычная правка', () => {
    const user = [
      { id: 'u1', issueKey: 'A-1', issueSummary: null, start: H(9), minutes: 300, comment: '', source: 'manual' as const, reason: '', include: true, approved: true },
      { id: 'u2', issueKey: 'B-1', issueSummary: null, start: H(14), minutes: 300, comment: '', source: 'manual' as const, reason: '', include: true },
    ];
    const plan = buildPlan({ ...base, existing: [], opts: opts('2026-11-09'), userItems: user, pinnedId: 'u2' });
    expect(plan.find((p) => p.id === 'u1')?.minutes).toBe(300);
    expect(plan.find((p) => p.id === 'u2')?.minutes).toBe(180);
    expect(sum(plan)).toBe(480);
  });

  it('утверждённые строки больше цели — перебор остаётся, автоматических строк нет', () => {
    const user = [
      { id: 'u1', issueKey: 'A-1', issueSummary: null, start: H(9), minutes: 300, comment: '', source: 'manual' as const, reason: '', include: true, approved: true },
      { id: 'u2', issueKey: 'B-1', issueSummary: null, start: H(14), minutes: 300, comment: '', source: 'manual' as const, reason: '', include: true, approved: true },
    ];
    const plan = buildPlan({ ...base, existing: [], opts: opts('2026-11-09'), userItems: user, pinnedId: 'u2' });
    expect(plan.map((p) => [p.id, p.minutes])).toEqual([['u1', 300], ['u2', 300]]);
  });

  it('убранная задача больше не предлагается', () => {
    const plan = buildPlan({ ...base, existing: [], opts: opts('2026-11-09'), userItems: [], dismissedKeys: new Set(['OPS-12']) });
    expect(plan.some((p) => p.issueKey === 'OPS-12')).toBe(false);
    expect(sum(plan)).toBe(480);
  });
});

describe('unfilledDays', () => {
  it('возвращает рабочие дни до сегодня, где меньше нормы (с допуском 5 мин)', () => {
    const rows = [wl('A-1', '2026-11-09', '09:00', 8), wl('A-1', '2026-11-10', '09:00', 7.95), wl('A-1', '2026-11-11', '09:00', 2)];
    const res = unfilledDays(rows, ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'], '2026-11-12', 480);
    expect(res).toEqual([{ date: '2026-11-11', minutes: 120 }, { date: '2026-11-12', minutes: 0 }]);
  });
});
