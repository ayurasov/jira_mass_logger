<script setup lang="ts">
// «Дайджест»: последние изменения в Jira по проекту или команде, активность людей
// и задачи без движения (ни изменений, ни списаний).
import { computed, onMounted, ref, watch } from 'vue';
import ActionIcon from '../components/ActionIcon.vue';
import { useDigestStore } from '../store/digest';
import { useTeamStore } from '../store/team';
import { formatRuDate, parseIsoDate } from '../utils/time';
import {
  buildFeed, buildPeople, daysSince, fieldLabel, groupByDay, inProgressWithoutWorklog, summarize,
  type DigestIssue,
} from '../utils/digest';

const store = useDigestStore();
const team = useTeamStore();

const projectFilter = ref('');
const feedFilter = ref<'all' | 'status' | 'assignee' | 'other'>('all');
const FEED_LIMIT = 200;

onMounted(async () => {
  if (store.prefs.scopeType === 'project') await store.loadProjects();
  if (store.scopeReady) store.load();
});
watch(() => store.prefs.scopeType, (t) => { if (t === 'project') store.loadProjects(); });

const filteredProjects = computed(() => {
  const q = projectFilter.value.trim().toLowerCase();
  const list = store.projects.filter((p) => !q || p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  // Выбранные — первыми.
  return [...list].sort((a, b) => Number(store.prefs.projectKeys.includes(b.key)) - Number(store.prefs.projectKeys.includes(a.key)));
});

const summary = computed(() => (store.data ? summarize(store.data, store.since) : null));
const feed = computed(() => {
  if (!store.data) return [];
  const all = buildFeed(store.data.updated);
  return feedFilter.value === 'all' ? all : all.filter((e) => (feedFilter.value === 'other' ? e.kind === 'other' || e.kind === 'resolution' : e.kind === feedFilter.value));
});
const feedDays = computed(() => groupByDay(feed.value.slice(0, FEED_LIMIT)));
const people = computed(() =>
  store.data ? buildPeople(store.data, store.prefs.scopeType === 'team' ? store.team?.members ?? [] : []) : [],
);
const silentPeople = computed(() => people.value.filter((p) => p.silent));
const noWorklog = computed(() => (store.data ? inProgressWithoutWorklog(store.data) : []));
const staleSorted = computed(() =>
  [...(store.data?.stale ?? [])].sort((a, b) => a.updated.localeCompare(b.updated)),
);

const updatedWithoutChanges = computed(() =>
  (store.data?.updated ?? []).filter((i) => i.changes.length === 0),
);

const fmtTime = (s: string) => s.slice(11, 16);
const fmtH = (h: number) => (Math.round(h * 10) / 10).toLocaleString('ru-RU');
const dayTitle = (iso: string) => {
  if (iso === store.today) return 'Сегодня';
  const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][parseIsoDate(iso).getDay()];
  return `${formatRuDate(iso)} · ${wd}`;
};
const ageClass = (days: number) => (days >= store.prefs.staleDays * 2 ? 'age--bad' : 'age--warn');
const catClass = (i: DigestIssue) => `cat--${i.statusCategory || 'new'}`;
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10; const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
</script>

