<script setup lang="ts">
// «Битрикс24» (необязательная интеграция): свои задачи и задачи, за которыми наблюдаете;
// поиск, карточка задачи, комментарии и результаты.
import { computed, onMounted, ref } from 'vue';
import { openUrl } from '@tauri-apps/plugin-opener';
import ActionIcon from '../components/ActionIcon.vue';
import { BITRIX_ROLES, BITRIX_STATUS, plainBitrixText, useBitrixStore } from '../store/bitrix';
import { tauriApi } from '../lib/tauriApi';
import { localIsoDate } from '../utils/time';
import { hotkeyLabel, isMac } from '../utils/platform';

const store = useBitrixStore();
const draft = ref('');
const asResult = ref(false);
const sendMessage = ref<{ ok: boolean; text: string } | null>(null);

onMounted(() => {
  if (store.connected && !store.tasks.length) store.loadTasks();
});

const statusOf = (s: string) => BITRIX_STATUS[s] ?? { label: s || '—', tone: 'off' as const };
const today = localIsoDate();
const isOverdue = (deadline?: string | null, status?: string) => !!deadline && deadline.slice(0, 10) < today && status !== '5' && status !== '7';
const fmtDate = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
const fmtDateTime = (iso?: string | null) => (iso ? `${fmtDate(iso)} ${iso.slice(11, 16)}` : '');

const task = computed(() => store.detail?.task ?? null);
const results = computed(() => (store.detail?.comments ?? []).filter((c) => c.isResult));

function openInBitrix(id: string) {
  const url = store.taskUrl(id);
  if (url) openUrl(url).catch(() => {});
}

async function send() {
  if (!draft.value.trim() || store.sending) return;
  const r = await store.addComment(draft.value, asResult.value);
  sendMessage.value = { ok: r.ok, text: r.message };
  if (r.ok) { draft.value = ''; asResult.value = false; }
}

/** Сводка своих списаний за сегодня — готовый текст для отчёта-результата. */
async function insertTodayWorklog() {
  const rows = await tauriApi.listCachedWorklogs(today, today).catch(() => []);
  if (!rows.length) {
    sendMessage.value = { ok: false, text: 'За сегодня в Jira ещё нет списаний.' };
    return;
  }
  const byIssue = new Map<string, { summary: string; minutes: number; comments: Set<string> }>();
  for (const r of rows) {
    const e = byIssue.get(r.issueKey) ?? { summary: r.issueSummary ?? '', minutes: 0, comments: new Set<string>() };
    e.minutes += Math.round(r.timeSpentSeconds / 60);
    if (r.comment?.trim()) e.comments.add(r.comment.trim());
    byIssue.set(r.issueKey, e);
  }
  const fmt = (m: number) => `${Math.floor(m / 60) ? `${Math.floor(m / 60)} ч` : ''}${m % 60 ? ` ${m % 60} мин` : ''}`.trim();
  const total = [...byIssue.values()].reduce((s, e) => s + e.minutes, 0);
  const lines = [...byIssue.entries()].map(([key, e]) => `— ${key}${e.summary ? ` «${e.summary}»` : ''}: ${fmt(e.minutes)}${e.comments.size ? ` (${[...e.comments].join('; ')})` : ''}`);
  const text = [`Сделано за ${fmtDate(today)} (${fmt(total)}):`, ...lines].join('\n');
  draft.value = draft.value.trim() ? `${draft.value.trim()}\n\n${text}` : text;
}
</script>

