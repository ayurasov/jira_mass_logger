<script setup lang="ts">
// «Дайджест»: последние изменения в Jira по проекту или команде, активность людей
// и задачи без движения (ни изменений, ни списаний).
import { computed, onMounted, ref, watch } from 'vue';
import ActionIcon from '../components/ActionIcon.vue';
import IssueLink from '../components/IssueLink.vue';
import WidgetPager from '../components/WidgetPager.vue';
import { usePager } from '../composables/usePager';
import { datesInRange } from '../utils/worklogChecks';
import { LIMIT_OPTIONS, useDigestStore } from '../store/digest';
import { useTeamStore } from '../store/team';
import { formatRuDate, parseIsoDate } from '../utils/time';
import {
  activityByDay, buildFeed, buildPeople, byProject, daysSince, digestText, fieldLabel, groupByDay, highlights,
  inProgressWithoutWorklog, overdueCount, plural, staleCount, summarize, unassignedCount, type DigestIssue,
} from '../utils/digest';
import type { JiraFilterDto } from '../lib/tauriApi';

const store = useDigestStore();
const team = useTeamStore();

const projectFilter = ref('');
const feedFilter = ref<'all' | 'status' | 'assignee' | 'other'>('all');

onMounted(async () => {
  store.loadPopular();
  if (store.prefs.scopeType === 'project') await store.loadProjects();
  if (store.prefs.scopeType === 'jql') store.loadFilters();
  if (store.scopeReady) store.load();
});
watch(() => store.prefs.scopeType, (t) => {
  if (t === 'project') store.loadProjects();
  if (t === 'jql') store.loadFilters();
});

