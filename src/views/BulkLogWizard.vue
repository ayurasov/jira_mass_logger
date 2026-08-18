<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import { useBulkWizardStore } from '../store/bulkWizard';
import { useJiraProfilesStore } from '../store/jiraProfiles';
import { useSettingsStore } from '../store/settings';
import { useAnalyticsStore } from '../store/analytics';
import { tauriApi, type JiraConnectionParams } from '../lib/tauriApi';
import { DATE_RANGE_PRESETS } from '../utils/dateRange';

const wizard = useBulkWizardStore();
const jiraProfiles = useJiraProfilesStore();
const settings = useSettingsStore();
const analyticsStore = useAnalyticsStore();

const templateName = ref('');
const holidayJson = ref('');
const issueInput = ref('');

onMounted(async () => {
  await wizard.bootstrap();
  issueInput.value = wizard.issueKey;
});

const activeProfile = computed(() => jiraProfiles.profiles[0] || null);

const jiraParams = computed<JiraConnectionParams | null>(() => {
  const profile = activeProfile.value;
  if (!profile) return null;
  return {
    baseUrl: profile.baseUrl,
    email: profile.email,
    secretRef: profile.secretRef,
    instanceType: profile.type,
    userTimezone: settings.timezone,
    proxy: null,
    extraRootCaPemPath: null,
  };
});

async function searchIssues() {
  if (!jiraParams.value) return;
  await wizard.searchIssues(jiraParams.value, issueInput.value);
}

function selectIssue(key: string, summary?: string | null) {
  wizard.selectIssue({ key, summary, source: 'search' });
  issueInput.value = key;
}

async function buildPreviewAndNext() {
  if (!jiraParams.value) return;
  await wizard.generatePreview(jiraParams.value);
  wizard.nextStep();
}

