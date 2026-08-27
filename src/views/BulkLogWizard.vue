<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import DatePicker from '../components/DatePicker.vue';
import { useBulkWizardStore } from '../store/bulkWizard';
import { useJiraProfilesStore } from '../store/jiraProfiles';
import { useAnalyticsStore } from '../store/analytics';
import ActionIcon from '../components/ActionIcon.vue';
import { useSettingsStore } from '../store/settings';
import { tauriApi } from '../lib/tauriApi';
import { DATE_RANGE_PRESETS } from '../utils/dateRange';
import { useLicenseStore } from '../store/license';

const wizard = useBulkWizardStore();
const jiraProfiles = useJiraProfilesStore();
const analyticsStore = useAnalyticsStore();
const settings = useSettingsStore();
const license = useLicenseStore();

const templateName = ref('');
const issueInput = ref('');

onMounted(async () => {
  await jiraProfiles.ensureLoaded();
  await wizard.bootstrap();
  issueInput.value = wizard.issueKey;
});

const activeProfile = computed(() => jiraProfiles.activeProfile);

const jiraParams = computed(() => jiraProfiles.activeConnectionParams);

async function searchIssues() {
  if (!jiraParams.value) return;
  await wizard.searchIssues(jiraParams.value, issueInput.value);
}

function selectIssue(key: string, summary?: string | null) {
  wizard.selectIssue({ key, summary, source: 'search' });
  issueInput.value = key;
}

async function buildPreviewAndNext() {
  if (!license.guardWrite()) return;
  if (!jiraParams.value) return;
  await wizard.generatePreview(jiraParams.value);
  wizard.nextStep();
}

async function submitWizard() {
  if (!license.guardWrite()) return;
  if (!jiraParams.value) return;
  await wizard.submit(jiraParams.value);

  const successCount = wizard.previewRows.filter(r => r.status === 'success').length;
  if (successCount > 0) {
    analyticsStore.trackBulkEntries(successCount);
  }
}

async function saveTemplate() {
  if (!templateName.value.trim()) return;
  await wizard.saveCurrentAsTemplate(templateName.value.trim());
  templateName.value = '';
}

