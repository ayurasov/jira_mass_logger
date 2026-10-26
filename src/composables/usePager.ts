// Пагинация списков внутри виджетов: страница + размер страницы.
// Размер запоминается отдельно для каждого виджета (localStorage), страница — нет.
import { computed, ref, watch, type Ref } from 'vue';

export const PAGE_SIZES = [5, 10, 20, 50] as const;
const STORAGE_PREFIX = 'jiratime-pager-';

function readSize(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_PREFIX + key));
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export interface Pager<T> {
  page: Ref<number>;
  size: Ref<number>;
  pages: Ref<number>;
  total: Ref<number>;
  items: Ref<T[]>;
  /** Номер первой и последней показанной записи (1-based) — для подписи «11–20 из 57». */
  from: Ref<number>;
  to: Ref<number>;
  setSize: (n: number) => void;
  go: (p: number) => void;
}

export function usePager<T>(list: Ref<T[]>, key: string, defaultSize = 10): Pager<T> {
  const size = ref(readSize(key, defaultSize));
  const page = ref(1);
  const total = computed(() => list.value.length);
  const pages = computed(() => Math.max(1, Math.ceil(total.value / size.value)));
  const items = computed(() => list.value.slice((page.value - 1) * size.value, page.value * size.value));
  const from = computed(() => (total.value ? (page.value - 1) * size.value + 1 : 0));
  const to = computed(() => Math.min(total.value, page.value * size.value));

  // Новые данные или другой фильтр — на первую страницу; иначе не выходим за последнюю.
  watch(list, () => { page.value = 1; });
  watch(pages, (n) => { if (page.value > n) page.value = n; });

  function setSize(n: number) {
    // Сохраняем позицию: первая видимая запись остаётся на экране.
    const first = (page.value - 1) * size.value;
    size.value = n;
    page.value = Math.floor(first / n) + 1;
    try { localStorage.setItem(STORAGE_PREFIX + key, String(n)); } catch { /* private mode */ }
  }
  const go = (p: number) => { page.value = Math.min(Math.max(1, p), pages.value); };

  return { page, size, pages, total, items, from, to, setSize, go };
}
