<script setup lang="ts">
// «Руководство»: руководство пользователя прямо в приложении. Текст — docs/user-guide.md,
// картинки — docs/images (встраиваются в сборку, работают без сети). Слева — содержание
// и поиск, справа — глава с рисунками; ссылки ведут к другим главам и экранам.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import guideMarkdown from '../../docs/user-guide.md?raw';
import ActionIcon from '../components/ActionIcon.vue';
import { isMac } from '../utils/platform';
import {
  chapterMeta, chapterRoute, figureStart, findChapter, parseGuide, renderChapter, searchGuide,
} from '../utils/userGuide';

const IMAGES = import.meta.glob('../../docs/images/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const imageUrl = (href: string) => IMAGES[`../../docs/images/${href.split('/').pop()}`] ?? href;

const chapters = parseGuide(guideMarkdown);
const route = useRoute();
const router = useRouter();

const version = ref('');
onMounted(async () => {
  try { version.value = await getVersion(); } catch { /* вне Tauri */ }
});

const current = computed(() => findChapter(chapters, route.query.ch as string | undefined) ?? chapters[0]);
const index = computed(() => chapters.indexOf(current.value));
const prev = computed(() => chapters[index.value - 1] ?? null);
const next = computed(() => chapters[index.value + 1] ?? null);
const screen = computed(() => chapterRoute(current.value.id));
const html = computed(() => renderChapter(current.value, {
  figureStart: figureStart(chapters, current.value.id), imageUrl, mac: isMac,
}));

const query = ref('');
const hits = computed(() => searchGuide(chapters, query.value));
const searching = computed(() => query.value.trim().length >= 2);

function open(id: string) {
  router.replace({ name: 'guide', query: { ch: id } });
}

// ── Прокрутка к подразделу и подсветка найденного ───────────────────
const article = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);

function highlight() {
  const root = article.value;
  if (!root) return;
  root.querySelectorAll('mark.ug-hit').forEach((m) => m.replaceWith(document.createTextNode(m.textContent ?? '')));
  root.normalize();
  const q = query.value.trim().toLowerCase().replace(/ё/g, 'е');
  if (q.length < 2) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.data;
    const hay = text.toLowerCase().replace(/ё/g, 'е');
    let at = hay.indexOf(q);
    if (at === -1) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    while (at !== -1) {
      frag.append(text.slice(pos, at));
      const mark = document.createElement('mark');
      mark.className = 'ug-hit';
      mark.textContent = text.slice(at, at + q.length);
      frag.append(mark);
      pos = at + q.length;
      at = hay.indexOf(q, pos);
    }
    frag.append(text.slice(pos));
    node.replaceWith(frag);
  }
}

async function afterRender() {
  await nextTick();
  highlight();
  document.querySelector('.ug-toc__item.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const anchor = route.query.ch as string | undefined;
  const target = anchor && anchor !== current.value.id ? article.value?.querySelector(`#${CSS.escape(anchor)}`) : null;
  const firstHit = query.value.trim().length >= 2 ? article.value?.querySelector('mark.ug-hit') : null;
  if (target) target.scrollIntoView({ block: 'start' });
  else if (firstHit) firstHit.scrollIntoView({ block: 'center' });
  else scroller.value?.scrollTo({ top: 0 });
}
watch(() => [route.query.ch, html.value], afterRender);
watch(query, () => nextTick(highlight));
onMounted(afterRender);

// ── Ссылки и рисунки внутри главы ───────────────────────────────────
const zoom = ref<{ src: string; alt: string } | null>(null);
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && zoom.value) zoom.value = null; };
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

function onArticleClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  const link = el.closest('a') as HTMLAnchorElement | null;
  if (link) {
    e.preventDefault();
    if (link.dataset.guideLink) open(link.dataset.guideLink);
    else if (link.dataset.external) openUrl(link.href).catch(() => {});
    return;
  }
  if (el instanceof HTMLImageElement) zoom.value = { src: el.src, alt: el.alt };
}
</script>