const filteredProjects = computed(() => {
  const q = projectFilter.value.trim().toLowerCase();
  const list = store.projects.filter((p) => !q || p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  // Выбранные — первыми.
  return [...list].sort((a, b) => Number(store.prefs.projectKeys.includes(b.key)) - Number(store.prefs.projectKeys.includes(a.key)));
});
const projectsPager = usePager(filteredProjects, 'dg-projects', 20);
/** Подсказки «ваши проекты»: по своим списаниям; название — из списка проектов Jira. */
const popularProjects = computed(() => store.popular.map((p) => ({
  ...p, name: store.projects.find((x) => x.key === p.key)?.name ?? '',
})));
const selectPopular = (key: string) => { store.toggleProject(key); store.load(); };

// ── Свой JQL: сохранённые, недавние, фильтры Jira ──
const jqlTab = ref<'saved' | 'recent' | 'filters' | 'examples'>(
  store.prefs.savedJql.length ? 'saved' : 'filters',
);
const jqlName = ref('');
function saveJql() {
  store.saveJql(jqlName.value);
  jqlName.value = '';
  jqlTab.value = 'saved';
}
const filterQuery = ref('');
const filterKind = (f: JiraFilterDto) => (f.mine ? 'мой' : 'команда');
const filteredFilters = computed(() => {
  const q = filterQuery.value.trim().toLowerCase();
  return store.filters.filter((f) => !q || `${f.name} ${f.ownerName ?? ''} ${f.jql}`.toLowerCase().includes(q));
});
const filtersPager = usePager(filteredFilters, 'dg-filters', 10);
const filterJql = (f: JiraFilterDto) => f.jql.trim() || `filter = ${f.id}`;

const summary = computed(() => (store.data ? summarize(store.data, store.since) : null));
const feedQuery = ref('');
const feed = computed(() => {
  if (!store.data) return [];
  const q = feedQuery.value.trim().toLowerCase();
  return buildFeed(store.data.updated)
    .filter((e) => feedFilter.value === 'all' || (feedFilter.value === 'other' ? e.kind === 'other' || e.kind === 'resolution' : e.kind === feedFilter.value))
    .filter((e) => !q || `${e.issueKey} ${e.issueSummary} ${e.authorName ?? ''} ${e.to ?? ''} ${e.from ?? ''}`.toLowerCase().includes(q));
});
const isNew = (created: string) => !!store.previousSeen && new Date(created).getTime() > new Date(store.previousSeen).getTime();
const newCount = computed(() => (store.previousSeen ? buildFeed(store.data?.updated ?? []).filter((e) => isNew(e.created)).length : 0));

const hl = computed(() => (store.data ? highlights(store.data, people.value, store.prefs.scopeType === 'team') : []));
const activity = computed(() => (store.data ? activityByDay(store.data, datesInRange(store.since, store.today)) : []));
const maxChanges = computed(() => Math.max(1, ...activity.value.map((a) => a.changes)));
const maxHours = computed(() => Math.max(1, ...activity.value.map((a) => a.hours)));
const projects = computed(() => (store.data ? byProject(store.data) : []));

const JQL_EXAMPLES = ['"Epic Link" = ABC-1', 'component = Backend', 'labels = release', 'sprint in openSprints()'];
const copied = ref(false);
async function copyDigest() {
  if (!store.data || !summary.value) return;
  const text = digestText(`Дайджест: ${store.scopeTitle}, ${formatRuDate(store.since)} — ${formatRuDate(store.today)}`, summary.value, hl.value);
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 2000);
  } catch { alert(text); }
}
const feedPager = usePager(feed, 'dg-feed', 20);
const feedDays = computed(() => groupByDay(feedPager.items.value));
const people = computed(() =>
  store.data ? buildPeople(store.data, store.prefs.scopeType === 'team' ? store.team?.members ?? [] : []) : [],
);
const silentPeople = computed(() => people.value.filter((p) => p.silent));
const noWorklog = computed(() => (store.data ? inProgressWithoutWorklog(store.data) : []));
const staleSorted = computed(() =>
  [...(store.data?.stale ?? [])].sort((a, b) => a.updated.localeCompare(b.updated)),
);
const overdueList = computed(() => store.data?.overdue ?? []);
const unassignedList = computed(() => store.data?.unassigned ?? []);
const peoplePager = usePager(people, 'dg-people', 10);
const noWorklogPager = usePager(noWorklog, 'dg-noworklog', 5);
const overduePager = usePager(overdueList, 'dg-overdue', 5);
const unassignedPager = usePager(unassignedList, 'dg-unassigned', 5);
const stalePager = usePager(staleSorted, 'dg-stale', 10);
const projectRows = computed(() => projects.value);
const projectTablePager = usePager(projectRows, 'dg-ptable', 10);

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
        <button class="dg-btn" :disabled="!store.data" @click="copyDigest">
          <ActionIcon :name="copied ? 'check-circle' : 'duplicate'" :size="15" /> {{ copied ? 'Скопировано' : 'Копировать дайджест' }}
        </button>
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
          <button class="dg-seg__btn" :class="{ 'is-on': store.prefs.scopeType === 'jql' }" @click="store.prefs.scopeType = 'jql'">Свой JQL</button>
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
        <div class="dg-field" title="Сколько максимум изменённых задач (с историей) и задач с worklog загружать. Меньше — быстрее. «Без движения», «Просрочено» и «Без исполнителя» считаются полностью.">
          <span class="dg-label">Загружать до, задач</span>
          <div class="dg-seg dg-seg--sm">
            <button v-for="n in LIMIT_OPTIONS" :key="n" class="dg-seg__btn" :class="{ 'is-on': store.prefs.limit === n }" @click="store.setLimit(n)">{{ n }}</button>
          </div>
        </div>
      </div>

      <div v-if="store.prefs.scopeType === 'project'" class="dg-projects">
        <div v-if="popularProjects.length" class="dg-popular">
          <span class="dg-popular__label"><ActionIcon name="star" :size="13" /> Ваши проекты</span>
          <button
            v-for="p in popularProjects" :key="p.key" class="dg-chip dg-chip--popular"
            :class="{ 'is-on': store.prefs.projectKeys.includes(p.key) }"
            :title="`${p.name ? p.name + ' · ' : ''}${fmtH(p.hours)} ч за 90 дней, последнее списание ${formatRuDate(p.lastDate)}`"
            @click="selectPopular(p.key)"
          ><b>{{ p.key }}</b><span v-if="p.name" class="dg-chip__name">{{ p.name }}</span><span class="dg-chip__meta">{{ fmtH(p.hours) }} ч</span></button>
        </div>
        <input v-model="projectFilter" class="dg-search" placeholder="Найти проект…" />
        <div v-if="store.projectsError" class="dg-err">Не удалось загрузить список проектов: {{ store.projectsError }}</div>
        <div class="dg-chips">
          <button
            v-for="p in projectsPager.items.value" :key="p.key" class="dg-chip"
            :class="{ 'is-on': store.prefs.projectKeys.includes(p.key) }" :title="p.name" @click="store.toggleProject(p.key)"
          ><b>{{ p.key }}</b> {{ p.name }}</button>
        </div>
        <WidgetPager :pager="projectsPager" />
      </div>
      <div v-else-if="store.prefs.scopeType === 'jql'" class="dg-projects">
        <div class="dg-jql-row">
          <textarea v-model="store.prefs.jql" class="dg-jql" rows="2" placeholder='Например: project = ABC AND "Epic Link" = ABC-1' @keydown.ctrl.enter="store.load()"></textarea>
          <div class="dg-jql-save">
            <input v-model="jqlName" class="dg-input" placeholder="Название запроса" :disabled="!store.prefs.jql.trim()" @keydown.enter="saveJql" />
            <button class="dg-btn dg-btn--sm" :disabled="!store.prefs.jql.trim()" title="Сохранить текущий JQL в «Мои запросы»" @click="saveJql">
              <ActionIcon name="star-outline" :size="14" /> Сохранить
            </button>
          </div>
        </div>
        <div class="dg-jql-tabs">
          <div class="dg-seg dg-seg--sm">
            <button class="dg-seg__btn" :class="{ 'is-on': jqlTab === 'saved' }" @click="jqlTab = 'saved'">Мои запросы <span class="dg-count">{{ store.prefs.savedJql.length }}</span></button>
            <button class="dg-seg__btn" :class="{ 'is-on': jqlTab === 'filters' }" @click="jqlTab = 'filters'; store.loadFilters()">Фильтры Jira <span class="dg-count">{{ store.filters.length }}</span></button>
            <button class="dg-seg__btn" :class="{ 'is-on': jqlTab === 'recent' }" @click="jqlTab = 'recent'">Недавние <span class="dg-count">{{ store.prefs.recentJql.length }}</span></button>
            <button class="dg-seg__btn" :class="{ 'is-on': jqlTab === 'examples' }" @click="jqlTab = 'examples'">Примеры</button>
          </div>
          <span class="dg-muted dg-small">Ctrl+Enter — показать</span>
        </div>

        <div v-if="jqlTab === 'saved'" class="dg-chips">
          <span v-if="!store.prefs.savedJql.length" class="dg-muted dg-small">Сохранённых запросов пока нет — введите JQL, дайте название и нажмите «Сохранить».</span>
          <span
            v-for="q in store.prefs.savedJql" :key="q.id" class="dg-chip dg-chip--saved"
            :class="{ 'is-on': store.prefs.jql.trim() === q.jql }" :title="q.jql"
          >
            <button class="dg-chip__main" @click="store.useJql(q.jql)"><b>{{ q.name }}</b></button>
            <button class="dg-chip__x" title="Удалить запрос" @click="store.deleteSavedJql(q.id)"><ActionIcon name="close" :size="12" /></button>
          </span>
        </div>

        <div v-else-if="jqlTab === 'recent'" class="dg-chips">
          <span v-if="!store.prefs.recentJql.length" class="dg-muted dg-small">Здесь появятся последние выполненные запросы.</span>
          <button v-for="q in store.prefs.recentJql" :key="q" class="dg-chip dg-chip--code" :class="{ 'is-on': store.prefs.jql.trim() === q }" :title="q" @click="store.useJql(q)">{{ q }}</button>
        </div>

        <div v-else-if="jqlTab === 'examples'" class="dg-chips">
          <button v-for="ex in JQL_EXAMPLES" :key="ex" class="dg-chip dg-chip--code" @click="store.prefs.jql = ex">{{ ex }}</button>
        </div>

        <div v-else class="dg-filters">
          <div class="dg-filters__bar">
            <input v-model="filterQuery" class="dg-search" placeholder="Найти фильтр: название, автор, JQL…" />
            <button class="dg-btn dg-btn--sm" :disabled="store.filtersLoading" title="Перечитать фильтры из Jira" @click="store.loadFilters(true)">
              <ActionIcon name="refresh" :size="14" :class="{ 'dg-spin': store.filtersLoading }" /> Обновить
            </button>
          </div>
          <div v-if="store.filtersError" class="dg-err">Не удалось загрузить фильтры: {{ store.filtersError }}</div>
          <div v-else-if="store.filtersLoading && !store.filters.length" class="dg-muted dg-small">Загрузка фильтров…</div>
          <div v-else-if="!filteredFilters.length" class="dg-muted dg-small">{{ store.filters.length ? 'Ничего не найдено.' : 'Нет доступных фильтров: добавьте фильтры в избранное в Jira или поделитесь ими с командой.' }}</div>
          <button
            v-for="f in filtersPager.items.value" :key="f.id" class="dg-filter"
            :class="{ 'is-on': store.prefs.jql.trim() === filterJql(f) }" :title="filterJql(f)" @click="store.useJql(filterJql(f))"
          >
            <span class="dg-filter__name">
              <ActionIcon v-if="f.favourite" name="star" :size="13" class="dg-filter__star" />
              {{ f.name }}
            </span>
            <span class="dg-filter__kind" :class="f.mine ? 'is-mine' : 'is-team'">{{ filterKind(f) }}</span>
            <span class="dg-filter__owner">{{ f.mine ? '' : f.ownerName ?? '' }}</span>
            <code class="dg-filter__jql">{{ f.jql }}</code>
          </button>
          <WidgetPager :pager="filtersPager" />
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
    <div v-if="store.data?.truncated" class="dg-alert dg-alert--warn"><ActionIcon name="info" :size="15" /> Изменённых задач или задач с worklog больше лимита ({{ store.data.limit ?? store.prefs.limit }}) — загружены самые свежие. Увеличьте «Загружать до» или сузьте период/скоуп.</div>
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
        <div class="dg-stat" :class="{ 'dg-stat--bad': overdueCount(store.data) > 0 }"><span class="dg-stat__label">Просрочено</span><span class="dg-stat__value">{{ overdueCount(store.data) }}</span><span class="dg-stat__hint">открытых со сроком в прошлом</span></div>
        <div class="dg-stat" :class="{ 'dg-stat--alert': noWorklog.length > 0 }"><span class="dg-stat__label">В работе без списаний</span><span class="dg-stat__value">{{ noWorklog.length }}</span><span class="dg-stat__hint">за период</span></div>
        <div v-if="store.prefs.scopeType === 'team'" class="dg-stat" :class="{ 'dg-stat--alert': silentPeople.length > 0 }"><span class="dg-stat__label">Без активности</span><span class="dg-stat__value">{{ silentPeople.length }}</span><span class="dg-stat__hint">из {{ people.length }} участников</span></div>
      </section>

      <!-- Главное -->
      <section class="dg-card dg-highlights">
        <div class="dg-card__head">
          <h2>Главное за период</h2>
          <span v-if="newCount" class="dg-new-pill">{{ newCount }} {{ plural(newCount, 'новое изменение', 'новых изменения', 'новых изменений') }} с прошлого просмотра</span>
        </div>
        <ul class="dg-hl">
          <li v-for="(h, idx) in hl" :key="idx" :class="'tone--' + h.tone"><span class="dg-hl__dot"></span>{{ h.text }}</li>
        </ul>
      </section>

      <div class="dg-row2">
        <!-- Активность по дням -->
        <section class="dg-card dg-activity">
          <div class="dg-card__head">
            <h2>Активность по дням</h2>
            <span class="dg-legend"><i class="lg-changes"></i>изменения <i class="lg-hours"></i>часы</span>
          </div>
          <div class="dg-bars">
            <div v-for="a in activity" :key="a.date" class="dg-bars__col" :title="`${formatRuDate(a.date)}: ${a.changes} изм., ${fmtH(a.hours)} ч`">
              <div class="dg-bars__pair">
                <span class="dg-bars__c" :style="{ height: (a.changes / maxChanges) * 100 + '%' }"></span>
                <span class="dg-bars__h" :style="{ height: (a.hours / maxHours) * 100 + '%' }"></span>
              </div>
              <span class="dg-bars__label" :class="{ 'is-off': [0, 6].includes(parseIsoDate(a.date).getDay()) }">{{ a.date.slice(8, 10) }}</span>
            </div>
          </div>
        </section>

        <!-- По проектам -->
        <section v-if="projects.length > 1" class="dg-card dg-projects-card">
          <h2>По проектам</h2>
          <table class="dg-ptable">
            <thead><tr><th>Проект</th><th>Задач</th><th>Изм.</th><th>Часы</th><th>Тишина</th></tr></thead>
            <tbody>
              <tr v-for="p in projectTablePager.items.value" :key="p.key">
                <td><b>{{ p.key }}</b></td><td>{{ p.updated }}</td><td>{{ p.changes }}</td><td>{{ fmtH(p.hours) }}</td>
                <td :class="{ 'dg-c-warn': p.stale }">{{ p.stale }}</td>
              </tr>
            </tbody>
          </table>
          <WidgetPager :pager="projectTablePager" />
        </section>
      </div>

      <div class="dg-grid">
        <!-- Лента -->
        <section class="dg-card dg-feed">
          <div class="dg-card__head">
            <h2>Лента изменений</h2>
            <input v-model="feedQuery" class="dg-feed-search" placeholder="Задача, человек, статус…" />
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
                <div>
                  <IssueLink :issue-key="e.issueKey" /> <span class="dg-muted dg-ellipsis-inline">{{ e.issueSummary }}</span>
                  <span v-if="isNew(e.created)" class="dg-new">новое</span>
                </div>
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
          <WidgetPager :pager="feedPager" />
        </section>

        <div class="dg-side">
          <!-- Люди -->
          <section class="dg-card">
            <h2>Активность людей</h2>
            <div v-if="!people.length" class="dg-muted dg-small">Нет данных о людях за период.</div>
            <div v-for="p in peoplePager.items.value" :key="p.id" class="dg-person" :class="{ 'is-silent': p.silent }">
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
            <WidgetPager :pager="peoplePager" />
          </section>

          <!-- В работе без списаний -->
          <section class="dg-card">
            <h2>В работе, но без списаний <span v-if="noWorklog.length" class="dg-h-count">{{ noWorklog.length }}</span></h2>
            <div v-if="!noWorklog.length" class="dg-ok"><ActionIcon name="check-circle" :size="15" /> По всем задачам в работе есть списания.</div>
            <div v-for="i in noWorklogPager.items.value" :key="i.key" class="dg-issue">
              <div><IssueLink :issue-key="i.key" /> <span class="dg-cat" :class="catClass(i)">{{ i.status }}</span></div>
              <div class="dg-small dg-ellipsis">{{ i.summary }}</div>
              <div class="dg-small dg-muted">{{ i.assigneeName || 'не назначена' }} · обновлена {{ formatRuDate(i.updated).slice(0, 5) }}</div>
            </div>
            <WidgetPager :pager="noWorklogPager" />
          </section>

          <!-- Просрочено -->
          <section v-if="store.data.overdue?.length" class="dg-card">
            <h2>Просрочено <span class="dg-h-count dg-h-count--bad">{{ overdueCount(store.data) }}</span></h2>
            <div v-for="i in overduePager.items.value" :key="i.key" class="dg-issue">
              <div class="dg-issue__top">
                <span><IssueLink :issue-key="i.key" /> <span class="dg-cat" :class="catClass(i)">{{ i.status }}</span></span>
                <span class="dg-age age--bad">{{ i.dueDate ? daysSince(i.dueDate, store.today) + ' дн.' : '' }}</span>
              </div>
              <div class="dg-small dg-ellipsis">{{ i.summary }}</div>
              <div class="dg-small dg-muted">{{ i.assigneeName || 'не назначена' }} · срок {{ i.dueDate ? formatRuDate(i.dueDate) : '—' }}</div>
            </div>
            <WidgetPager :pager="overduePager" :total="overdueCount(store.data)" />
          </section>

          <!-- Без исполнителя -->
          <section v-if="store.data.unassigned?.length" class="dg-card">
            <h2>Без исполнителя <span class="dg-h-count">{{ unassignedCount(store.data) }}</span></h2>
            <div v-for="i in unassignedPager.items.value" :key="i.key" class="dg-issue">
              <div class="dg-issue__top">
                <span><IssueLink :issue-key="i.key" /> <span class="dg-cat" :class="catClass(i)">{{ i.status }}</span></span>
                <span class="dg-muted dg-small">создана {{ daysSince(i.created, store.today) }} дн. назад</span>
              </div>
              <div class="dg-small dg-ellipsis">{{ i.summary }}</div>
            </div>
            <WidgetPager :pager="unassignedPager" :total="unassignedCount(store.data)" />
          </section>

          <!-- Без движения -->
          <section class="dg-card">
            <h2>Без движения <span v-if="staleSorted.length" class="dg-h-count dg-h-count--warn">{{ staleCount(store.data) }}</span></h2>
            <div v-if="!staleSorted.length" class="dg-ok"><ActionIcon name="check-circle" :size="15" /> Застывших открытых задач нет.</div>
            <div v-for="i in stalePager.items.value" :key="i.key" class="dg-issue">
              <div class="dg-issue__top">
                <span><IssueLink :issue-key="i.key" /> <span class="dg-cat" :class="catClass(i)">{{ i.status }}</span></span>
                <span class="dg-age" :class="ageClass(daysSince(i.updated, store.today))">{{ daysSince(i.updated, store.today) }} дн.</span>
              </div>
              <div class="dg-small dg-ellipsis">{{ i.summary }}</div>
              <div class="dg-small dg-muted">{{ i.assigneeName || 'не назначена' }}<template v-if="i.priority"> · {{ i.priority }}</template></div>
            </div>
            <WidgetPager :pager="stalePager" :total="staleCount(store.data)" />
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
.dg-chips { display: flex; flex-wrap: wrap; gap: 0.375rem; }
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

