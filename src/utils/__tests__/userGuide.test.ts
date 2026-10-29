// Руководство в приложении: разбор docs/user-guide.md, ссылки, рисунки и поиск.
import { describe, expect, it } from 'vitest';
import md from '../../../docs/user-guide.md?raw';
import {
  chapterRoute, figureStart, findChapter, parseGuide, plainText, renderChapter, ROUTE_CHAPTERS, searchGuide,
} from '../userGuide';

// Картинки, которые попадут в сборку (как на экране «Руководство»).
const bundled = new Set(Object.keys(import.meta.glob('../../../docs/images/*.webp')).map((k) => k.replace('../../../docs/', '')));
const chapters = parseGuide(md);
const render = (id: string, mac = false) => renderChapter(findChapter(chapters, id)!, {
  figureStart: figureStart(chapters, id), imageUrl: (h) => `/img/${h.split('/').pop()}`, mac,
});

describe('docs/user-guide.md', () => {
  it('разбирается на главы с уникальными id и сквозной нумерацией', () => {
    expect(chapters.length).toBeGreaterThanOrEqual(20);
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
    expect(chapters.map((c) => c.num)).toEqual(chapters.map((_, i) => i + 1));
    expect(chapters.every((c) => c.title && c.body)).toBe(true);
  });

  it('все внутренние ссылки ведут на существующие главы или подразделы', () => {
    const targets = [...md.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(findChapter(chapters, t), `#${t}`).not.toBeNull();
  });

  it('все рисунки есть в docs/images', () => {
    const images = [...md.matchAll(/!\[[^\]]*\]\((images\/[^\s)]+)/g)].map((m) => m[1]);
    expect(images.length).toBe(chapters.reduce((s, c) => s + c.figures, 0));
    for (const img of images) expect(bundled.has(img), img).toBe(true);
  });

  it('у каждого экрана из меню есть глава', () => {
    for (const [route, ch] of Object.entries(ROUTE_CHAPTERS)) expect(findChapter(chapters, ch), route).not.toBeNull();
    expect(chapterRoute('compose')).toBe('compose');
    expect(chapterRoute('faq')).toBeNull();
  });

  it('описывает новые возможности «Собрать день» и встроенное руководство', () => {
    const compose = findChapter(chapters, 'compose')!;
    expect(compose.anchors).toContain('habits');
    expect(compose.text).toContain('Утвердить все');
    expect(compose.text).toContain('в предложении');
    expect(findChapter(chapters, 'guide')?.id).toBe('ui');
  });
});

describe('renderChapter', () => {
  it('рисунки — с подписью «Рис. N» и сквозной нумерацией', () => {
    const html = render('compose');
    const first = figureStart(chapters, 'compose');
    expect(first).toBeGreaterThan(1);
    expect(html).toContain(`<b>Рис. ${first}. Экран «Собрать день».</b>`);
    expect(html).toMatch(/<figure class="ug-figure"><img src="\/img\/06a-compose\.webp"/);
    expect(html).not.toMatch(/<p>\s*<figure/);
  });

  it('якоря подразделов, ссылки между главами и врезки', () => {
    const html = render('compose');
    expect(html).toContain('<h3 id="habits">Привычные задачи</h3>');
    expect(html).not.toContain('{#');
    expect(render('start')).toContain('data-guide-link="transfer"');
    expect(html).toContain('<div class="ug-note">');
  });

  it('на macOS клавиша Ctrl показывается как ⌘', () => {
    expect(render('keys')).toContain('<kbd>Ctrl</kbd>');
    expect(render('keys', true)).not.toContain('<kbd>Ctrl</kbd>');
    expect(render('keys', true)).toContain('<kbd>⌘</kbd>');
  });
});

describe('searchGuide', () => {
  it('находит главы без учёта регистра и «ё», частые совпадения выше', () => {
    const hits = searchGuide(chapters, 'УТВЕРЖД');
    expect(hits[0].chapter.id).toBe('compose');
    expect(hits[0].count).toBeGreaterThan(3);
    expect(hits[0].snippet.toLowerCase()).toContain('утвержд');
    expect(searchGuide(chapters, 'темная тема').some((h) => h.chapter.id === 'theme')).toBe(true);
  });
  it('слишком короткий запрос ничего не ищет', () => {
    expect(searchGuide(chapters, 'а')).toEqual([]);
  });
  it('текст для поиска без разметки', () => {
    expect(plainText('**Жирный** [ссылка](#x) <kbd>Ctrl</kbd> `код` {#id}')).toBe('Жирный ссылка Ctrl код');
  });
});