async function exportLog() {
  const logPath = await save({
    title: 'Сохранить лог операции',
    defaultPath: `jiratime-bulk-log-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
  });
  if (!logPath) return;
  await tauriApi.writeExportFile(logPath, wizard.buildExportLog());
}

function startNewSession() {
  const hasProgress = !!wizard.issueKey || wizard.previewRows.length > 0 || wizard.statusLogLines.length > 0;
  if (hasProgress && !confirm('Начать новую сессию? Все текущие поля будут сброшены.')) return;
  wizard.resetWizard();
  issueInput.value = '';
  templateName.value = '';
}

function fmtStartedAt24h(iso: string): string {
  const dt = new Date(iso);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: settings.timezone,
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(dt);
}

function toDatetimeLocalValue(iso: string): string {
  const dt = new Date(iso);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: settings.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(dt).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const startTimeError = ref('');
function onStartTimeInput(raw: string) {
  let digits = raw.replace(/\D/g, '').slice(0, 4);
  let formatted = digits;
  if (digits.length > 2) formatted = `${digits.slice(0, 2)}:${digits.slice(2)}`;
  wizard.startTime = formatted;
  validateStartTime();
}
function validateStartTime() {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(wizard.startTime);
  startTimeError.value = m ? '' : 'Формат: ЧЧ:ММ, 24ч (например 09:00 или 18:30)';
}

const canProceedFromStep1 = computed(() => wizard.issueKey.trim().length > 0);
const canProceedFromStep2 = computed(() => !!wizard.periodFrom && !!wizard.periodTo && wizard.periodFrom <= wizard.periodTo);
const canProceedFromStep3 = computed(() => wizard.hoursPerDay > 0 && /^([01]\d|2[0-3]):([0-5]\d)$/.test(wizard.startTime));
</script>

<template>
  <div class="bulk-wizard-page">
    <header class="page-header">
      <div>
        <h1>Массовая фиксация времени</h1>
        <p>Главный мастер для пакетного создания worklog в Jira.</p>
      </div>
      <div class="header-actions">
        <button class="secondary-btn" @click="startNewSession" title="Сбросить все поля и начать заново">+ Новая сессия</button>
        <router-link class="secondary-btn" to="/templates">Шаблоны</router-link>
        <router-link class="secondary-btn" to="/settings">Настройки</router-link>
      </div>
    </header>

    <section class="wizard-shell">
      <div class="wizard-progress-top">
        <div class="wizard-progress-track">
          <div class="wizard-progress-fill" :style="{ width: `${wizard.progressPercent}%` }"></div>
        </div>
        <div class="wizard-stepper" role="tablist" aria-label="Шаги мастера">
          <button
            v-for="n in wizard.totalSteps"
            :key="n"
            class="step-chip"
            :class="{ active: wizard.step === n, complete: n < wizard.step }"
            @click="wizard.goToStep(n)"
          >
            <span class="step-index">{{ n }}</span>
            <span class="step-label">{{ ['Задача Jira', 'Период', 'Параметры', 'Предпросмотр'][n - 1] }}</span>
          </button>
        </div>
      </div>

      <div v-if="jiraProfiles.loading" class="empty-state">
        <h2>Загрузка профилей…</h2>
      </div>

      <div v-else-if="!activeProfile" class="empty-state">
        <h2>Нет профиля Jira</h2>
        <p>Создай или импортируй профиль Jira, чтобы использовать Bulk Log Wizard.</p>
        <p v-if="jiraProfiles.error" class="empty-state-error">Ошибка загрузки профилей: {{ jiraProfiles.error }}</p>
        <router-link class="primary-btn" to="/profiles">Открыть профили</router-link>
      </div>

      <template v-else>
        <!-- Баннер режима просмотра -->
        <div v-if="!license.isActive" class="license-banner">
          <ActionIcon name="warning" :size="15" />
          Работаете в <strong>режиме просмотра</strong> — отправка в Jira недоступна.
          <button class="license-banner__btn" @click="license.openActivation">Активировать</button>
        </div>

        <section v-show="wizard.step === 1" class="wizard-step-panel">
          <div class="panel-header">
            <h2>Шаг 1. Выбор задачи Jira</h2>
            <p>Введите ключ задачи (например ABC-123), ссылку или часть текста — мастер найдёт её в Jira.</p>
          </div>

          <div class="grid two-col">
            <label class="field-block span-2">
              <span>Поиск задачи / ссылка / ключ / текст</span>
              <input
                v-model="issueInput"
                class="text-input"
                type="text"
                placeholder="Например: ABC-123, https://jira.example.com/browse/ABC-123 или текст задачи"
                @input="searchIssues"
                @blur="wizard.selectIssue(issueInput)"
              />
            </label>

            <div class="autocomplete-panel span-2">
              <div class="autocomplete-header">
                <strong>Подсказки</strong>
                <span v-if="wizard.loading">Поиск…</span>
              </div>
              <button v-for="option in wizard.issueOptions" :key="option.key" class="issue-option" @click="selectIssue(option.key, option.summary)">
                <div>
                  <strong>{{ option.key }}</strong>
                  <span v-if="option.summary"> — {{ option.summary }}</span>
                </div>
                <small v-if="option.isFavorite" class="fav-inline"><ActionIcon name="star" :size="11" /> Избранное</small>
                <small v-else>{{ option.source === 'recent' ? 'Недавняя' : 'Найдено в Jira' }}</small>
              </button>
            </div>

            <div class="summary-card span-2" v-if="wizard.issueKey">
              <div>
                <strong>Выбрано:</strong> {{ wizard.issueKey }}
                <span v-if="wizard.issueSummary"> — {{ wizard.issueSummary }}</span>
              </div>
              <p>Можно вставить прямую ссылку, ключ задачи или её текст — мастер распознает issue key автоматически.</p>
            </div>
          </div>
        </section>

        <section v-show="wizard.step === 2" class="wizard-step-panel">
          <div class="panel-header">
            <h2>Шаг 2. Выбор периода</h2>
            <p>Date-range picker, пресеты, фильтр по дням недели и исключение праздников/нерабочих дней.</p>
          </div>

          <div class="grid three-col">
            <div class="preset-list span-3">
              <button v-for="preset in DATE_RANGE_PRESETS" :key="preset.id" class="preset-btn" :class="{ active: wizard.selectedPresetId === preset.id }" @click="wizard.applyPreset(preset.id)">
                {{ preset.label }}
              </button>
            </div>

            <!-- Поля дат: обёртка без рамки, рамку рисует сам DatePicker -->
            <div class="field-block field-block--datepicker">
              <span class="field-block__label">Дата начала</span>
              <DatePicker v-model="wizard.periodFrom" />
            </div>
            <div class="field-block field-block--datepicker">
              <span class="field-block__label">Дата окончания</span>
              <DatePicker v-model="wizard.periodTo" />
            </div>
            <label class="field-block checkbox-line mobile-full">
              <input v-model="wizard.excludeHolidays" type="checkbox" />
              <span>Исключить праздники / нерабочие дни</span>
            </label>

            <div class="field-block span-3">
              <span>Дни недели</span>
              <div class="weekday-chips">
                <label
                  v-for="item in [['mon', 'Пн'], ['tue', 'Вт'], ['wed', 'Ср'], ['thu', 'Чт'], ['fri', 'Пт'], ['sat', 'Сб'], ['sun', 'Вс']]"
                  :key="item[0]"
                  class="weekday-chip"
                  :class="{ 'weekday-chip--active': wizard.weekdayFilter[item[0] as 'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun'] }"
                >
                  <input
                    v-model="wizard.weekdayFilter[item[0] as 'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun']"
                    type="checkbox"
                    class="weekday-chip__input"
                  />
                  <span>{{ item[1] }}</span>
                </label>
              </div>
            </div>
          </div>
        </section>

        <section v-show="wizard.step === 3" class="wizard-step-panel">
          <div class="panel-header">
            <h2>Шаг 3. Параметры записи</h2>
            <p>Часы в день, шаблон комментария, переменные и конкретное время начала работы в течение дня (24-часовой формат).</p>
          </div>

          <div class="grid three-col">
            <label class="field-block">
              <span>Часы в день</span>
              <input v-model.number="wizard.hoursPerDay" class="text-input" type="number" min="0.5" step="0.5" />
            </label>
            <div class="field-block span-2">
              <span>Быстрые пресеты часов</span>
              <div class="preset-list compact">
                <button v-for="h in [1, 2, 4, 8]" :key="h" class="preset-btn" @click="wizard.hoursPerDay = h">{{ h }} ч</button>
              </div>
            </div>

            <label class="field-block span-2">
              <span>Описание worklog</span>
              <textarea v-model="wizard.descriptionTemplate" class="text-area" rows="4" placeholder="Например: Работа по задаче {issue} за {date}" />
              <small>Доступные переменные: <code>{date}</code>, <code>{week}</code>, <code>{issue}</code></small>
            </label>
            <div class="field-block">
              <span>Сохранённые шаблоны текста</span>
              <div v-if="wizard.textTemplates.length" class="text-template-list">
                <button
                  v-for="tpl in wizard.textTemplates"
                  :key="tpl.id ?? tpl.name"
                  class="text-template-tag"
                  :title="tpl.text"
                  @click="wizard.applyTextTemplate(tpl)"
                >
                  {{ tpl.name }}
                </button>
              </div>
              <small v-else class="muted-hint">Шаблонов пока нет — создайте их на странице «Шаблоны».</small>
            </div>

            <label class="field-block">
              <span>Время начала (24ч, ЧЧ:ММ)</span>
              <input
                :value="wizard.startTime"
                class="text-input"
                type="text"
                inputmode="numeric"
                placeholder="09:00"
                maxlength="5"
                @input="onStartTimeInput(($event.target as HTMLInputElement).value)"
                @blur="validateStartTime"
              />
              <small v-if="startTimeError" class="field-error">{{ startTimeError }}</small>
            </label>
            <div class="field-block span-2 save-template-card">
              <span>Сохранить набор параметров как шаблон</span>
              <div class="inline-actions stretch">
                <input v-model="templateName" class="text-input" type="text" placeholder="Название шаблона" />
                <button class="secondary-btn" @click="saveTemplate">Сохранить</button>
              </div>
            </div>

            <div class="field-block span-3" v-if="wizard.templates.length">
              <span>Повторное применение шаблона мастера</span>
              <div class="text-template-list">
                <button v-for="tpl in wizard.templates" :key="tpl.id || tpl.name" class="text-template-tag text-template-tag--master" @click="wizard.applyTemplate(tpl)">
                  {{ tpl.name }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section v-show="wizard.step === 4" class="wizard-step-panel">
          <div class="panel-header">
            <h2>Шаг 4. Предпросмотр и подтверждение</h2>
            <p>Перед отправкой можно убрать или подправить любую строку и увидеть конфликты по дате+задаче. Время указано в 24-часовом формате — именно так, как оно попадёт в Jira.</p>
          </div>

          <div class="preview-summary">
            <div class="summary-pill">Строк: {{ wizard.previewRows.filter((r) => !r.skipped).length }}</div>
            <div class="summary-pill">Сумма часов: {{ wizard.totalHours }}</div>
            <div class="summary-pill warning" v-if="wizard.conflictsCount > 0">Конфликтов: {{ wizard.conflictsCount }}</div>
          </div>

          <div class="preview-table-wrap">
            <table class="preview-table">
              <colgroup>
                <col style="width: 7rem" />
                <col style="width: 4rem" />
                <col style="width: 6rem" />
                <col style="width: 22rem" />
                <col style="width: 11rem" />
                <col style="width: 9rem" />
                <col style="width: 7rem" />
                <col style="width: 6rem" />
              </colgroup>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>День</th>
                  <th>Часы</th>
                  <th>Описание</th>
                  <th>Старт (24ч)</th>
                  <th>Конфликт</th>
                  <th>Статус</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in wizard.previewRows" :key="row.id" :class="{ skipped: row.skipped, conflict: row.conflict }">
                  <td>{{ row.date }}</td>
                  <td>{{ row.weekday }}</td>
                  <td>
                    <input
                      class="table-input"
                      type="number"
                      min="0.5"
                      step="0.5"
                      :value="row.hours"
                      @input="wizard.updatePreviewRow(row.id, { hours: Number(($event.target as HTMLInputElement).value) })"
                    />
                  </td>
                  <td>
                    <textarea
                      class="table-textarea"
                      rows="2"
                      :value="row.description"
                      @input="wizard.updatePreviewRow(row.id, { description: ($event.target as HTMLTextAreaElement).value })"
                    />
                  </td>
                  <td>
                    <input
                      class="table-input"
                      type="datetime-local"
                      :value="toDatetimeLocalValue(row.startedAt)"
                      @input="wizard.setPreviewRowStartedAtLocal(row.id, ($event.target as HTMLInputElement).value)"
                    />
                    <small class="started-hint">{{ fmtStartedAt24h(row.startedAt) }}</small>
                  </td>
                  <td>
                    <span class="badge warning" v-if="row.conflict">Уже есть worklog</span>
                    <span class="badge" v-else>—</span>
                  </td>
                  <td>
                    <span class="badge success" v-if="row.status === 'success'">Успех</span>
                    <span class="badge retry" v-else-if="row.status === 'retry'">Повтор</span>
                    <span class="badge danger" v-else-if="row.status === 'error'">Ошибка</span>
                    <span class="badge" v-else>Ожидает</span>
                  </td>
                  <td>
                    <button v-if="!row.skipped" class="ghost-btn danger" @click="wizard.removePreviewRow(row.id)">Убрать</button>
                    <button v-else class="ghost-btn" @click="wizard.restorePreviewRow(row.id)">Вернуть</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="status-log" v-if="wizard.statusLogLines.length">
            <h3>Ход отправки</h3>
            <pre>{{ wizard.statusLogLines.join('\n') }}</pre>
          </div>

          <div class="inline-actions preview-actions">
            <button class="primary-btn" @click="submitWizard" :disabled="wizard.sending || !license.isActive">{{ wizard.sending ? 'Отправка…' : 'Подтвердить и отправить' }}</button>
            <button class="secondary-btn" @click="exportLog" :disabled="wizard.statusLogLines.length === 0">Экспортировать лог</button>
            <button class="secondary-btn" @click="startNewSession">+ Новая сессия</button>
          </div>
        </section>

        <footer class="wizard-footer">
          <button class="secondary-btn" :disabled="wizard.step === 1" @click="wizard.prevStep">Назад</button>
          <div class="footer-spacer"></div>
          <button v-if="wizard.step === 1" class="primary-btn" :disabled="!canProceedFromStep1" @click="wizard.nextStep">Далее</button>
          <button v-else-if="wizard.step === 2" class="primary-btn" :disabled="!canProceedFromStep2" @click="wizard.nextStep">Далее</button>
          <button v-else-if="wizard.step === 3" class="primary-btn" :disabled="!canProceedFromStep3" @click="buildPreviewAndNext">Построить предпросмотр</button>
        </footer>
      </template>
    </section>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.header-actions {
  display: flex;
  gap: 0.5rem;
}
.empty-state {
  padding: 3rem 1.5rem;
  text-align: center;
  border: 1px dashed var(--color-border, #d0d5dd);
  border-radius: 12px;
}
.empty-state-error {
  color: var(--color-error, #dc2626);
  font-size: 0.85rem;
}
.started-hint {
  display: block;
  color: var(--text-muted, #888);
  font-size: 0.75rem;
  margin-top: 2px;
}
.field-error {
  color: var(--color-error, #dc2626);
  font-size: 0.75rem;
}
.muted-hint {
  color: var(--color-text-muted, #9ca3af);
  font-size: 0.82rem;
}

/* ── Поля дат: убираем рамку с обёртки, рамку рисует DatePicker внутри ── */
.field-block--datepicker {
  border: none !important;
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.field-block--datepicker .field-block__label {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--color-text-muted, #6b7280);
  margin-bottom: 0.1rem;
}

/* ── Дни недели: пилюли без обводок ── */
.weekday-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.35rem;
}

.weekday-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.65rem;
  border-radius: var(--radius-full, 9999px);
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
  background: var(--color-surface-offset, #f0f0ee);
  color: var(--color-text-muted, #6b7280);
  transition: background 120ms, color 120ms;
  border: none;
}

.weekday-chip--active {
  background: var(--color-primary-highlight, #cedcd8);
  color: var(--color-primary, #01696f);
  font-weight: 600;
}

.weekday-chip__input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  pointer-events: none;
}

.weekday-chip:hover {
  background: var(--color-surface-dynamic, #e6e4df);
  color: var(--color-text, #28251d);
}

.weekday-chip--active:hover {
  background: var(--color-primary-highlight, #cedcd8);
  color: var(--color-primary-hover, #0c4e54);
}

/* ── Теги шаблонов текста — элегантный минималистичный стиль ── */
.text-template-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.45rem;
}

.text-template-tag {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 0.28rem 0.72rem;
  border-radius: var(--radius-full, 9999px);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  cursor: pointer;
  user-select: none;
  /* Тонкая рамка вместо заливки — воздушный вид */
  border: 1px solid color-mix(in srgb, var(--color-primary, #01696f) 30%, transparent);
  background: color-mix(in srgb, var(--color-primary, #01696f) 5%, var(--color-surface, #fff));
  color: var(--color-primary, #01696f);
  transition: background 140ms, border-color 140ms, color 140ms, box-shadow 140ms, transform 80ms;
  line-height: 1.35;
  max-width: 13rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text-template-tag:hover {
  background: color-mix(in srgb, var(--color-primary, #01696f) 12%, var(--color-surface, #fff));
  border-color: var(--color-primary, #01696f);
  box-shadow: 0 1px 4px color-mix(in srgb, var(--color-primary, #01696f) 18%, transparent);
  transform: translateY(-1px);
}

.text-template-tag:active {
  transform: translateY(0);
  box-shadow: none;
}

/* Шаблоны мастера — чуть насыщеннее */
.text-template-tag--master {
  border-color: color-mix(in srgb, var(--color-primary, #01696f) 45%, transparent);
  background: color-mix(in srgb, var(--color-primary, #01696f) 9%, var(--color-surface, #fff));
  font-weight: 600;
}

.text-template-tag--master:hover {
  background: color-mix(in srgb, var(--color-primary, #01696f) 16%, var(--color-surface, #fff));
}

.license-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 1rem;
  background: #fff8e1;
  border: 1px solid #ffe082;
  border-radius: 0.5rem;
  font-size: 0.87rem;
  color: #7a5400;
  margin-bottom: 0.5rem;
}
.license-banner__btn {
  margin-left: auto;
  padding: 0.25rem 0.75rem;
  border-radius: 0.4rem;
  border: 1px solid #f59e0b;
  background: #fef3c7;
  color: #92400e;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}
.license-banner__btn:hover { background: #fde68a; }
</style>
