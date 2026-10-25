<script setup lang="ts">
// Экран «Команда»: worklog коллег за период, проверка заполнения и индикация ошибок.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import ActionIcon from '../components/ActionIcon.vue';
import DatePicker from '../components/DatePicker.vue';
import { useTeamStore, PERIOD_PRESETS, type TeamMember } from '../store/team';
import { tauriApi, type JiraUserDto } from '../lib/tauriApi';
import { formatRuDate, parseIsoDate } from '../utils/time';
import { ISSUE_LABELS, unfilledReportText, type CheckIssue, type DayCell, type Severity } from '../utils/worklogChecks';

const team = useTeamStore();

const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const dayHead = (iso: string) => ({ wd: WD[parseIsoDate(iso).getDay()], d: Number(iso.slice(8, 10)) });
const fmtH = (h: number) => (Math.round(h * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

// ── Команды ─────────────────────────────────────────────────────────
const newTeamName = ref('');
const creatingTeam = ref(false);
const renaming = ref(false);
const renameValue = ref('');

function createTeam() {
  const name = newTeamName.value.trim();
  if (!name) return;
  team.createTeam(name);
  newTeamName.value = '';
  creatingTeam.value = false;
}
function startRename() {
  if (!team.activeTeam) return;
  renameValue.value = team.activeTeam.name;
  renaming.value = true;
}
function commitRename() {
  if (team.activeTeam) team.renameTeam(team.activeTeam.id, renameValue.value);
  renaming.value = false;
}
function deleteTeam() {
  if (!team.activeTeam) return;
  if (!confirm(`Удалить команду «${team.activeTeam.name}»? Участники из Jira не удаляются.`)) return;
  team.deleteTeam(team.activeTeam.id);
}

// ── Поиск участников ────────────────────────────────────────────────
const userQuery = ref('');
const userResults = ref<JiraUserDto[]>([]);
const userSearching = ref(false);
const userSearchError = ref('');
const dropdownOpen = ref(false);
// blur срабатывает раньше click по пункту списка — закрываем с небольшой задержкой.
function closeDropdownSoon() { window.setTimeout(() => { dropdownOpen.value = false; }, 150); }

async function addMe() {
  userSearchError.value = '';
  try {
    await team.addMe();
  } catch (e) {
    dropdownOpen.value = true;
    userSearchError.value = e instanceof Error ? e.message : String(e);
  }
}
let userTimer: number | null = null;

watch(userQuery, (q) => {
  if (userTimer) window.clearTimeout(userTimer);
  userSearchError.value = '';
  if (q.trim().length < 2) { userResults.value = []; return; }
  userTimer = window.setTimeout(async () => {
    userSearching.value = true;
    try {
      const res = await team.searchUsers(q);
      if (userQuery.value === q) userResults.value = res;
    } catch (e) {
      userSearchError.value = e instanceof Error ? e.message : String(e);
    } finally {
      userSearching.value = false;
    }
  }, 300);
});

const memberIds = computed(() => new Set((team.activeTeam?.members ?? []).map((m) => m.id.toLowerCase())));

function addUser(u: JiraUserDto) {
  team.addMember(u);
  userQuery.value = '';
  userResults.value = [];
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
}
// Стабильный оттенок аватара по id участника.
function avatarHue(id: string) {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return Math.round((h * 137.508) % 360); // «золотой угол» — соседние id получают далёкие оттенки
}

// ── Период ──────────────────────────────────────────────────────────
const customFrom = ref(team.from);
const customTo = ref(team.to);
watch(() => [team.from, team.to], ([f, t]) => { customFrom.value = f; customTo.value = t; });

function applyCustom() {
  if (customFrom.value && customTo.value && customFrom.value <= customTo.value) {
    team.setCustomPeriod(customFrom.value, customTo.value);
  }
}

const periodLabel = computed(() => `${formatRuDate(team.from)} — ${formatRuDate(team.to)}`);

// Автозагрузка при смене команды/состава/периода.
watch(
  () => [team.activeTeam?.id, team.activeTeam?.members.map((m) => m.id).join(','), team.from, team.to],
  () => { team.load(); },
);
// Esc (глобальный обработчик useHotkeys) закрывает карточку дня.
const closeDetail = () => { detail.value = null; };
onMounted(() => {
  team.load();
  document.addEventListener('jiratime:close-active-dialog', closeDetail);
});
onBeforeUnmount(() => document.removeEventListener('jiratime:close-active-dialog', closeDetail));

// ── Фильтр проблем ──────────────────────────────────────────────────
const severityFilter = ref<Severity | 'all'>('all');
const allIssues = computed(() =>
  team.reports.flatMap((r) => r.issues.map((i) => ({ ...i, member: r.member })))
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.date.localeCompare(b.date)),
);
const visibleIssues = computed(() =>
  severityFilter.value === 'all' ? allIssues.value : allIssues.value.filter((i) => i.severity === severityFilter.value),
);
function sevRank(s: Severity) { return s === 'error' ? 0 : s === 'warning' ? 1 : 2; }

// ── Детали дня ──────────────────────────────────────────────────────
const detail = ref<{ member: TeamMember; cell: DayCell } | null>(null);
function openCell(member: TeamMember, cell: DayCell) {
  if (cell.worklogs.length === 0 && cell.issues.length === 0) return;
  detail.value = { member, cell };
}
function openIssue(issue: CheckIssue & { member: TeamMember }) {
  const report = team.reports.find((r) => r.member.id === issue.member.id);
  const cell = report?.days.find((d) => d.date === issue.date);
  if (cell) detail.value = { member: issue.member, cell };
}
const detailFlagged = computed(() => new Set(detail.value?.cell.issues.flatMap((i) => i.worklogIds) ?? []));

function cellTitle(cell: DayCell): string {
  const lines = [`${formatRuDate(cell.date)}: ${fmtH(cell.hours)} ч`];
  for (const i of cell.issues) lines.push(`• ${ISSUE_LABELS[i.code]}: ${i.message}`);
  return lines.join('\n');
}
const fillClass = (fill: number) => (fill >= 0.98 ? 'fill--ok' : fill >= 0.75 ? 'fill--warn' : 'fill--bad');

// ── Сводка в буфер обмена (для чата команды) ───────────────────────
const copied = ref(false);
const copiedUnfilled = ref(false);
async function copyUnfilled() {
  const text = unfilledReportText(team.reports, `«${team.activeTeam?.name ?? ''}», ${periodLabel.value}`, team.checkOptions);
  try {
    await navigator.clipboard.writeText(text);
    copiedUnfilled.value = true;
    window.setTimeout(() => { copiedUnfilled.value = false; }, 2000);
  } catch {
    alert(text);
  }
}
async function copySummary() {
  const lines = [`Worklog «${team.activeTeam?.name ?? ''}» за ${periodLabel.value}`];
  for (const r of team.reports) {
    const pct = r.expectedHours ? Math.round((r.totalHours / r.expectedHours) * 100) : 100;
    lines.push(`${pct >= 98 ? '✅' : pct >= 75 ? '🟡' : '🔴'} ${r.member.displayName}: ${fmtH(r.totalHours)} из ${fmtH(r.expectedHours)} ч (${pct}%)`);
    const missing = r.issues.filter((i) => i.code === 'missing').map((i) => formatRuDate(i.date).slice(0, 5));
    if (missing.length) lines.push(`   не заполнено: ${missing.join(', ')}`);
    for (const i of r.issues.filter((x) => x.severity === 'error' && x.code !== 'missing')) {
      lines.push(`   ${formatRuDate(i.date).slice(0, 5)} — ${ISSUE_LABELS[i.code].toLowerCase()}: ${i.message}`);
    }
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    alert(lines.join('\n'));
  }
}

// ── Экспорт ─────────────────────────────────────────────────────────
async function exportCsv() {
  const head = ['Участник', ...team.dates.map((d) => formatRuDate(d)), 'Итого', 'Норма', 'Ошибок', 'Предупреждений'];
  const lines = [head.join(';')];
  for (const r of team.reports) {
    lines.push([
      `"${r.member.displayName.replaceAll('"', '""')}"`,
      ...r.days.map((d) => (d.hours ? fmtH(d.hours) : '')),
      fmtH(r.totalHours),
      fmtH(r.expectedHours),
      r.issues.filter((i) => i.severity === 'error').length,
      r.issues.filter((i) => i.severity === 'warning').length,
    ].join(';'));
  }
  lines.push('', ['Участник', 'Дата', 'Проблема', 'Подробности'].join(';'));
  for (const i of allIssues.value) {
    lines.push([`"${i.member.displayName}"`, formatRuDate(i.date), ISSUE_LABELS[i.code], `"${i.message.replaceAll('"', '""')}"`].join(';'));
  }
  const path = await save({
    title: 'Сохранить отчёт команды',
    defaultPath: `team_${team.from}_${team.to}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (path) await tauriApi.writeExportFileUtf8Bom(path, lines.join('\r\n'));
}
</script>

<template>
  <div class="tm">
    <header class="tm-header">
      <div>
        <h1>Команда</h1>
        <p class="tm-sub">Worklog коллег за период и проверка корректности заполнения</p>
      </div>
      <div class="tm-header__actions">
        <span v-if="team.loadedAt" class="tm-muted">Обновлено {{ new Date(team.loadedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) }}</span>
        <button class="tm-btn" :disabled="team.loading || !team.activeTeam?.members.length" @click="team.load()">
          <ActionIcon name="refresh" :size="15" :class="{ 'tm-spin': team.loading }" /> Обновить
        </button>
        <button class="tm-btn" :disabled="!team.reports.length" :title="copied ? 'Скопировано' : 'Текстовая сводка для мессенджера'" @click="copySummary">
          <ActionIcon :name="copied ? 'check-circle' : 'duplicate'" :size="15" /> {{ copied ? 'Скопировано' : 'Копировать сводку' }}
        </button>
        <button class="tm-btn" :disabled="!team.reports.length" title="Кто и какие дни периода не заполнил — текст для командного чата" @click="copyUnfilled">
          <ActionIcon :name="copiedUnfilled ? 'check-circle' : 'warning'" :size="15" /> {{ copiedUnfilled ? 'Скопировано' : 'Копировать незаполненное' }}
        </button>
        <button class="tm-btn tm-btn--primary" :disabled="!team.reports.length" @click="exportCsv">
          <ActionIcon name="download" :size="15" /> Экспорт CSV
        </button>
      </div>
    </header>

    <!-- Команды-пресеты -->
    <section class="tm-card tm-teams">
      <div class="tm-teams__row">
        <div class="tm-tabs" role="tablist">
          <button
            v-for="t in team.teams" :key="t.id" role="tab"
            class="tm-tab" :class="{ 'tm-tab--active': team.activeTeam?.id === t.id }"
            @click="team.selectTeam(t.id)"
          >
            {{ t.name }} <span class="tm-tab__count">{{ t.members.length }}</span>
          </button>
          <form v-if="creatingTeam" class="tm-inline-form" @submit.prevent="createTeam">
            <input v-model="newTeamName" class="tm-input tm-input--sm" placeholder="Название команды" autofocus @keyup.escape="creatingTeam = false" />
            <button class="tm-btn tm-btn--sm tm-btn--primary" type="submit">Создать</button>
          </form>
          <button v-else class="tm-tab tm-tab--add" @click="creatingTeam = true">+ Команда</button>
        </div>
        <div v-if="team.activeTeam" class="tm-teams__tools">
          <form v-if="renaming" class="tm-inline-form" @submit.prevent="commitRename">
            <input v-model="renameValue" class="tm-input tm-input--sm" autofocus @keyup.escape="renaming = false" />
            <button class="tm-btn tm-btn--sm" type="submit">OK</button>
          </form>
          <template v-else>
            <button class="tm-icon" title="Переименовать" @click="startRename"><ActionIcon name="edit" :size="15" /></button>
            <button class="tm-icon tm-icon--danger" title="Удалить команду" @click="deleteTeam"><ActionIcon name="trash" :size="15" /></button>
          </template>
        </div>
      </div>

      <div class="tm-members">
        <span v-for="m in team.activeTeam?.members ?? []" :key="m.id" class="tm-member" :title="m.email || m.id">
          <span class="tm-avatar tm-avatar--sm" :style="{ '--h': avatarHue(m.id) }">{{ initials(m.displayName) }}</span>
          {{ m.displayName }}
          <button class="tm-member__x" title="Убрать из команды" @click="team.removeMember(m.id)"><ActionIcon name="close" :size="12" /></button>
        </span>
        <div class="tm-search">
          <ActionIcon name="search" :size="14" class="tm-search__icon" />
          <input
            v-model="userQuery" class="tm-input tm-search__input" placeholder="Добавить участника: имя, логин или e-mail"
            @focus="dropdownOpen = true" @input="dropdownOpen = true" @blur="closeDropdownSoon" @keyup.escape="dropdownOpen = false"
          />
          <div v-if="dropdownOpen && (userQuery.trim().length >= 2 || userSearchError)" class="tm-dropdown">
            <div v-if="userSearchError" class="tm-dropdown__hint tm-dropdown__hint--error">{{ userSearchError }}</div>
            <div v-else-if="userSearching" class="tm-dropdown__hint">Поиск…</div>
            <div v-else-if="userResults.length === 0" class="tm-dropdown__hint">Никого не нашли</div>
            <button
              v-for="u in userResults" v-else :key="u.id" class="tm-dropdown__item"
              :disabled="memberIds.has(u.id.toLowerCase())" @click="addUser(u)"
            >
              <span class="tm-avatar tm-avatar--sm" :style="{ '--h': avatarHue(u.id) }">{{ initials(u.displayName) }}</span>
              <span class="tm-dropdown__name">{{ u.displayName }}<small>{{ u.email || u.id }}</small></span>
              <span v-if="memberIds.has(u.id.toLowerCase())" class="tm-muted">в команде</span>
              <span v-else-if="!u.active" class="tm-muted">неактивен</span>
            </button>
          </div>
        </div>
        <button class="tm-btn tm-btn--sm" title="Добавить себя (текущий пользователь Jira)" @click="addMe">+ Я</button>
      </div>
    </section>

    <!-- Период -->
    <section class="tm-period">
      <div class="tm-seg" role="group" aria-label="Период">
        <button
          v-for="p in PERIOD_PRESETS" :key="p.id" class="tm-seg__btn"
          :class="{ 'tm-seg__btn--active': team.periodPreset === p.id }"
          @click="team.setPeriodPreset(p.id)"
        >{{ p.label }}</button>
      </div>
      <div class="tm-period__nav">
        <button class="tm-icon" title="Предыдущий период" @click="team.shiftPeriod(-1)"><ActionIcon name="chevron-left" :size="16" /></button>
        <template v-if="team.periodPreset === 'custom'">
          <DatePicker v-model="customFrom" class="tm-date" @update:model-value="applyCustom" />
          <span class="tm-muted">—</span>
          <DatePicker v-model="customTo" class="tm-date" @update:model-value="applyCustom" />
        </template>
        <span v-else class="tm-period__label">{{ periodLabel }}</span>
        <button class="tm-icon" title="Следующий период" @click="team.shiftPeriod(1)"><ActionIcon name="chevron-right" :size="16" /></button>
      </div>
    </section>

    <div v-if="team.error" class="tm-alert tm-alert--error"><ActionIcon name="warning" :size="15" /> {{ team.error }}</div>
    <div v-for="w in team.warnings" :key="w" class="tm-alert tm-alert--warn"><ActionIcon name="info" :size="15" /> {{ w }}</div>

    <!-- Пустые состояния -->
    <div v-if="!team.activeTeam" class="tm-empty">
      <div class="tm-empty__icon"><ActionIcon name="sparkles" :size="28" /></div>
      <h2>Соберите свою команду</h2>
      <p>Создайте команду и добавьте коллег — увидите их worklog за неделю или месяц, незаполненные дни, переработки, дубли и пересечения.</p>
      <button class="tm-btn tm-btn--primary" @click="creatingTeam = true">+ Создать команду</button>
    </div>
    <div v-else-if="!team.activeTeam.members.length" class="tm-empty">
      <h2>В команде пока никого</h2>
      <p>Найдите коллег по имени или логину в поле «Добавить участника».</p>
    </div>

    <template v-else>
      <!-- Сводка -->
      <section class="tm-stats">
        <div class="tm-stat">
          <span class="tm-stat__label">Списано</span>
          <span class="tm-stat__value">{{ fmtH(team.summary.totalHours) }} <small>ч</small></span>
          <span class="tm-stat__hint">норма {{ fmtH(team.summary.expectedHours) }} ч на сегодня</span>
        </div>
        <div class="tm-stat">
          <span class="tm-stat__label">Заполнение</span>
          <span class="tm-stat__value" :class="fillClass(team.summary.expectedHours ? team.summary.totalHours / team.summary.expectedHours : 1)">
            {{ team.summary.expectedHours ? Math.round((team.summary.totalHours / team.summary.expectedHours) * 100) : 100 }}<small>%</small>
          </span>
          <span class="tm-stat__hint">{{ team.reports.length }} участн.</span>
        </div>
        <button class="tm-stat tm-stat--btn" :class="{ 'tm-stat--sel': severityFilter === 'error' }" @click="severityFilter = severityFilter === 'error' ? 'all' : 'error'">
          <span class="tm-stat__label">Ошибки</span>
          <span class="tm-stat__value tm-c-error">{{ team.summary.errors }}</span>
          <span class="tm-stat__hint">пропуски, дубли, аномалии</span>
        </button>
        <button class="tm-stat tm-stat--btn" :class="{ 'tm-stat--sel': severityFilter === 'warning' }" @click="severityFilter = severityFilter === 'warning' ? 'all' : 'warning'">
          <span class="tm-stat__label">Предупреждения</span>
          <span class="tm-stat__value tm-c-warn">{{ team.summary.warnings }}</span>
          <span class="tm-stat__hint">недо- и переработки, пересечения</span>
        </button>
      </section>

      <!-- Матрица участник × день -->
      <section class="tm-card tm-matrix-card">
        <div class="tm-matrix-wrap" :class="{ 'tm-loading': team.loading }">
          <table class="tm-matrix">
            <thead>
              <tr>
                <th class="tm-matrix__who">Участник</th>
                <th
                  v-for="d in team.dates" :key="d" class="tm-matrix__day"
                  :class="{ 'is-off': !team.checkOptions.workdays.includes(parseIsoDate(d).getDay()) || team.checkOptions.holidays.has(d), 'is-today': d === team.checkOptions.today }"
                >
                  <span>{{ dayHead(d).wd }}</span><b>{{ dayHead(d).d }}</b>
                </th>
                <th class="tm-matrix__total">Итого</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in team.reports" :key="r.member.id">
                <td class="tm-matrix__who">
                  <div class="tm-who">
                    <span class="tm-avatar" :style="{ '--h': avatarHue(r.member.id) }">{{ initials(r.member.displayName) }}</span>
                    <div class="tm-who__text">
                      <span class="tm-who__name">{{ r.member.displayName }}</span>
                      <span class="tm-bar"><span class="tm-bar__fill" :class="fillClass(r.fill)" :style="{ width: Math.min(100, r.fill * 100) + '%' }"></span></span>
                    </div>
                  </div>
                </td>
                <td v-for="c in r.days" :key="c.date" class="tm-cell-td">
                  <button
                    class="tm-cell" :class="'tm-cell--' + c.status" :title="cellTitle(c)"
                    :disabled="!c.worklogs.length && !c.issues.length"
                    @click="openCell(r.member, c)"
                  >
                    <span v-if="c.hours">{{ fmtH(c.hours) }}</span>
                    <span v-else-if="c.status === 'missing'">0</span>
                    <i v-if="c.issues.some((i) => i.severity !== 'info' && i.code !== 'missing' && i.code !== 'under')" class="tm-cell__flag"></i>
                  </button>
                </td>
                <td class="tm-matrix__total">
                  <b>{{ fmtH(r.totalHours) }}</b>
                  <small>/ {{ fmtH(r.expectedHours) }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="tm-legend">
          <span><i class="tm-cell--ok"></i>норма</span>
          <span><i class="tm-cell--under"></i>меньше нормы</span>
          <span><i class="tm-cell--over"></i>переработка</span>
          <span><i class="tm-cell--missing"></i>нет записей</span>
          <span><i class="tm-cell--error"></i>ошибка</span>
          <span><i class="tm-cell--off-logged"></i>выходной с записями</span>
        </div>
      </section>

      <!-- Список проблем -->
      <section class="tm-card">
        <div class="tm-issues__head">
          <h2>Проверка заполнения</h2>
          <div class="tm-seg tm-seg--sm">
            <button class="tm-seg__btn" :class="{ 'tm-seg__btn--active': severityFilter === 'all' }" @click="severityFilter = 'all'">Все {{ allIssues.length }}</button>
            <button class="tm-seg__btn" :class="{ 'tm-seg__btn--active': severityFilter === 'error' }" @click="severityFilter = 'error'">Ошибки {{ team.summary.errors }}</button>
            <button class="tm-seg__btn" :class="{ 'tm-seg__btn--active': severityFilter === 'warning' }" @click="severityFilter = 'warning'">Предупр. {{ team.summary.warnings }}</button>
            <button class="tm-seg__btn" :class="{ 'tm-seg__btn--active': severityFilter === 'info' }" @click="severityFilter = 'info'">Инфо {{ team.summary.infos }}</button>
          </div>
        </div>
        <div v-if="!visibleIssues.length" class="tm-ok">
          <ActionIcon name="check-circle" :size="18" /> Замечаний нет — всё заполнено корректно.
        </div>
        <ul v-else class="tm-issues">
          <li v-for="(i, idx) in visibleIssues.slice(0, 300)" :key="idx" class="tm-issue" @click="openIssue(i)">
            <span class="tm-sev" :class="'tm-sev--' + i.severity"></span>
            <span class="tm-issue__date">{{ formatRuDate(i.date) }}</span>
            <span class="tm-issue__who">{{ i.member.displayName }}</span>
            <span class="tm-issue__code">{{ ISSUE_LABELS[i.code] }}</span>
            <span class="tm-issue__msg">{{ i.message }}</span>
          </li>
        </ul>
      </section>
    </template>

    <!-- Детали дня -->
    <div v-if="detail" class="tm-overlay" @click.self="detail = null">
      <div class="tm-modal" role="dialog" aria-modal="true">
        <header class="tm-modal__head">
          <div>
            <h2>{{ detail.member.displayName }}</h2>
            <span class="tm-muted">{{ formatRuDate(detail.cell.date) }} · {{ dayHead(detail.cell.date).wd }} · {{ fmtH(detail.cell.hours) }} ч</span>
          </div>
          <button class="tm-icon" title="Закрыть" @click="detail = null"><ActionIcon name="close" :size="16" /></button>
        </header>
        <div v-if="detail.cell.issues.length" class="tm-modal__issues">
          <div v-for="(i, idx) in detail.cell.issues" :key="idx" class="tm-chip" :class="'tm-chip--' + i.severity">
            <b>{{ ISSUE_LABELS[i.code] }}</b> {{ i.message }}
          </div>
        </div>
        <table v-if="detail.cell.worklogs.length" class="tm-wl">
          <thead><tr><th>Время</th><th>Задача</th><th class="num">Часы</th><th>Описание</th></tr></thead>
          <tbody>
            <tr v-for="w in [...detail.cell.worklogs].sort((a, b) => a.started.localeCompare(b.started))" :key="w.id" :class="{ 'is-flagged': detailFlagged.has(w.id) }">
              <td class="mono">{{ w.started.slice(11, 16) }}</td>
              <td>
                <b>{{ w.issueKey }}</b>
                <small v-if="w.issueSummary">{{ w.issueSummary }}</small>
              </td>
              <td class="num">{{ fmtH(w.timeSpentSeconds / 3600) }}</td>
              <td :class="{ 'tm-muted': !w.comment }">{{ w.comment || 'без описания' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="tm-muted">Записей нет.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tm { padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; max-width: 110rem; }
.tm-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.tm-header h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.01em; }
.tm-sub { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.875rem; }
.tm-header__actions { display: flex; align-items: center; gap: 0.5rem; }
.tm-muted { color: var(--muted); font-size: 0.8125rem; }

.tm-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 1rem 1.125rem; }

.tm-btn {
  display: inline-flex; align-items: center; gap: 0.4rem; border: 1px solid var(--border);
  background: var(--card); color: var(--fg); border-radius: 0.5rem; padding: 0.5rem 0.875rem;
  font-weight: 600; font-size: 0.875rem; transition: background 120ms ease, border-color 120ms ease;
}
.tm-btn:hover:not(:disabled) { background: var(--chip); }
.tm-btn--primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.tm-btn--primary:hover:not(:disabled) { background: var(--primary-hover); }
.tm-btn--sm { padding: 0.3rem 0.625rem; font-size: 0.8125rem; }
.tm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.tm-icon { display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border-radius: 0.5rem; border: none; background: transparent; color: var(--muted); }
.tm-icon:hover { background: var(--chip); color: var(--fg); }
.tm-icon--danger:hover { background: var(--color-danger-bg); color: var(--danger); }
.tm-spin { animation: tm-spin 0.9s linear infinite; }
@keyframes tm-spin { to { transform: rotate(360deg); } }

.tm-input { padding: 0.45rem 0.65rem; font-size: 0.875rem; }
.tm-input--sm { padding: 0.3rem 0.55rem; font-size: 0.8125rem; width: 12rem; }
.tm-inline-form { display: inline-flex; gap: 0.375rem; align-items: center; }

/* Команды */
.tm-teams { display: flex; flex-direction: column; gap: 0.875rem; }
.tm-teams__row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.tm-teams__tools { display: flex; gap: 0.25rem; }
.tm-tabs { display: flex; gap: 0.375rem; flex-wrap: wrap; align-items: center; }
.tm-tab {
  border: 1px solid var(--border); background: transparent; color: var(--fg); border-radius: 999px;
  padding: 0.35rem 0.85rem; font-size: 0.8125rem; font-weight: 600; display: inline-flex; gap: 0.4rem; align-items: center;
}
.tm-tab:hover { background: var(--chip); }
.tm-tab--active { background: var(--primary); border-color: var(--primary); color: #fff; }
.tm-tab--active:hover { background: var(--primary-hover); }
.tm-tab__count { font-size: 0.6875rem; padding: 0 0.4rem; border-radius: 999px; background: color-mix(in srgb, currentColor 16%, transparent); }
.tm-tab--add { border-style: dashed; color: var(--muted); }

.tm-members { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.tm-member {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0.3rem 0.2rem 0.25rem;
  border-radius: 999px; background: var(--surface-sunken); border: 1px solid var(--border); font-size: 0.8125rem;
}
.tm-member__x { border: none; background: transparent; color: var(--muted); display: inline-flex; padding: 0.15rem; border-radius: 999px; }
.tm-member__x:hover { background: var(--color-danger-bg); color: var(--danger); }

.tm-avatar {
  --h: 220;
  flex: 0 0 auto; width: 2rem; height: 2rem; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 0.75rem; font-weight: 700;
  color: hsl(var(--h) 60% var(--avatar-fg-l)); background: hsl(var(--h) 70% 55% / 0.2);
}
.tm-avatar--sm { width: 1.5rem; height: 1.5rem; font-size: 0.625rem; }

.tm-search { position: relative; flex: 1 1 16rem; min-width: 14rem; }
.tm-search__icon { position: absolute; left: 0.6rem; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.tm-search__input { width: 100%; padding-left: 2rem; }
.tm-dropdown {
  position: absolute; z-index: 20; top: calc(100% + 0.25rem); left: 0; right: 0; max-height: 18rem; overflow: auto;
  background: var(--card); border: 1px solid var(--border); border-radius: 0.625rem; box-shadow: var(--shadow); padding: 0.25rem;
}
.tm-dropdown__hint { padding: 0.6rem 0.75rem; color: var(--muted); font-size: 0.8125rem; }
.tm-dropdown__hint--error { color: var(--danger); }
.tm-dropdown__item {
  display: flex; align-items: center; gap: 0.6rem; width: 100%; text-align: left; border: none; background: transparent;
  color: var(--fg); padding: 0.45rem 0.6rem; border-radius: 0.5rem;
}
.tm-dropdown__item:hover:not(:disabled) { background: var(--chip); }
.tm-dropdown__item:disabled { opacity: 0.6; cursor: default; }
.tm-dropdown__name { flex: 1; display: flex; flex-direction: column; font-size: 0.875rem; }
.tm-dropdown__name small { color: var(--muted); font-size: 0.75rem; }

/* Период */
.tm-period { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.tm-period__nav { display: flex; align-items: center; gap: 0.375rem; }
.tm-period__label { font-weight: 600; font-variant-numeric: tabular-nums; min-width: 12rem; text-align: center; }
.tm-date { width: 9.5rem; }
.tm-seg { display: inline-flex; padding: 0.2rem; border-radius: 0.625rem; background: var(--chip); gap: 0.125rem; flex-wrap: wrap; }
.tm-seg__btn { border: none; background: transparent; color: var(--muted); font-weight: 600; font-size: 0.8125rem; padding: 0.35rem 0.75rem; border-radius: 0.5rem; }
.tm-seg__btn:hover { color: var(--fg); }
.tm-seg__btn--active { background: var(--card); color: var(--fg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.tm-seg--sm .tm-seg__btn { padding: 0.25rem 0.6rem; font-size: 0.75rem; }

.tm-alert { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0.875rem; border-radius: 0.5rem; font-size: 0.875rem; }
.tm-alert--error { background: var(--color-danger-bg); color: var(--danger); }
.tm-alert--warn { background: var(--amber-bg); color: var(--amber-fg); border: 1px solid var(--amber-border); }

.tm-empty { text-align: center; padding: 3rem 1rem; border: 1px dashed var(--border); border-radius: var(--radius); background: var(--card); }
.tm-empty h2 { margin: 0.5rem 0; font-size: 1.125rem; }
.tm-empty p { color: var(--muted); max-width: 32rem; margin: 0 auto 1rem; }
.tm-empty__icon { display: inline-flex; padding: 0.75rem; border-radius: 999px; background: var(--chip); color: var(--primary); }

/* Сводка */
.tm-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.75rem; }
.tm-stat {
  display: flex; flex-direction: column; gap: 0.15rem; text-align: left; background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 0.875rem 1rem; box-shadow: var(--shadow); color: var(--fg);
}
.tm-stat--btn { cursor: pointer; transition: border-color 120ms ease, transform 120ms ease; }
.tm-stat--btn:hover { border-color: var(--primary); }
.tm-stat--sel { border-color: var(--primary); box-shadow: var(--focus-ring); }
.tm-stat__label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
.tm-stat__value { font-size: 1.625rem; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.tm-stat__value small { font-size: 0.875rem; color: var(--muted); font-weight: 600; margin-left: 0.15rem; }
.tm-stat__hint { font-size: 0.75rem; color: var(--muted); }
.tm-c-error { color: var(--danger); }
.tm-c-warn { color: var(--warning); }
.fill--ok { color: var(--success); }
.fill--warn { color: var(--warning); }
.fill--bad { color: var(--danger); }

/* Матрица */
.tm-matrix-card { padding: 0; overflow: hidden; }
.tm-matrix-wrap { overflow: auto; transition: opacity 150ms ease; }
.tm-loading { opacity: 0.55; pointer-events: none; }
.tm-matrix { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 0.8125rem; }
.tm-matrix th { position: sticky; top: 0; background: var(--card); z-index: 2; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--border); }
.tm-matrix__who { position: sticky; left: 0; z-index: 3; background: var(--card); text-align: left; padding: 0.5rem 0.875rem; min-width: 14rem; border-right: 1px solid var(--border); }
.tm-matrix tbody .tm-matrix__who { z-index: 1; }
.tm-matrix__day { padding: 0.4rem 0.15rem; min-width: 2.75rem; text-align: center; font-size: 0.6875rem; }
.tm-matrix__day span { display: block; text-transform: uppercase; letter-spacing: 0.04em; }
.tm-matrix__day b { display: block; font-size: 0.875rem; color: var(--fg); }
.tm-matrix__day.is-off b, .tm-matrix__day.is-off span { color: var(--muted); opacity: 0.6; }
.tm-matrix__day.is-today b { color: var(--primary); }
.tm-matrix__total { padding: 0.4rem 0.875rem; text-align: right; white-space: nowrap; border-left: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.tm-matrix__total small { color: var(--muted); margin-left: 0.2rem; }
.tm-matrix tbody tr:not(:last-child) td { border-bottom: 1px solid var(--border); }
.tm-matrix tbody tr:hover .tm-matrix__who, .tm-matrix tbody tr:hover td { background: var(--row-hover); }

.tm-who { display: flex; align-items: center; gap: 0.6rem; }
.tm-who__text { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; flex: 1; }
.tm-who__name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg); }
.tm-bar { display: block; height: 4px; border-radius: 999px; background: var(--chip); overflow: hidden; }
.tm-bar__fill { display: block; height: 100%; border-radius: inherit; background: currentColor; }

.tm-cell-td { padding: 0.25rem 0.15rem; text-align: center; }
.tm-cell {
  position: relative; width: 100%; min-width: 2.5rem; height: 2.125rem; border-radius: 0.4rem; border: 1px solid transparent;
  font-size: 0.75rem; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--fg); background: transparent;
  display: inline-flex; align-items: center; justify-content: center; transition: transform 80ms ease, box-shadow 120ms ease;
}
.tm-cell:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12); }
.tm-cell:disabled { cursor: default; }
.tm-cell--ok { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
.tm-cell--under { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning); }
.tm-cell--over { background: color-mix(in srgb, var(--primary) 16%, transparent); color: var(--primary-strong); }
.tm-cell--missing { background: transparent; border: 1px dashed color-mix(in srgb, var(--danger) 55%, transparent); color: var(--danger); }
.tm-cell--error { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }
.tm-cell--off { background: repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--muted) 10%, transparent) 5px 6px); }
.tm-cell--off-logged { background: color-mix(in srgb, #8b5cf6 18%, transparent); color: #8b5cf6; }
.tm-cell--future { background: transparent; color: var(--muted); }
.tm-cell__flag { position: absolute; top: 3px; right: 3px; width: 6px; height: 6px; border-radius: 999px; background: var(--danger); }

.tm-legend { display: flex; flex-wrap: wrap; gap: 1rem; padding: 0.625rem 0.875rem; border-top: 1px solid var(--border); font-size: 0.75rem; color: var(--muted); }
.tm-legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
.tm-legend i { width: 0.875rem; height: 0.875rem; border-radius: 0.25rem; display: inline-block; }

/* Проблемы */
.tm-issues__head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
.tm-issues__head h2 { margin: 0; font-size: 1rem; }
.tm-ok { display: flex; align-items: center; gap: 0.5rem; color: var(--success); padding: 0.75rem 0; font-weight: 600; }
.tm-issues { list-style: none; margin: 0; padding: 0; max-height: 22rem; overflow: auto; }
.tm-issue {
  display: grid; grid-template-columns: 0.5rem 6rem minmax(8rem, 12rem) minmax(8rem, 12rem) 1fr; gap: 0.75rem; align-items: center;
  padding: 0.5rem 0.25rem; border-bottom: 1px solid var(--border); font-size: 0.8125rem; cursor: pointer; border-radius: 0.375rem;
}
.tm-issue:hover { background: var(--row-hover); }
.tm-issue__date { font-variant-numeric: tabular-nums; color: var(--muted); }
.tm-issue__who { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tm-issue__code { font-weight: 600; }
.tm-issue__msg { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tm-sev { width: 0.5rem; height: 0.5rem; border-radius: 999px; }
.tm-sev--error { background: var(--danger); }
.tm-sev--warning { background: var(--warning); }
.tm-sev--info { background: var(--muted); }

/* Модалка */
.tm-overlay { position: fixed; inset: 0; background: rgba(10, 14, 22, 0.5); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; z-index: 60; padding: 1rem; }
.tm-modal { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 0.875rem; box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.25); width: min(46rem, 100%); max-height: 85vh; overflow: auto; padding: 1.25rem 1.375rem; }
.tm-modal__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 0.875rem; }
.tm-modal__head h2 { margin: 0 0 0.2rem; font-size: 1.125rem; }
.tm-modal__issues { display: flex; flex-direction: column; gap: 0.375rem; margin-bottom: 0.875rem; }
.tm-chip { padding: 0.45rem 0.7rem; border-radius: 0.5rem; font-size: 0.8125rem; }
.tm-chip--error { background: var(--color-danger-bg); color: var(--danger); }
.tm-chip--warning { background: var(--amber-bg); color: var(--amber-fg); }
.tm-chip--info { background: var(--chip); color: var(--fg); }
.tm-wl { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
.tm-wl th { text-align: left; color: var(--muted); font-weight: 600; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); }
.tm-wl td { padding: 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
.tm-wl td small { display: block; color: var(--muted); }
.tm-wl .num { text-align: right; font-variant-numeric: tabular-nums; }
.tm-wl .mono { font-variant-numeric: tabular-nums; color: var(--muted); }
.tm-wl tr.is-flagged td { background: color-mix(in srgb, var(--danger) 7%, transparent); }

@media (max-width: 60rem) {
  .tm-issue { grid-template-columns: 0.5rem 5.5rem 1fr; }
  .tm-issue__code, .tm-issue__msg { grid-column: 3; }
}
</style>