.dg-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: 0.75rem; }
.dg-stat { display: flex; flex-direction: column; gap: 0.15rem; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.875rem 1rem; box-shadow: var(--shadow); }
/* Подпись, число и пояснение выровнены по строкам во всём ряду плиток, даже если одна подпись перенеслась. */
@supports (grid-template-rows: subgrid) {
  .dg-stat { display: grid; grid-row: span 3; grid-template-rows: subgrid; row-gap: 0.15rem; }
}
.dg-stat--alert { border-color: color-mix(in srgb, var(--warning) 55%, var(--border)); }
.dg-stat--alert .dg-stat__value { color: var(--warning); }
.dg-stat__label { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; line-height: 1.25; }
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
.dg-jql { width: 100%; max-width: 48rem; padding: 0.55rem 0.7rem; font-family: ui-monospace, Consolas, monospace; font-size: 0.8125rem; resize: vertical; }
.dg-chip--code { font-family: ui-monospace, Consolas, monospace; font-size: 0.75rem; }
.dg-stat--bad { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); }
.dg-stat--bad .dg-stat__value { color: var(--danger); }
.dg-highlights { padding-bottom: 0.75rem; }
.dg-hl { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr)); gap: 0.4rem 1.5rem; }
.dg-hl li { display: flex; gap: 0.55rem; align-items: baseline; font-size: 0.875rem; line-height: 1.4; }
.dg-hl__dot { flex: 0 0 auto; width: 0.5rem; height: 0.5rem; border-radius: 999px; background: var(--muted); transform: translateY(-1px); }
.tone--good .dg-hl__dot { background: var(--success); }
.tone--warn .dg-hl__dot { background: var(--warning); }
.tone--bad .dg-hl__dot { background: var(--danger); }
.tone--info .dg-hl__dot { background: var(--primary); }
.dg-new-pill { font-size: 0.75rem; font-weight: 700; color: var(--primary-strong); background: var(--chip); padding: 0.2rem 0.6rem; border-radius: 999px; }
.dg-new { font-size: 0.625rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; background: var(--primary); border-radius: 999px; padding: 0.05rem 0.4rem; margin-left: 0.3rem; vertical-align: 1px; }
.dg-row2 { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: stretch; }
.dg-legend { display: inline-flex; gap: 0.4rem; align-items: center; font-size: 0.75rem; color: var(--muted); }
.dg-legend i { display: inline-block; width: 0.625rem; height: 0.625rem; border-radius: 2px; margin-left: 0.4rem; }
.lg-changes { background: var(--primary); }
.lg-hours { background: var(--success); }
.dg-bars { display: flex; gap: 0.25rem; align-items: flex-end; height: 7.5rem; }
.dg-bars__col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 0.25rem; height: 100%; min-width: 0; }
.dg-bars__pair { flex: 1; width: 100%; display: flex; gap: 2px; align-items: flex-end; justify-content: center; }
.dg-bars__c, .dg-bars__h { width: 40%; max-width: 0.875rem; border-radius: 3px 3px 0 0; min-height: 2px; transition: height 200ms ease; }
.dg-bars__c { background: var(--primary); }
.dg-bars__h { background: var(--success); }
.dg-bars__label { font-size: 0.6875rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.dg-bars__label.is-off { opacity: 0.5; }
.dg-ptable { border-collapse: collapse; font-size: 0.8125rem; min-width: 18rem; }
.dg-ptable th { text-align: left; color: var(--muted); font-weight: 600; padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border); }
.dg-ptable td { padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.dg-c-warn { color: var(--warning); font-weight: 700; }
.dg-feed-search { margin-left: auto; width: 14rem; padding: 0.35rem 0.6rem; font-size: 0.8125rem; }

/* v1.0.10: подсказки проектов, JQL-библиотека, фильтры Jira, счётчики в заголовках */
.dg-btn--sm { padding: 0.35rem 0.7rem; font-size: 0.8125rem; }
.dg-input { padding: 0.4rem 0.6rem; font-size: 0.8125rem; min-width: 0; }
.dg-popular { display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; }
.dg-popular__label { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.75rem; font-weight: 600; color: var(--muted); margin-right: 0.25rem; }
.dg-popular__label :deep(svg) { color: var(--warning); }
.dg-chip--popular { display: inline-flex; align-items: baseline; gap: 0.4rem; }
.dg-chip__name { max-width: 10rem; overflow: hidden; text-overflow: ellipsis; }
.dg-chip__meta { font-size: 0.6875rem; font-variant-numeric: tabular-nums; opacity: 0.8; }
.dg-jql-row { display: flex; gap: 0.75rem; align-items: flex-start; flex-wrap: wrap; }
.dg-jql-row .dg-jql { flex: 1 1 28rem; }
.dg-jql-save { display: flex; flex-direction: column; gap: 0.375rem; width: 14rem; }
.dg-jql-tabs { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.dg-count { display: inline-block; min-width: 1.1rem; margin-left: 0.25rem; padding: 0 0.3rem; border-radius: 999px; background: var(--chip); font-size: 0.6875rem; font-variant-numeric: tabular-nums; color: var(--muted); }
.dg-seg__btn.is-on .dg-count { background: var(--primary-soft); color: var(--primary); }
.dg-chip--saved { display: inline-flex; align-items: center; gap: 0.15rem; padding: 0 0.25rem 0 0; }
.dg-chip__main { border: none; background: transparent; color: inherit; padding: 0.3rem 0.25rem 0.3rem 0.75rem; font-size: inherit; max-width: 16rem; overflow: hidden; text-overflow: ellipsis; }
.dg-chip__x { display: inline-flex; border: none; background: transparent; color: inherit; opacity: 0.55; padding: 0.2rem; border-radius: 999px; }
.dg-chip__x:hover { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
.dg-filters { display: flex; flex-direction: column; gap: 0.25rem; }
.dg-filters__bar { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.25rem; }
.dg-filter {
  display: grid; grid-template-columns: minmax(0, 16rem) 5rem minmax(0, 9rem) minmax(0, 1fr); gap: 0.75rem; align-items: center;
  width: 100%; text-align: left; padding: 0.4rem 0.6rem; border: 1px solid transparent; border-radius: 0.375rem;
  background: transparent; color: var(--fg); font-size: 0.8125rem;
}
.dg-filter:hover { background: var(--chip); }
.dg-filter.is-on { border-color: var(--primary); background: var(--primary-soft); }
.dg-filter__name { display: inline-flex; align-items: center; gap: 0.3rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dg-filter__star { color: var(--warning); flex: none; }
.dg-filter__kind { justify-self: start; font-size: 0.6875rem; font-weight: 700; padding: 0.05rem 0.45rem; border-radius: 999px; }
.dg-filter__kind.is-mine { background: var(--primary-soft); color: var(--primary); }
.dg-filter__kind.is-team { background: var(--color-success-bg); color: var(--success); }
.dg-filter__owner { color: var(--muted); font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dg-filter__jql { font-size: 0.75rem; color: var(--muted); background: none; padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dg-h-count { display: inline-block; margin-left: 0.35rem; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--chip); color: var(--muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; vertical-align: 1px; }
.dg-h-count--warn { background: var(--amber-bg); color: var(--amber-fg); }
.dg-h-count--bad { background: var(--color-danger-bg); color: var(--danger); }
@media (max-width: 72rem) { .dg-row2 { grid-template-columns: 1fr; } }
</style>
