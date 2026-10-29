// История версий для окна «Что нового»: docs/versions.md разбирается так же,
// как в todo-planner — «## Версия X (дата)», вводный абзац, «### Раздел» со списком.

export interface ReleaseSection {
  title: string;
  paragraphs: string[];
  items: string[];
}

export interface Release {
  version: string;
  /** Дата из заголовка, например «Октябрь 2026 г.». */
  date: string;
  /** Короткое описание версии — первый абзац под заголовком. */
  title: string;
  sections: ReleaseSection[];
}

export function parseVersions(markdown: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let section: ReleaseSection | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^##\s+Версия\s+(\S+)(?:\s+\((.+)\))?\s*$/);
    if (head) {
      release = { version: head[1], date: head[2] ?? '', title: '', sections: [] };
      releases.push(release);
      section = null;
      continue;
    }
    if (!release || !line || line.startsWith('# ') || line.startsWith('---')) continue;
    const sub = line.match(/^###\s+(.+)$/);
    if (sub) {
      section = { title: sub[1], paragraphs: [], items: [] };
      release.sections.push(section);
    } else if (!section) {
      release.title = release.title ? `${release.title} ${line}` : line;
    } else if (line.startsWith('- ')) {
      section.items.push(line.slice(2));
    } else {
      section.paragraphs.push(line);
    }
  }
  return releases;
}