<template>
  <div class="dg">
    <header class="dg-header">
      <div>
        <h1>Дайджест</h1>
        <p class="dg-sub">Что изменилось в Jira за период — и где тишина: задачи без движения и люди без активности</p>
      </div>
      <div class="dg-header__actions">
        <span v-if="store.loadedAt" class="dg-muted">Обновлено {{ new Date(store.loadedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) }}</span>
        <button class="dg-btn dg-btn--primary" :disabled="store.loading || !store.scopeReady" @click="store.load()">
          <ActionIcon name="refresh" :size="15" :class="{ 'dg-spin': store.loading }" /> {{ store.loading ? 'Загрузка…' : 'Показать' }}
        </button>
      </div>
    </header>

    <!-- Скоуп и период -->
    <section class="dg-card dg-controls">
      <div class="dg-row">
        <div class="dg-seg">
          <button class="dg-seg__btn" :class="{ 'is-on': store.prefs.scopeType === 'project' }" @click="store.prefs.scopeType = 'project'">Проекты</button>
          <button class="dg-seg__btn" :class="{ 'is-on': store.prefs.scopeType === 'team' }" @click="store.prefs.scopeType = 'team'">Команда</button>
        </div>
        <div class="dg-field">
          <span class="dg-label">Период</span>
          <div class="dg-seg dg-seg--sm">
            <button v-for="d in [1, 3, 7, 14, 30]" :key="d" class="dg-seg__btn" :class="{ 'is-on': store.prefs.periodDays === d }" @click="store.prefs.periodDays = d; store.load()">
              {{ d === 1 ? 'Сегодня' : `${d} дн.` }}
            </button>
          </div>
        </div>
        <div class="dg-field">
          <span class="dg-label">Без движения дольше</span>
          <div class="dg-seg dg-seg--sm">
            <button v-for="d in [7, 14, 30, 60]" :key="d" class="dg-seg__btn" :class="{ 'is-on': store.prefs.staleDays === d }" @click="store.prefs.staleDays = d; store.load()">{{ d }} дн.</button>
          </div>
        </div>
      </div>

      <div v-if="store.prefs.scopeType === 'project'" class="dg-projects">
        <input v-model="projectFilter" class="dg-search" placeholder="Найти проект…" />
        <div v-if="store.projectsError" class="dg-err">{{ store.projectsError }}</div>
        <div class="dg-chips">
          <button
            v-for="p in filteredProjects.slice(0, 40)" :key="p.key" class="dg-chip"
            :class="{ 'is-on': store.prefs.projectKeys.includes(p.key) }" :title="p.name" @click="store.toggleProject(p.key)"
          ><b>{{ p.key }}</b> {{ p.name }}</button>
        </div>
      </div>
      <div v-else class="dg-projects">
        <div v-if="!team.teams.length" class="dg-muted">Команд пока нет — соберите её на экране <router-link to="/team" class="dg-link">«Команда»</router-link>.</div>
        <div v-else class="dg-chips">
          <button
            v-for="t in team.teams" :key="t.id" class="dg-chip"
            :class="{ 'is-on': store.team?.id === t.id }" @click="store.prefs.teamId = t.id; store.load()"
          ><b>{{ t.name }}</b> {{ t.members.length }} {{ plural(t.members.length, 'участник', 'участника', 'участников') }}</button>
        </div>
      </div>
      <div class="dg-period-note dg-muted">
        с {{ formatRuDate(store.since) }} по {{ formatRuDate(store.today) }} · «тишина» — без изменений с {{ formatRuDate(store.staleBefore) }}
      </div>
    </section>

    <div v-if="store.error" class="dg-alert dg-alert--error"><ActionIcon name="warning" :size="15" /> {{ store.error }}</div>
    <div v-if="store.data?.truncated" class="dg-alert dg-alert--warn"><ActionIcon name="info" :size="15" /> Данных очень много — показана только часть. Сократите период или скоуп.</div>
    <div v-for="e in (store.data?.errors ?? []).slice(0, 3)" :key="e" class="dg-alert dg-alert--warn"><ActionIcon name="info" :size="15" /> {{ e }}</div>

    <div v-if="!store.scopeReady" class="dg-empty">
      <div class="dg-empty__icon"><ActionIcon name="sparkles" :size="26" /></div>
      <h2>Выберите, что показывать</h2>
      <p>Отметьте один или несколько проектов либо команду — и увидите свежие изменения, списания и задачи, где давно ничего не происходит.</p>
    </div>

    <template v-else-if="store.data && summary">
      <!-- Сводка -->
      <section class="dg-stats" :class="{ 'dg-loading': store.loading }">
        <div class="dg-stat"><span class="dg-stat__label">Изменено задач</span><span class="dg-stat__value">{{ summary.updatedIssues }}</span><span class="dg-stat__hint">новых: {{ summary.created }}</span></div>
        <div class="dg-stat"><span class="dg-stat__label">Смен статуса</span><span class="dg-stat__value">{{ summary.transitions }}</span><span class="dg-stat__hint">закрыто: {{ summary.done }}</span></div>
        <div class="dg-stat"><span class="dg-stat__label">Списано</span><span class="dg-stat__value">{{ fmtH(summary.worklogHours) }}<small> ч</small></span><span class="dg-stat__hint">{{ store.data.worklogs.length }} записей</span></div>
        <div class="dg-stat" :class="{ 'dg-stat--alert': summary.stale > 0 }"><span class="dg-stat__label">Без движения</span><span class="dg-stat__value">{{ summary.stale }}</span><span class="dg-stat__hint">открытых задач &gt; {{ store.prefs.staleDays }} дн.</span></div>
        <div class="dg-stat" :class="{ 'dg-stat--alert': noWorklog.length > 0 }"><span class="dg-stat__label">В работе без списаний</span><span class="dg-stat__value">{{ noWorklog.length }}</span><span class="dg-stat__hint">за период</span></div>
        <div v-if="store.prefs.scopeType === 'team'" class="dg-stat" :class="{ 'dg-stat--alert': silentPeople.length > 0 }"><span class="dg-stat__label">Без активности</span><span class="dg-stat__value">{{ silentPeople.length }}</span><span class="dg-stat__hint">из {{ people.length }} участников</span></div>
      </section>

      <div class="dg-grid">
        <!-- Лента -->
        <section class="dg-card dg-feed">
          <div class="dg-card__head">
            <h2>Лента изменений</h2>
            <div class="dg-seg dg-seg--sm">
              <button class="dg-seg__btn" :class="{ 'is-on': feedFilter === 'all' }" @click="feedFilter = 'all'">Все</button>
              <button class="dg-seg__btn" :class="{ 'is-on': feedFilter === 'status' }" @click="feedFilter = 'status'">Статусы</button>
              <button class="dg-seg__btn" :class="{ 'is-on': feedFilter === 'assignee' }" @click="feedFilter = 'assignee'">Исполнители</button>
              <button class="dg-seg__btn" :class="{ 'is-on': feedFilter === 'other' }" @click="feedFilter = 'other'">Прочее</button>
            </div>
          </div>
          <div v-if="!feed.length" class="dg-quiet">
            <ActionIcon name="info" :size="16" /> За период изменений нет{{ updatedWithoutChanges.length ? ` (задач с обновлением без истории: ${updatedWithoutChanges.length})` : '' }}.
          </div>
          <div v-for="g in feedDays" :key="g.date" class="dg-day">
            <div class="dg-day__title">{{ dayTitle(g.date) }} <span class="dg-muted">· {{ g.items.length }}</span></div>
            <div v-for="(e, idx) in g.items" :key="idx" class="dg-entry" :class="'dg-entry--' + e.kind">
              <span class="dg-entry__time">{{ fmtTime(e.created) }}</span>
              <span class="dg-entry__dot"></span>
              <div class="dg-entry__body">
                <div><b>{{ e.issueKey }}</b> <span class="dg-muted dg-ellipsis-inline">{{ e.issueSummary }}</span></div>
                <div class="dg-entry__change">
                  <span class="dg-field-name">{{ fieldLabel(e.field) }}:</span>
                  <template v-if="e.kind === 'status' || e.kind === 'assignee' || e.kind === 'resolution'">
                    <span class="dg-from">{{ e.from || '—' }}</span> <span class="dg-arrow">→</span> <span class="dg-to">{{ e.to || '—' }}</span>
                  </template>
                  <span v-else class="dg-muted">изменено</span>
                  <span class="dg-by">· {{ e.authorName || e.authorId || 'система' }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-if="feed.length > FEED_LIMIT" class="dg-muted dg-more">Показаны последние {{ FEED_LIMIT }} из {{ feed.length }} изменений.</div>
        </section>

        <div class="dg-side">
          <!-- Люди -->
          <section class="dg-card">
            <h2>Активность людей</h2>
            <div v-if="!people.length" class="dg-muted dg-small">Нет данных о людях за период.</div>
            <div v-for="p in people" :key="p.id" class="dg-person" :class="{ 'is-silent': p.silent }">
              <div class="dg-person__name">
                <span class="dg-status-dot" :class="p.silent ? 'is-bad' : 'is-ok'"></span>
                <b>{{ p.name }}</b>
              </div>
              <div v-if="p.silent" class="dg-small dg-c-bad">ни изменений, ни списаний за период</div>
              <div v-else class="dg-small dg-muted">
                {{ p.changes }} {{ plural(p.changes, 'изменение', 'изменения', 'изменений') }}<template v-if="p.transitions"> ({{ p.transitions }} статус.)</template>
                · {{ fmtH(p.worklogHours) }} ч · {{ p.issues.size }} {{ plural(p.issues.size, 'задача', 'задачи', 'задач') }}
                <template v-if="p.lastActivity"> · посл. {{ formatRuDate(p.lastActivity).slice(0, 5) }} {{ fmtTime(p.lastActivity) }}</template>
              </div>
            </div>
          </section>

          <!-- В работе без списаний -->
          <section class="dg-card">
            <h2>В работе, но без списаний</h2>
            <div v-if="!noWorklog.length" class="dg-ok"><ActionIcon name="check-circle" :size="15" /> По всем задачам в работе есть списания.</div>
            <div v-for="i in noWorklog.slice(0, 30)" :key="i.key" class="dg-issue">
              <div><b>{{ i.key }}</b> <span class="dg-cat" :class="catClass(i)">{{ i.status }}</span></div>
              <div class="dg-small dg-ellipsis">{{ i.summary }}</div>
              <div class="dg-small dg-muted">{{ i.assigneeName || 'не назначена' }} · обновлена {{ formatRuDate(i.updated).slice(0, 5) }}</div>
            </div>
          </section>

          <!-- Без движения -->
          <section class="dg-card">
            <h2>Без движения</h2>
            <div v-if="!staleSorted.length" class="dg-ok"><ActionIcon name="check-circle" :size="15" /> Застывших открытых задач нет.</div>
            <div v-for="i in staleSorted.slice(0, 40)" :key="i.key" class="dg-issue">
              <div class="dg-issue__top">
                <span><b>{{ i.key }}</b> <span class="dg-cat" :class="catClass(i)">{{ i.status }}</span></span>
                <span class="dg-age" :class="ageClass(daysSince(i.updated, store.today))">{{ daysSince(i.updated, store.today) }} дн.</span>
              </div>
              <div class="dg-small dg-ellipsis">{{ i.summary }}</div>
              <div class="dg-small dg-muted">{{ i.assigneeName || 'не назначена' }}<template v-if="i.priority"> · {{ i.priority }}</template></div>
            </div>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dg { padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; max-width: 110rem; }
.dg-header { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
.dg-header h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.01em; }
.dg-sub { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.875rem; }
.dg-header__actions { display: flex; gap: 0.5rem; align-items: center; }
.dg-muted { color: var(--muted); }
.dg-small { font-size: 0.75rem; }
.dg-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dg-ellipsis-inline { display: inline-block; max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.dg-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 1rem 1.125rem; }
.dg-card h2 { margin: 0 0 0.625rem; font-size: 1rem; }
.dg-card__head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
.dg-card__head h2 { margin: 0; }
.dg-loading { opacity: 0.6; }

.dg-btn { display: inline-flex; gap: 0.4rem; align-items: center; border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 0.5rem; padding: 0.55rem 0.95rem; font-weight: 600; font-size: 0.875rem; }
.dg-btn--primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.dg-btn--primary:hover:not(:disabled) { background: var(--primary-hover); }
.dg-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dg-spin { animation: dg-spin 0.9s linear infinite; }
@keyframes dg-spin { to { transform: rotate(360deg); } }

.dg-controls { display: flex; flex-direction: column; gap: 0.875rem; }
.dg-row { display: flex; flex-wrap: wrap; gap: 1rem 1.5rem; align-items: flex-end; }
.dg-field { display: flex; flex-direction: column; gap: 0.35rem; }
.dg-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
.dg-seg { display: inline-flex; padding: 0.2rem; border-radius: 0.625rem; background: var(--chip); gap: 0.125rem; flex-wrap: wrap; }
.dg-seg__btn { border: none; background: transparent; color: var(--muted); font-weight: 600; font-size: 0.875rem; padding: 0.4rem 0.9rem; border-radius: 0.5rem; }
.dg-seg__btn:hover { color: var(--fg); }
.dg-seg__btn.is-on { background: var(--card); color: var(--fg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.dg-seg--sm .dg-seg__btn { padding: 0.25rem 0.65rem; font-size: 0.8125rem; }
.dg-projects { display: flex; flex-direction: column; gap: 0.5rem; }
.dg-search { max-width: 22rem; padding: 0.45rem 0.65rem; font-size: 0.875rem; }
.dg-chips { display: flex; flex-wrap: wrap; gap: 0.375rem; max-height: 7.5rem; overflow: auto; }
.dg-chip { border: 1px solid var(--border); background: var(--card); color: var(--muted); border-radius: 999px; padding: 0.3rem 0.75rem; font-size: 0.8125rem; max-width: 18rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dg-chip b { color: var(--fg); }
.dg-chip:hover { border-color: var(--primary); }
.dg-chip.is-on { background: var(--primary); border-color: var(--primary); color: #fff; }
.dg-chip.is-on b { color: #fff; }
.dg-period-note { font-size: 0.75rem; }
.dg-link { color: var(--primary); }
.dg-err { color: var(--danger); font-size: 0.8125rem; }

.dg-alert { display: flex; gap: 0.5rem; align-items: center; padding: 0.6rem 0.875rem; border-radius: 0.5rem; font-size: 0.875rem; }
.dg-alert--error { background: var(--color-danger-bg); color: var(--danger); }
.dg-alert--warn { background: var(--amber-bg); color: var(--amber-fg); border: 1px solid var(--amber-border); }

.dg-empty { text-align: center; padding: 3rem 1rem; border: 1px dashed var(--border); border-radius: var(--radius); background: var(--card); }
.dg-empty h2 { margin: 0.5rem 0; font-size: 1.125rem; }
.dg-empty p { color: var(--muted); max-width: 34rem; margin: 0 auto; }
.dg-empty__icon { display: inline-flex; padding: 0.75rem; border-radius: 999px; background: var(--chip); color: var(--primary); }

.dg-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.75rem; }
.dg-stat { display: flex; flex-direction: column; gap: 0.15rem; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.875rem 1rem; box-shadow: var(--shadow); }
.dg-stat--alert { border-color: color-mix(in srgb, var(--warning) 55%, var(--border)); }
.dg-stat--alert .dg-stat__value { color: var(--warning); }
.dg-stat__label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
.dg-stat__value { font-size: 1.625rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.dg-stat__value small { font-size: 0.875rem; color: var(--muted); }
.dg-stat__hint { font-size: 0.75rem; color: var(--muted); }

.dg-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, 24rem); gap: 1rem; align-items: start; }
.dg-side { display: flex; flex-direction: column; gap: 1rem; }

.dg-quiet { display: flex; gap: 0.5rem; align-items: center; color: var(--muted); padding: 1rem 0; }
.dg-day + .dg-day { margin-top: 0.75rem; }
.dg-day__title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 0.375rem 0; border-bottom: 1px solid var(--border); margin-bottom: 0.25rem; }
.dg-entry { display: grid; grid-template-columns: 2.75rem 0.75rem 1fr; gap: 0.5rem; padding: 0.4rem 0; font-size: 0.8125rem; align-items: start; }
.dg-entry__time { color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 0.05rem; }
.dg-entry__dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; margin-top: 0.35rem; background: var(--muted); }
.dg-entry--status .dg-entry__dot { background: var(--primary); }
.dg-entry--assignee .dg-entry__dot { background: #8b5cf6; }
.dg-entry--resolution .dg-entry__dot { background: var(--success); }
.dg-entry__change { margin-top: 0.1rem; }
.dg-field-name { color: var(--muted); margin-right: 0.25rem; }
.dg-from { color: var(--muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted) 50%, transparent); }
.dg-arrow { color: var(--muted); }
.dg-to { font-weight: 600; }
.dg-by { color: var(--muted); margin-left: 0.25rem; }
.dg-more { margin-top: 0.5rem; font-size: 0.75rem; }

.dg-person { padding: 0.45rem 0; border-bottom: 1px solid var(--border); }
.dg-person:last-child { border-bottom: none; }
.dg-person__name { display: flex; align-items: center; gap: 0.45rem; font-size: 0.875rem; }
.dg-person.is-silent .dg-person__name b { color: var(--danger); }
.dg-status-dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; }
.dg-status-dot.is-ok { background: var(--success); }
.dg-status-dot.is-bad { background: var(--danger); }
.dg-c-bad { color: var(--danger); margin-left: 0.95rem; }
.dg-person .dg-muted { margin-left: 0.95rem; }

.dg-issue { padding: 0.45rem 0; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 0.1rem; font-size: 0.8125rem; min-width: 0; }
.dg-issue:last-child { border-bottom: none; }
.dg-issue__top { display: flex; justify-content: space-between; gap: 0.5rem; }
.dg-cat { font-size: 0.6875rem; font-weight: 700; padding: 0.05rem 0.45rem; border-radius: 999px; margin-left: 0.25rem; }
.cat--new { background: var(--chip); color: var(--muted); }
.cat--indeterminate { background: color-mix(in srgb, var(--primary) 16%, transparent); color: var(--primary-strong); }
.cat--done { background: var(--color-success-bg); color: var(--success); }
.dg-age { font-weight: 700; font-variant-numeric: tabular-nums; font-size: 0.75rem; padding: 0.05rem 0.45rem; border-radius: 999px; }
.age--warn { background: var(--amber-bg); color: var(--amber-fg); }
.age--bad { background: var(--color-danger-bg); color: var(--danger); }
.dg-ok { display: flex; gap: 0.4rem; align-items: center; color: var(--success); font-size: 0.8125rem; font-weight: 600; }

@media (max-width: 72rem) { .dg-grid { grid-template-columns: 1fr; } }
</style>