<template>
  <div class="ug">
    <div class="ug-grid">
    <aside class="ug-side">
      <div class="ug-side__head">
        <h1>Руководство</h1>
        <span class="ug-muted">JiraTime{{ version ? ` ${version}` : '' }}</span>
      </div>
      <label class="ug-search">
        <ActionIcon name="search" :size="15" />
        <input v-model="query" type="search" placeholder="Поиск по руководству" aria-label="Поиск по руководству" />
      </label>

      <nav v-if="!searching" class="ug-toc" aria-label="Содержание">
        <button
          v-for="c in chapters" :key="c.id" class="ug-toc__item" :class="{ 'is-active': c.id === current.id }"
          @click="open(c.id)"
        >
          <span class="ug-toc__num">{{ c.num }}</span>
          <span class="ug-toc__title">{{ c.title }}</span>
        </button>
      </nav>
      <div v-else class="ug-results">
        <div class="ug-muted ug-small">{{ hits.length ? `Найдено в ${hits.length} ${hits.length === 1 ? 'главе' : 'главах'}` : 'Ничего не найдено' }}</div>
        <button
          v-for="h in hits" :key="h.chapter.id" class="ug-result" :class="{ 'is-active': h.chapter.id === current.id }"
          @click="open(h.chapter.id)"
        >
          <span class="ug-result__top"><b>{{ h.chapter.num }}. {{ h.chapter.title }}</b><span class="ug-count">{{ h.count }}</span></span>
          <span class="ug-result__snippet">{{ h.snippet }}</span>
        </button>
      </div>
    </aside>

    <section ref="scroller" class="ug-main">
      <article class="ug-article">
        <header class="ug-head">
          <div class="ug-head__eyebrow">
            Глава {{ current.num }}
            <span v-if="current.meta" class="ug-head__meta" v-html="chapterMeta(current, isMac)"></span>
          </div>
          <div class="ug-head__row">
            <h2>{{ current.title }}</h2>
            <router-link v-if="screen" :to="{ name: screen }" class="ug-btn">
              Открыть экран <ActionIcon name="arrow-right" :size="14" />
            </router-link>
          </div>
        </header>

        <!-- Содержимое — из собственного docs/user-guide.md, встроенного в сборку. -->
        <div ref="article" class="ug-body" @click="onArticleClick" v-html="html"></div>

        <footer class="ug-pager">
          <button v-if="prev" class="ug-pager__btn" @click="open(prev.id)">
            <ActionIcon name="chevron-left" :size="15" />
            <span><small>Назад</small>{{ prev.num }}. {{ prev.title }}</span>
          </button>
          <span v-else></span>
          <button v-if="next" class="ug-pager__btn ug-pager__btn--next" @click="open(next.id)">
            <span><small>Дальше</small>{{ next.num }}. {{ next.title }}</span>
            <ActionIcon name="chevron-right" :size="15" />
          </button>
        </footer>
      </article>
    </section>
    </div>

    <div v-if="zoom" class="ug-zoom" role="dialog" aria-modal="true" :aria-label="zoom.alt" @click="zoom = null">
      <img :src="zoom.src" :alt="zoom.alt" />
      <span class="ug-zoom__hint">{{ zoom.alt }} · щелчок — закрыть</span>
    </div>
  </div>
</template>

<style scoped>
.ug { height: 100%; min-height: 0; container-type: inline-size; }
.ug-grid { display: grid; grid-template-columns: 17.5rem minmax(0, 1fr); height: 100%; min-height: 0; }
.ug-muted { color: var(--muted); }
.ug-small { font-size: 0.75rem; }

.ug-side { display: flex; flex-direction: column; gap: 0.75rem; min-height: 0; padding: 1.5rem 0.75rem 1rem 1.25rem; border-right: 1px solid var(--border); background: var(--card); }
.ug-side__head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; padding-right: 0.5rem; }
.ug-side__head h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.01em; }
.ug-side__head span { font-size: 0.75rem; white-space: nowrap; }
.ug-search { position: relative; display: block; margin-right: 0.5rem; }
.ug-search .action-svg-icon { position: absolute; left: 0.65rem; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.ug-search input { width: 100%; box-sizing: border-box; padding: 0.5rem 0.6rem 0.5rem 2rem; font-size: 0.875rem; background: var(--surface-sunken); }

.ug-toc, .ug-results { display: flex; flex-direction: column; gap: 1px; overflow-y: auto; min-height: 0; padding-right: 0.5rem; }
.ug-toc__item { display: flex; gap: 0.5rem; align-items: baseline; text-align: left; border: none; background: transparent; color: var(--fg); padding: 0.4rem 0.5rem; border-radius: 0.4rem; font-size: 0.875rem; cursor: pointer; }
.ug-toc__item:hover { background: var(--chip); }
.ug-toc__item.is-active { background: var(--primary-soft); color: var(--primary-strong); font-weight: 600; }
.ug-toc__num { width: 1.5rem; flex: none; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 0.8125rem; }
.ug-toc__item.is-active .ug-toc__num { color: inherit; }

.ug-results { gap: 0.4rem; }
.ug-result { display: flex; flex-direction: column; gap: 0.2rem; text-align: left; border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 0.5rem; padding: 0.5rem 0.6rem; cursor: pointer; }
.ug-result:hover, .ug-result.is-active { border-color: var(--primary); }
.ug-result__top { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.8125rem; }
.ug-count { flex: none; min-width: 1.4rem; text-align: center; border-radius: 999px; background: var(--primary-soft); color: var(--primary-strong); font-size: 0.6875rem; font-weight: 700; padding: 0.05rem 0.35rem; }
.ug-result__snippet { font-size: 0.75rem; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

.ug-main { overflow-y: auto; min-height: 0; padding: 1.5rem 2rem 2rem; }
.ug-article { max-width: 56rem; margin: 0 auto; }
.ug-head { border-bottom: 1px solid var(--border); padding-bottom: 0.875rem; margin-bottom: 1rem; }
.ug-head__eyebrow { display: flex; align-items: center; gap: 0.6rem; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--primary-strong); }
.ug-head__meta { text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--muted); }
.ug-head__row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-top: 0.3rem; }
.ug-head h2 { margin: 0; font-size: 1.5rem; letter-spacing: -0.01em; }
.ug-btn { display: inline-flex; align-items: center; gap: 0.4rem; height: 2rem; padding: 0 0.85rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--card); color: var(--fg); font-size: 0.8125rem; font-weight: 600; text-decoration: none; }
.ug-btn:hover { background: var(--chip); }

