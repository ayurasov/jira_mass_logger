// Руководство пользователя в приложении. Текст — docs/user-guide.md (как «Что нового»
// в todo-planner читает docs/versions.md): здесь он разбирается на главы, ищется
// и превращается в HTML для экрана «Руководство». Модуль чистый — легко тестировать.
import { Marked, type Tokens } from 'marked';

export interface GuideChapter {
  id: string;
  num: number;
  title: string;
  /** Подпись к главе, например горячая клавиша (HTML из комментария `<!-- meta: … -->`). */
  meta: string;
  /** Markdown главы без заголовка. */
  body: string;
  /** Якоря подразделов (`### Заголовок {#id}`) — на них ведут ссылки вида `#habits`. */
  anchors: string[];
  /** Текст главы без разметки — для поиска. */
  text: string;
  /** Число рисунков — для сквозной нумерации «Рис. N». */
  figures: number;
}

const CHAPTER_RE = /^##\s+(.+?)\s*\{#([\w-]+)\}\s*$/;
const ANCHOR_RE = /\s*\{#([\w-]+)\}\s*$/;
const META_RE = /^<!--\s*meta:\s*(.*?)\s*-->$/;
const IMAGE_RE = /!\[[^\]]*\]\(\s*\S+\s+"((?:\\"|[^"])*)"\s*\)/g;

/** Экран приложения → глава руководства (для «Руководства» из меню и кнопки «Открыть экран»). */
export const ROUTE_CHAPTERS: Record<string, string> = {
  dashboard: 'dash', worklog: 'worklog', bulk: 'bulk', calendar: 'calendar', 'calendar-preview': 'calendar',
  compose: 'compose', team: 'team', digest: 'digest', bitrix: 'bitrix', templates: 'templates',
  profiles: 'profiles', logs: 'logs', settings: 'settings',
};

/** Экран, который описывает глава (если есть). */
export function chapterRoute(chapterId: string): string | null {
  const found = Object.entries(ROUTE_CHAPTERS).find(([route, ch]) => ch === chapterId && route !== 'calendar-preview');
  return found ? found[0] : null;
}

/** Текст без markdown-разметки: для поиска и фрагментов в результатах. */
export function plainText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(IMAGE_RE, (_, cap: string) => ` ${cap.replace(/\\"/g, '"').replace(' | ', ' ')} `)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(ANCHOR_RE, '')
    .replace(/\{#[\w-]+\}/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*]|\d+\.)\s+/gm, '')
    .replace(/\[!warn\]\s*/g, '')
    .replace(/^\|?\s*-{3,}.*$/gm, ' ')
    .replace(/[*`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Разбор руководства на главы: каждая начинается с `## Заголовок {#id}`. */
export function parseGuide(md: string): GuideChapter[] {
  const chapters: GuideChapter[] = [];
  let cur: { id: string; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const lines = [...cur.lines];
    while (lines.length && !lines[0].trim()) lines.shift();
    let meta = '';
    const m = lines[0]?.trim().match(META_RE);
    if (m) { meta = m[1]; lines.shift(); }
    const body = lines.join('\n').trim();
    const anchors = [...body.matchAll(/^#{3,6}\s+.*\{#([\w-]+)\}\s*$/gm)].map((a) => a[1]);
    chapters.push({
      id: cur.id, num: chapters.length + 1, title: cur.title, meta, body, anchors,
      text: plainText(body), figures: [...body.matchAll(IMAGE_RE)].length,
    });
  };
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(CHAPTER_RE);
    if (h) {
      flush();
      cur = { id: h[2], title: h[1], lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  flush();
  return chapters;
}

/** Глава по id главы или якоря подраздела. */
export function findChapter(chapters: GuideChapter[], id: string | null | undefined): GuideChapter | null {
  if (!id) return null;
  return chapters.find((c) => c.id === id) ?? chapters.find((c) => c.anchors.includes(id)) ?? null;
}

/** Номер первого рисунка главы (сквозная нумерация по всему руководству). */
export function figureStart(chapters: GuideChapter[], chapterId: string): number {
  let n = 1;
  for (const c of chapters) {
    if (c.id === chapterId) return n;
    n += c.figures;
  }
  return n;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

export interface GuideSearchHit {
  chapter: GuideChapter;
  count: number;
  /** Фрагмент текста вокруг первого совпадения. */
  snippet: string;
}

/** Поиск по руководству: главы с совпадениями (без учёта регистра и «ё»), самые частые выше. */
export function searchGuide(chapters: GuideChapter[], query: string): GuideSearchHit[] {
  const q = norm(query.trim());
  if (q.length < 2) return [];
  const hits: GuideSearchHit[] = [];
  for (const chapter of chapters) {
    const hay = norm(`${chapter.title} ${chapter.text}`);
    let count = 0;
    for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) count++;
    if (!count) continue;
    const at = norm(chapter.text).indexOf(q);
    const from = Math.max(0, at - 50);
    const snippet = at === -1
      ? chapter.text.slice(0, 120)
      : `${from ? '…' : ''}${chapter.text.slice(from, at + q.length + 70).trim()}…`;
    hits.push({ chapter, count, snippet });
  }
  return hits.sort((a, b) => b.count - a.count || a.chapter.num - b.chapter.num);
}

export interface RenderOptions {
  /** Номер первого рисунка главы. */
  figureStart: number;
  /** Адрес картинки по пути из markdown (`images/xx.webp`). */
  imageUrl: (href: string) => string;
  /** macOS: в подписях клавиш ⌘ вместо Ctrl. */
  mac?: boolean;
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** HTML главы: рисунки с подписями «Рис. N», врезки, якоря подразделов, ссылки между главами. */
export function renderChapter(chapter: GuideChapter, opts: RenderOptions): string {
  let figure = opts.figureStart;
  const md = new Marked();
  const inline = (s: string) => md.parseInline(s) as string;
  md.use({
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        const id = text.match(ANCHOR_RE)?.[1];
        const html = this.parser.parseInline(tokens).replace(/\s*\{#[\w-]+\}\s*$/, '');
        return `<h${depth}${id ? ` id="${id}"` : ''}>${html}</h${depth}>\n`;
      },
      paragraph({ tokens }: Tokens.Paragraph) {
        // Рисунок — отдельный блок, а не абзац с картинкой.
        const only = tokens.filter((t) => !(t.type === 'text' && !t.raw.trim()));
        if (only.length === 1 && only[0].type === 'image') return this.parser.parseInline(only);
        return `<p>${this.parser.parseInline(tokens)}</p>\n`;
      },
      image({ href, title }: Tokens.Image) {
        const [head, ...rest] = (title ?? '').split(' | ');
        const n = figure++;
        const caption = `<b>Рис. ${n}. ${inline(head)}</b>${rest.length ? ` ${inline(rest.join(' | '))}` : ''}`;
        return `<figure class="ug-figure"><img src="${escapeAttr(opts.imageUrl(href))}" alt="${escapeAttr(`Рис. ${n}. ${head}`)}" loading="lazy" data-figure="${n}" /><figcaption>${caption}</figcaption></figure>\n`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        let html = this.parser.parse(tokens);
        const warn = /^<p>\[!warn\]\s*/.test(html);
        if (warn) html = html.replace(/^<p>\[!warn\]\s*/, '<p>');
        return `<div class="ug-note${warn ? ' ug-note--warn' : ''}">${html}</div>\n`;
      },
      link({ href, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        if (href.startsWith('#')) return `<a href="${escapeAttr(href)}" data-guide-link="${escapeAttr(href.slice(1))}">${text}</a>`;
        return `<a href="${escapeAttr(href)}" data-external="1">${text}</a>`;
      },
      table(token: Tokens.Table) {
        const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
        const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
        return `<div class="ug-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  let html = md.parse(chapter.body) as string;
  if (opts.mac) html = html.replace(/<kbd>Ctrl<\/kbd>/g, '<kbd>⌘</kbd>');
  return html;
}

/** Подпись главы (горячая клавиша) с учётом платформы. */
export function chapterMeta(chapter: GuideChapter, mac = false): string {
  return mac ? chapter.meta.replace(/<kbd>Ctrl<\/kbd>/g, '<kbd>⌘</kbd>') : chapter.meta;
}
