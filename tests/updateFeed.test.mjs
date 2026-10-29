// latest.json для автообновления: правильные платформы и адреса из подписей релиза.
import { describe, expect, it } from 'vitest';
import { buildFeed } from '../.github/scripts/update-feed.mjs';

const base = 'https://github.com/owner/releases-repo/releases/download/release/v1.0.13';
const sig = (name) => ({ name: `${name}.sig`, signature: `SIG(${name})\n` });

describe('buildFeed', () => {
  it('раскладывает установщики по платформам, NSIS — основной для Windows', () => {
    const feed = buildFeed({
      version: 'v1.0.13', baseUrl: `${base}/`, notes: ' - исправления \n', pubDate: '2026-11-02T10:00:00.000Z',
      files: [
        sig('JiraTime_1.0.13_x64_ru-RU.msi'), sig('JiraTime_1.0.13_x64-setup.exe'),
        sig('JiraTime_1.0.13_arm64-setup.exe'), sig('JiraTime_aarch64.app.tar.gz'), sig('JiraTime_x64.app.tar.gz'),
        { name: 'checksums.txt', signature: '' },
      ],
    });
    expect(feed.version).toBe('1.0.13');
    expect(feed.notes).toBe('- исправления');
    expect(feed.pub_date).toBe('2026-11-02T10:00:00.000Z');
    expect(feed.platforms['windows-x86_64'].url).toBe(`${base}/JiraTime_1.0.13_x64-setup.exe`);
    expect(feed.platforms['windows-x86_64-msi'].url).toBe(`${base}/JiraTime_1.0.13_x64_ru-RU.msi`);
    expect(feed.platforms['windows-aarch64'].signature).toBe('SIG(JiraTime_1.0.13_arm64-setup.exe)');
    expect(feed.platforms['darwin-aarch64'].url).toBe(`${base}/JiraTime_aarch64.app.tar.gz`);
    expect(feed.platforms['darwin-x86_64'].url).toBe(`${base}/JiraTime_x64.app.tar.gz`);
    expect(feed.platforms['windows-aarch64-msi']).toBeUndefined();
  });

  it('если есть только MSI — он и основной вариант', () => {
    const feed = buildFeed({ version: '1.0.13', baseUrl: base, files: [sig('JiraTime_1.0.13_x64_ru-RU.msi')] });
    expect(feed.platforms['windows-x86_64'].url).toBe(`${base}/JiraTime_1.0.13_x64_ru-RU.msi`);
  });

  it('без подписей и с неверной версией — понятная ошибка', () => {
    expect(() => buildFeed({ version: '1.0.13', baseUrl: base, files: [] })).toThrow(/подписи/);
    expect(() => buildFeed({ version: 'latest', baseUrl: base, files: [sig('a_x64-setup.exe')] })).toThrow(/версия/);
  });
});