<template>
  <div class="bx">
    <header class="bx-header">
      <div>
        <h1>Битрикс24</h1>
        <p class="bx-sub">Ваши задачи и задачи, за которыми вы наблюдаете: поиск, комментарии и результаты — не выходя из JiraTime</p>
      </div>
      <div v-if="store.connected" class="bx-header__actions">
        <span class="bx-muted">{{ store.settings.user?.name }} · {{ store.settings.user?.portal.replace(/^https?:\/\//, '') }}</span>
        <button class="bx-btn" :disabled="store.loading" @click="store.loadTasks()">
          <ActionIcon name="refresh" :size="15" :class="{ 'bx-spin': store.loading }" /> Обновить
        </button>
      </div>
    </header>

    <div v-if="!store.connected" class="bx-empty">
      <div class="bx-empty__icon"><ActionIcon name="link" :size="24" /></div>
      <h2>Битрикс24 не подключён</h2>
      <p>Интеграция необязательная. Чтобы смотреть свои задачи и писать в них комментарии, создайте входящий вебхук в Битрикс24 и вставьте его адрес в «Настройках» → «Битрикс24».</p>
      <router-link class="bx-btn bx-btn--primary" :to="{ name: 'settings', hash: '#bitrix' }">Открыть настройки</router-link>
    </div>

    <template v-else>
      <section class="bx-card bx-filters">
        <div class="bx-seg">
          <button v-for="r in BITRIX_ROLES" :key="r.id" class="bx-seg__btn" :class="{ 'is-on': store.settings.role === r.id }" :title="r.hint" @click="store.setRole(r.id)">{{ r.label }}</button>
        </div>
        <div class="bx-seg bx-seg--sm">
          <button class="bx-seg__btn" :class="{ 'is-on': store.settings.status === 'active' }" @click="store.setStatus('active')">Активные</button>
          <button class="bx-seg__btn" :class="{ 'is-on': store.settings.status === 'done' }" @click="store.setStatus('done')">Завершённые</button>
          <button class="bx-seg__btn" :class="{ 'is-on': store.settings.status === 'all' }" @click="store.setStatus('all')">Все</button>
        </div>
        <label class="bx-search">
          <ActionIcon name="search" :size="15" />
          <input :value="store.search" placeholder="Название задачи или номер, например 1234" @input="store.setSearch(($event.target as HTMLInputElement).value)" />
        </label>
      </section>

      <div v-if="store.error" class="bx-alert"><ActionIcon name="warning" :size="15" /> {{ store.error }}</div>

      <div class="bx-grid">
        <!-- Список задач -->
        <section class="bx-card bx-list" :class="{ 'bx-loading': store.loading }">
          <div class="bx-list__head">
            <span>{{ store.total }} {{ store.total % 10 === 1 && store.total % 100 !== 11 ? 'задача' : [2, 3, 4].includes(store.total % 10) && ![12, 13, 14].includes(store.total % 100) ? 'задачи' : 'задач' }}</span>
          </div>
          <div v-if="!store.loading && !store.tasks.length" class="bx-muted bx-pad">Задач не найдено.</div>
          <button
            v-for="t in store.tasks" :key="t.id" class="bx-item" :class="{ 'is-on': t.id === store.selectedId }"
            @click="store.openTask(t.id)"
          >
            <span class="bx-item__top">
              <span class="bx-item__title">{{ t.title }}</span>
              <span class="bx-item__id">#{{ t.id }}</span>
            </span>
            <span class="bx-item__meta">
              <span class="bx-status" :class="'tone--' + statusOf(t.status).tone">{{ statusOf(t.status).label }}</span>
              <span v-if="t.deadline" :class="{ 'bx-overdue': isOverdue(t.deadline, t.status) }">до {{ fmtDate(t.deadline) }}</span>
              <span v-if="t.responsibleName" class="bx-muted">{{ t.responsibleName }}</span>
              <span v-if="t.groupName" class="bx-muted">· {{ t.groupName }}</span>
            </span>
          </button>
          <button v-if="store.next !== null" class="bx-more" :disabled="store.loadingMore" @click="store.loadMore()">
            {{ store.loadingMore ? 'Загрузка…' : `Показать ещё (${store.tasks.length} из ${store.total})` }}
          </button>
        </section>

        <!-- Карточка задачи -->
        <section class="bx-card bx-detail" :class="{ 'bx-loading': store.detailLoading }">
          <div v-if="store.detailError" class="bx-alert"><ActionIcon name="warning" :size="15" /> {{ store.detailError }}</div>
          <div v-else-if="!task" class="bx-muted bx-pad">Выберите задачу слева.</div>
          <template v-else>
            <div class="bx-detail__head">
              <h2>{{ task.title }}</h2>
              <button class="bx-btn bx-btn--sm" title="Открыть задачу в Битрикс24" @click="openInBitrix(task.id)"><ActionIcon name="link" :size="14" /> #{{ task.id }}</button>
            </div>
            <div class="bx-facts">
              <span class="bx-status" :class="'tone--' + statusOf(task.status).tone">{{ statusOf(task.status).label }}</span>
              <span v-if="task.deadline" :class="{ 'bx-overdue': isOverdue(task.deadline, task.status) }">Крайний срок: {{ fmtDateTime(task.deadline) }}</span>
              <span v-if="task.responsibleName">Исполнитель: <b>{{ task.responsibleName }}</b></span>
              <span v-if="task.creatorName">Постановщик: {{ task.creatorName }}</span>
              <span v-if="task.groupName">Проект: {{ task.groupName }}</span>
            </div>
            <div v-if="plainBitrixText(task.description)" class="bx-desc">{{ plainBitrixText(task.description) }}</div>

            <div v-if="results.length" class="bx-results">
              <h3><ActionIcon name="check-circle" :size="15" /> Результаты · {{ results.length }}</h3>
              <div v-for="c in results" :key="'r' + c.id" class="bx-result">
                <div class="bx-comment__meta">{{ c.authorName }} · {{ fmtDateTime(c.created) }}</div>
                <div class="bx-comment__text">{{ plainBitrixText(c.text) }}</div>
              </div>
            </div>

            <!-- Новый комментарий -->
            <div class="bx-compose">
              <textarea v-model="draft" rows="3" :placeholder="`Комментарий к задаче… (${hotkeyLabel('Ctrl+Enter')} — отправить)`" @keydown.ctrl.enter="send" @keydown.meta.enter="isMac && send()"></textarea>
              <div class="bx-compose__bar">
                <label class="bx-check" title="Комментарий станет результатом задачи — его увидит постановщик в блоке «Результат»">
                  <input v-model="asResult" type="checkbox" /> Отметить как результат
                </label>
                <button class="bx-link" title="Подставить свои списания времени за сегодня из Jira" @click="insertTodayWorklog">
                  <ActionIcon name="clock" :size="14" /> Вставить списания за сегодня
                </button>
                <button class="bx-btn bx-btn--primary" :disabled="!draft.trim() || store.sending" @click="send">
                  {{ store.sending ? 'Отправка…' : asResult ? 'Добавить результат' : 'Добавить комментарий' }}
                </button>
              </div>
              <div v-if="sendMessage" class="bx-send-msg" :class="sendMessage.ok ? 'is-ok' : 'is-bad'">{{ sendMessage.text }}</div>
            </div>

            <div class="bx-comments">
              <h3>Комментарии · {{ store.detail?.comments.length ?? 0 }}</h3>
              <div v-for="w in store.detail?.warnings ?? []" :key="w" class="bx-muted bx-small">Не удалось загрузить {{ w }}</div>
              <div v-if="!(store.detail?.comments.length)" class="bx-muted bx-small">Комментариев пока нет.</div>
              <div v-for="c in store.detail?.comments ?? []" :key="c.id" class="bx-comment" :class="{ 'is-result': c.isResult }">
                <div class="bx-comment__meta">
                  <b>{{ c.authorName || 'Пользователь ' + c.authorId }}</b> · {{ fmtDateTime(c.created) }}
                  <span v-if="c.isResult" class="bx-result-badge">результат</span>
                </div>
                <div class="bx-comment__text">{{ plainBitrixText(c.text) }}</div>
              </div>
            </div>
          </template>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bx { padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; max-width: 110rem; }
.bx-header { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
.bx-header h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.01em; }
.bx-sub { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.875rem; }
.bx-header__actions { display: flex; gap: 0.75rem; align-items: center; }
.bx-muted { color: var(--muted); }
.bx-small { font-size: 0.75rem; }
.bx-pad { padding: 1rem 0.25rem; }
.bx-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 1rem 1.125rem; min-width: 0; }
.bx-loading { opacity: 0.6; }
.bx-btn { display: inline-flex; gap: 0.4rem; align-items: center; border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 0.5rem; padding: 0.5rem 0.9rem; font-weight: 600; font-size: 0.875rem; text-decoration: none; white-space: nowrap; }
.bx-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
.bx-btn--primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.bx-btn--primary:hover:not(:disabled) { background: var(--primary-hover); color: #fff; }
.bx-btn--sm { padding: 0.3rem 0.6rem; font-size: 0.8125rem; }
.bx-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.bx-spin { animation: bx-spin 0.9s linear infinite; }
@keyframes bx-spin { to { transform: rotate(360deg); } }

.bx-empty { text-align: center; padding: 3rem 1rem; border: 1px dashed var(--border); border-radius: var(--radius); background: var(--card); display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
.bx-empty h2 { margin: 0.25rem 0 0; font-size: 1.125rem; }
.bx-empty p { color: var(--muted); max-width: 36rem; margin: 0 0 0.5rem; }
.bx-empty__icon { display: inline-flex; padding: 0.75rem; border-radius: 999px; background: var(--chip); color: var(--primary); }

.bx-filters { display: flex; gap: 0.75rem 1rem; flex-wrap: wrap; align-items: center; }
.bx-seg { display: inline-flex; padding: 0.2rem; border-radius: 0.625rem; background: var(--chip); gap: 0.125rem; flex-wrap: wrap; }
.bx-seg__btn { border: none; background: transparent; color: var(--muted); font-weight: 600; font-size: 0.875rem; padding: 0.4rem 0.85rem; border-radius: 0.5rem; }
.bx-seg__btn:hover { color: var(--fg); }
.bx-seg__btn.is-on { background: var(--card); color: var(--fg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.bx-seg--sm .bx-seg__btn { padding: 0.25rem 0.65rem; font-size: 0.8125rem; }
.bx-search { flex: 1 1 18rem; display: flex; align-items: center; gap: 0.4rem; border: 1px solid var(--border); border-radius: 0.5rem; padding: 0 0.6rem; background: var(--card); color: var(--muted); }
.bx-search input { flex: 1; border: none !important; background: transparent !important; padding: 0.45rem 0; font-size: 0.875rem; outline: none; box-shadow: none !important; }
.bx-alert { display: flex; gap: 0.5rem; align-items: center; padding: 0.6rem 0.875rem; border-radius: 0.5rem; font-size: 0.875rem; background: var(--color-danger-bg); color: var(--danger); }

.bx-grid { display: grid; grid-template-columns: minmax(20rem, 28rem) minmax(0, 1fr); gap: 1rem; align-items: start; }
.bx-list { display: flex; flex-direction: column; gap: 0.25rem; max-height: calc(100vh - 15rem); overflow-y: auto; padding: 0.5rem; }
.bx-list__head { font-size: 0.75rem; color: var(--muted); padding: 0.25rem 0.5rem 0.5rem; }
.bx-item { display: flex; flex-direction: column; gap: 0.3rem; text-align: left; width: 100%; padding: 0.6rem 0.65rem; border: 1px solid transparent; border-radius: 0.5rem; background: transparent; color: var(--fg); }
.bx-item:hover { background: var(--chip); }
.bx-item.is-on { border-color: var(--primary); background: var(--primary-soft); }
.bx-item__top { display: flex; gap: 0.5rem; justify-content: space-between; align-items: baseline; }
.bx-item__title { font-weight: 600; font-size: 0.875rem; line-height: 1.3; }
.bx-item__id { font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
.bx-item__meta { display: flex; flex-wrap: wrap; gap: 0.25rem 0.5rem; align-items: center; font-size: 0.75rem; }
.bx-more { margin-top: 0.25rem; border: 1px dashed var(--border); background: transparent; color: var(--primary); border-radius: 0.5rem; padding: 0.5rem; font-weight: 600; font-size: 0.8125rem; }

.bx-status { font-size: 0.6875rem; font-weight: 700; padding: 0.05rem 0.5rem; border-radius: 999px; white-space: nowrap; }
.tone--new { background: var(--chip); color: var(--muted); }
.tone--work { background: color-mix(in srgb, var(--primary) 16%, transparent); color: var(--primary-strong); }
.tone--wait { background: var(--amber-bg); color: var(--amber-fg); }
.tone--done { background: var(--color-success-bg); color: var(--success); }
.tone--off { background: var(--chip); color: var(--muted); }
.bx-overdue { color: var(--danger); font-weight: 600; }

.bx-detail { display: flex; flex-direction: column; gap: 0.875rem; }
.bx-detail__head { display: flex; gap: 1rem; justify-content: space-between; align-items: flex-start; }
.bx-detail__head h2 { margin: 0; font-size: 1.125rem; line-height: 1.35; }
.bx-facts { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; font-size: 0.8125rem; color: var(--muted); align-items: center; }
.bx-facts b { color: var(--fg); font-weight: 600; }
.bx-desc { white-space: pre-wrap; font-size: 0.875rem; line-height: 1.5; padding: 0.75rem 0.875rem; border-radius: 0.5rem; background: color-mix(in srgb, var(--chip) 55%, transparent); max-height: 14rem; overflow-y: auto; }
.bx-detail h3 { margin: 0 0 0.5rem; font-size: 0.9375rem; display: flex; align-items: center; gap: 0.4rem; }
.bx-results { border: 1px solid color-mix(in srgb, var(--success) 40%, var(--border)); border-radius: 0.625rem; padding: 0.75rem 0.875rem; }
.bx-results h3 { color: var(--success); }
.bx-result + .bx-result { margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); }

.bx-compose { display: flex; flex-direction: column; gap: 0.5rem; }
.bx-compose textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: 0.6rem 0.7rem; font: inherit; font-size: 0.875rem; }
.bx-compose__bar { display: flex; gap: 0.75rem 1rem; align-items: center; flex-wrap: wrap; }
.bx-compose__bar .bx-btn--primary { margin-left: auto; }
.bx-check { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.8125rem; font-weight: 600; cursor: pointer; }
.bx-check input { margin: 0; accent-color: var(--success); }
.bx-link { display: inline-flex; align-items: center; gap: 0.3rem; border: none; background: none; padding: 0; color: var(--primary); font-weight: 600; font-size: 0.8125rem; }
.bx-link:hover { text-decoration: underline; }
.bx-send-msg { font-size: 0.8125rem; font-weight: 600; }
.bx-send-msg.is-ok { color: var(--success); }
.bx-send-msg.is-bad { color: var(--amber-fg); }

.bx-comment { padding: 0.6rem 0; border-bottom: 1px solid var(--border); }
.bx-comment:last-child { border-bottom: none; }
.bx-comment.is-result { background: color-mix(in srgb, var(--success) 6%, transparent); margin: 0 -0.5rem; padding: 0.6rem 0.5rem; border-radius: 0.375rem; }
.bx-comment__meta { font-size: 0.75rem; color: var(--muted); display: flex; align-items: center; gap: 0.35rem; }
.bx-comment__meta b { color: var(--fg); }
.bx-comment__text { white-space: pre-wrap; font-size: 0.875rem; line-height: 1.45; margin-top: 0.2rem; }
.bx-result-badge { font-size: 0.625rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; background: var(--success); border-radius: 999px; padding: 0.05rem 0.45rem; }
@media (max-width: 64rem) { .bx-grid { grid-template-columns: 1fr; } .bx-list { max-height: 24rem; } }
</style>
