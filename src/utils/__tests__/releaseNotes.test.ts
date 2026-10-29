// История версий («Что нового»): docs/versions.md разбирается и не отстаёт от версии приложения.
import { describe, expect, it } from 'vitest';
import versionsMd from '../../../docs/versions.md?raw';
import pkg from '../../../package.json';
import { parseVersions } from '../releaseNotes';

const releases = parseVersions(versionsMd);
const num = (v: string) => v.split('.').map(Number).reduce((s, n) => s * 1000 + n, 0);

describe('docs/versions.md', () => {
  it('первая запись — текущая версия приложения', () => {
    expect(releases[0].version).toBe(pkg.version);
  });

  it('только несколько последних версий, от новой к старой', () => {
    expect(releases.length).toBeGreaterThanOrEqual(3);
    expect(releases.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < releases.length; i++) expect(num(releases[i - 1].version)).toBeGreaterThan(num(releases[i].version));
  });

  it('у каждой версии — дата, описание и разделы со списком изменений', () => {
    for (const r of releases) {
      expect(r.date, r.version).toMatch(/\d{4} г\.$/);
      expect(r.title.length, r.version).toBeGreaterThan(20);
      expect(r.sections.length, r.version).toBeGreaterThan(0);
      expect(r.sections.every((s) => s.items.length > 0), r.version).toBe(true);
    }
  });
});

describe('parseVersions', () => {
  it('разбирает заголовок, вводный абзац, разделы и пункты', () => {
    const [r] = parseVersions('# История\n\nвступление\n\n## Версия 2.0.0 (Май 2027 г.)\n\nКоротко.\n\n### Новое\n\nАбзац.\n\n- пункт 1;\n- пункт 2.\n');
    expect(r).toEqual({
      version: '2.0.0', date: 'Май 2027 г.', title: 'Коротко.',
      sections: [{ title: 'Новое', paragraphs: ['Абзац.'], items: ['пункт 1;', 'пункт 2.'] }],
    });
  });
});