.ug-body { font-size: 0.9375rem; line-height: 1.6; color: var(--fg); }
.ug-body :deep(p) { margin: 0 0 0.75rem; }
.ug-body :deep(h3) { font-size: 1.0625rem; margin: 1.5rem 0 0.5rem; scroll-margin-top: 1rem; }
.ug-body :deep(ul), .ug-body :deep(ol) { margin: 0 0 0.875rem; padding-left: 1.4rem; }
.ug-body :deep(li) { margin-bottom: 0.3rem; }
.ug-body :deep(a) { color: var(--primary); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--primary) 35%, transparent); cursor: pointer; }
.ug-body :deep(a:hover) { border-bottom-color: var(--primary); }
.ug-body :deep(code) { font-size: 0.85em; background: var(--surface-sunken); border: 1px solid var(--border); border-radius: 0.3rem; padding: 0 0.3rem; }
.ug-body :deep(kbd), .ug-head__meta :deep(kbd) { font-family: inherit; font-size: 0.8em; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 0.3rem; padding: 0 0.35rem; background: var(--card); color: var(--fg); }
.ug-body :deep(.ug-figure) { margin: 1rem 0 1.25rem; }
.ug-body :deep(.ug-figure img) { display: block; max-width: 100%; max-height: 32rem; margin: 0 auto; border: 1px solid var(--border); border-radius: 0.5rem; box-shadow: var(--shadow); cursor: zoom-in; background: var(--card); }
.ug-body :deep(figcaption) { margin-top: 0.5rem; font-size: 0.8125rem; color: var(--muted); line-height: 1.5; }
.ug-body :deep(figcaption b) { color: var(--fg); }
.ug-body :deep(.ug-note) { margin: 0.875rem 0; padding: 0.7rem 0.95rem; border-left: 3px solid var(--primary); border-radius: 0 0.5rem 0.5rem 0; background: var(--surface-sunken); font-size: 0.875rem; }
.ug-body :deep(.ug-note--warn) { border-left-color: var(--warning); background: color-mix(in srgb, var(--warning) 9%, transparent); }
.ug-body :deep(.ug-note p:last-child) { margin-bottom: 0; }
.ug-body :deep(.ug-table) { overflow-x: auto; margin: 0.5rem 0 1rem; }
.ug-body :deep(table) { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
.ug-body :deep(th), .ug-body :deep(td) { text-align: left; vertical-align: top; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--border); }
.ug-body :deep(th) { background: var(--surface-sunken); font-weight: 600; }
.ug-body :deep(mark.ug-hit) { background: color-mix(in srgb, var(--warning) 35%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }

.ug-pager { display: flex; justify-content: space-between; gap: 1rem; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.ug-pager__btn { display: inline-flex; align-items: center; gap: 0.5rem; max-width: 48%; border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 0.5rem; padding: 0.5rem 0.75rem; text-align: left; font-size: 0.875rem; font-weight: 600; cursor: pointer; }
.ug-pager__btn:hover { border-color: var(--primary); }
.ug-pager__btn small { display: block; font-size: 0.6875rem; font-weight: 500; color: var(--muted); }
.ug-pager__btn--next { text-align: right; margin-left: auto; }

.ug-zoom { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; padding: 2rem; background: rgba(10, 14, 24, 0.82); cursor: zoom-out; }
.ug-zoom img { max-width: 100%; max-height: calc(100% - 2.5rem); border-radius: 0.5rem; box-shadow: 0 1.5rem 4rem rgba(0, 0, 0, 0.45); background: #fff; }
.ug-zoom__hint { color: #e6e9f2; font-size: 0.8125rem; }

/* Узкая область: содержание сверху, глава под ним. */
@container (max-width: 44rem) {
  .ug-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .ug-side { border-right: none; border-bottom: 1px solid var(--border); padding: 1rem 1.25rem 0.75rem; }
  .ug-toc { flex-direction: row; flex-wrap: nowrap; overflow-x: auto; gap: 0.25rem; padding-bottom: 0.25rem; }
  .ug-toc__item { flex: none; white-space: nowrap; }
  .ug-results { max-height: 12rem; }
  .ug-main { padding: 1.25rem 1.25rem 2rem; }
}
</style>