async function submitWizard() {
  if (!jiraParams.value) return;
  await wizard.submit(jiraParams.value);

  // Передаём количество успешно отправленных записей в аналитику
  // для расчёта метрики "экономия времени".
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

async function importHolidayCalendar() {
  if (!holidayJson.value.trim()) return;
  await tauriApi.importHolidays(holidayJson.value.trim());
  wizard.holidays = await tauriApi.getCustomHolidays();
  holidayJson.value = '';
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

const canProceedFromStep1 = computed(() => wizard.issueKey.trim().length > 0);
const canProceedFromStep2 = computed(() => !!wizard.periodFrom && !!wizard.periodTo && wizard.periodFrom <= wizard.periodTo);
const canProceedFromStep3 = computed(() => wizard.hoursPerDay > 0 && wizard.startTime.length >= 4);
</script>

<template>
  <div class="bulk-wizard-page">
    <header class="page-header">
      <div>
        <h1>Массовая фиксация времени</h1>
        <p>Главный мастер для пакетного создания worklog в Jira.</p>
      </div>
      <div class="header-actions">
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

      <div v-if="!activeProfile" class="empty-state">
        <h2>Нет профиля Jira</h2>
        <p>Создай или импортируй профиль Jira, чтобы использовать Bulk Log Wizard.</p>
        <router-link class="primary-btn" to="/profiles">Открыть профили</router-link>
      </div>

      <template v-else>
        <section v-show="wizard.step === 1" class="wizard-step-panel">
          <div class="panel-header">
            <h2>Шаг 1. Выбор задачи Jira</h2>
            <p>Автокомплит с дебаунсом 300мс ищет по JQL и подмешивает последние/избранные задачи.</p>
          </div>

          <div class="grid two-col">
            <label class="field-block span-2">
              <span>Поиск задачи / ссылка / ключ</span>
              <input
                v-model="issueInput"
                class="text-input"
                type="text"
                placeholder="Например: ABC-123 или https://jira.example.com/browse/ABC-123"
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
                <small>{{ option.isFavorite ? '★ Избранное' : option.source === 'recent' ? 'Недавняя' : 'JQL' }}</small>
              </button>
            </div>

            <div class="summary-card span-2" v-if="wizard.issueKey">
              <div>
                <strong>Выбрано:</strong> {{ wizard.issueKey }}
                <span v-if="wizard.issueSummary"> — {{ wizard.issueSummary }}</span>
              </div>
              <p>Можно вставить прямую ссылку или просто ключ — мастер распознает issue key автоматически.</p>
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

            <label class="field-block">
              <span>Дата начала</span>
              <input v-model="wizard.periodFrom" class="text-input" type="date" />
            </label>
            <label class="field-block">
              <span>Дата окончания</span>
              <input v-model="wizard.periodTo" class="text-input" type="date" />
            </label>
            <label class="field-block checkbox-line mobile-full">
              <input v-model="wizard.excludeHolidays" type="checkbox" />
              <span>Исключить праздники / нерабочие дни</span>
            </label>

            <div class="field-block span-3">
              <span>Дни недели</span>
              <div class="weekday-grid">
                <label
                  v-for="item in [['mon', 'Пн'], ['tue', 'Вт'], ['wed', 'Ср'], ['thu', 'Чт'], ['fri', 'Пт'], ['sat', 'Сб'], ['sun', 'Вс']]"
                  :key="item[0]"
                  class="weekday-item"
                >
                  <input v-model="wizard.weekdayFilter[item[0] as keyof typeof wizard.weekdayFilter]" type="checkbox" />
                  <span>{{ item[1] }}</span>
                </label>
              </div>
            </div>

            <div class="field-block span-3 holiday-import-block">
              <span>Импорт производственного календаря РФ (JSON)</span>
              <textarea
                v-model="holidayJson"
                class="text-area"
                rows="5"
                placeholder='[{"date":"2026-01-01","label":"Новый год"}] или ["2026-01-01","2026-01-02"]'
              />
              <div class="inline-actions">
                <button class="secondary-btn" @click="importHolidayCalendar">Импортировать</button>
                <small>Если список не импортирован, используется fallback-набор праздников РФ.</small>
              </div>
            </div>
          </div>
        </section>

        <section v-show="wizard.step === 3" class="wizard-step-panel">
          <div class="panel-header">
            <h2>Шаг 3. Параметры записи</h2>
            <p>Часы в день, шаблон комментария, переменные и конкретное время начала работы в течение дня.</p>
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
              <div class="template-buttons">
                <button v-for="tpl in wizard.savedTextTemplates" :key="tpl" class="template-chip" @click="wizard.descriptionTemplate = tpl">
                  {{ tpl }}
                </button>
              </div>
            </div>

            <label class="field-block">
              <span>Время начала</span>
              <input v-model="wizard.startTime" class="text-input" type="time" />
            </label>
            <div class="field-block span-2 save-template-card">
              <span>Сохранить набор параметров как шаблон</span>
              <div class="inline-actions stretch">
                <input v-model="templateName" class="text-input" type="text" placeholder="Название шаблона" />
                <button class="secondary-btn" @click="saveTemplate">Сохранить</button>
              </div>
            </div>

            <div class="field-block span-3" v-if="wizard.templates.length">
              <span>Повторное применение шаблона</span>
              <div class="template-buttons">
                <button v-for="tpl in wizard.templates" :key="tpl.id || tpl.name" class="template-chip wide" @click="wizard.applyTemplate(tpl)">
                  {{ tpl.name }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section v-show="wizard.step === 4" class="wizard-step-panel">
          <div class="panel-header">
            <h2>Шаг 4. Предпросмотр и подтверждение</h2>
            <p>Перед отправкой можно убрать или подправить любую строку и увидеть конфликты по дате+задаче.</p>
          </div>

          <div class="preview-summary">
            <div class="summary-pill">Строк: {{ wizard.previewRows.filter((r) => !r.skipped).length }}</div>
            <div class="summary-pill">Сумма часов: {{ wizard.totalHours }}</div>
            <div class="summary-pill warning" v-if="wizard.conflictsCount > 0">Конфликтов: {{ wizard.conflictsCount }}</div>
          </div>

          <div class="preview-table-wrap">
            <table class="preview-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>День</th>
                  <th>Часы</th>
                  <th>Описание</th>
                  <th>Старт</th>
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
                      :value="row.startedAt.slice(0, 16)"
                      @input="wizard.updatePreviewRow(row.id, { startedAt: `${($event.target as HTMLInputElement).value}:00.000Z` })"
                    />
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

          <div class="inline-actions">
            <button class="secondary-btn" @click="submitWizard" :disabled="wizard.sending">{{ wizard.sending ? 'Отправка…' : 'Подтвердить и отправить' }}</button>
            <button class="secondary-btn" @click="exportLog" :disabled="wizard.statusLogLines.length === 0">Экспортировать лог</button>
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
