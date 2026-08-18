<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { invoke } from '@tauri-apps/api/core';
import { useOnboardingStore } from '../store/onboarding';

const router = useRouter();
const store = useOnboardingStore();

// Шаг 1: Jira
const jiraUrl = ref('');
const jiraEmail = ref('');
const jiraToken = ref('');
const jiraTestLoading = ref(false);
const jiraTestError = ref('');
const jiraTestOk = ref(false);

async function testJira() {
  jiraTestLoading.value = true;
  jiraTestError.value = '';
  jiraTestOk.value = false;
  try {
    await invoke('test_connection', {
      baseUrl: jiraUrl.value,
      email: jiraEmail.value,
      apiToken: jiraToken.value,
    });
    jiraTestOk.value = true;
    store.jiraConnected = true;
  } catch (e: any) {
    jiraTestError.value = String(e);
  } finally {
    jiraTestLoading.value = false;
  }
}

// Шаг 2: Exchange
const exchangeTestLoading = ref(false);
const exchangeTestError = ref('');
const exchangeTestOk = ref(false);

async function testExchange() {
  exchangeTestLoading.value = true;
  exchangeTestError.value = '';
  try {
    await invoke('test_exchange_connection', {});
    exchangeTestOk.value = true;
    store.exchangeConnected = true;
  } catch (e: any) {
    exchangeTestError.value = String(e);
  } finally {
    exchangeTestLoading.value = false;
  }
}

// Шаг 3: расписание
const hoursPerDay = ref(store.scheduleHoursPerDay);
const workDays = ref([...store.scheduleDays]);
const dayLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function toggleDay(d: number) {
  const idx = workDays.value.indexOf(d);
  if (idx >= 0) workDays.value.splice(idx, 1);
  else workDays.value.push(d);
  workDays.value.sort();
}

// Шаг 4: тур
const tourStep = ref(0);
const tourItems = [
  {
    icon: '📋',
    title: 'Массовое логирование',
    text: 'Нажмите Ctrl+N или кнопку «Новый ворклог». В мастере выберите период и задачи, нажмите «Предпросмотр» — всё уйдёт в Jira одной кнопкой.',
  },
  {
    icon: '📊',
    title: 'Дашборд аналитики',
    text: 'Главный экран показывает вашу неделю план/факт, heatmap за 3 месяца и дни с пробелами в ворклоге.',
  },
  {
    icon: '🔄',
    title: 'Offline-режим',
    text: 'Если сети нет — записи сохраняются локально. Индикатор в шапке покажет статус. При восстановлении сети всё автоматически уйдёт в Jira.',
  },
  {
    icon: '⌨️',
    title: 'Горячие клавиши',
    text: 'Ctrl+N — новый ворклог, Ctrl+L — таблица ворклогов, Ctrl+M — свернуть в трей, Enter — сохранить строку, Esc — отмена.',
  },
];

const canProceedJira = computed(() => store.jiraConnected);
const canProceedExchange = computed(() => store.exchangeConnected || store.exchangeSkipped);
const canProceedSchedule = computed(() => workDays.value.length > 0 && hoursPerDay.value > 0);

function saveScheduleAndNext() {
  store.scheduleHoursPerDay = hoursPerDay.value;
  store.scheduleDays = [...workDays.value];
  store.goNext();
}

function finish() {
  store.complete();
  router.push('/');
}
</script>

<template>
  <div class="onboarding-overlay">
    <div class="onboarding-card">
      <!-- Прогресс-бар -->
      <div class="onboarding-progress">
        <div
          class="onboarding-progress-fill"
          :style="{ width: store.progressPercent + '%' }"
        />
      </div>

      <!-- Хедер -->
      <div class="onboarding-header">
        <span class="onboarding-step-label">
          Шаг {{ store.currentStepIndex + 1 }} из 4
        </span>
        <h1 class="onboarding-title">
          <template v-if="store.currentStep === 'jira'">Подключение Jira</template>
          <template v-else-if="store.currentStep === 'exchange'">Microsoft Exchange</template>
          <template v-else-if="store.currentStep === 'schedule'">Рабочий график</template>
          <template v-else>Краткий обзор</template>
        </h1>
      </div>

      <!-- Шаг 1: Jira -->
      <div v-if="store.currentStep === 'jira'" class="onboarding-body">
        <p class="onboarding-hint">
          Введите URL вашего Jira-сервера и API-токен.
          <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener"
            >Как получить токен?</a
          >
        </p>
        <label class="field-label">
          Jira URL
          <input v-model="jiraUrl" type="url" placeholder="https://yourcompany.atlassian.net" class="field-input" />
        </label>
        <label class="field-label">
          Email
          <input v-model="jiraEmail" type="email" placeholder="you@company.com" class="field-input" />
        </label>
        <label class="field-label">
          API Token
          <input v-model="jiraToken" type="password" placeholder="ATL..." class="field-input" />
        </label>
        <div v-if="jiraTestError" class="onboarding-error">{{ jiraTestError }}</div>
        <div v-if="jiraTestOk" class="onboarding-success">✓ Подключение успешно!</div>
        <div class="onboarding-actions">
          <button class="btn-secondary" :disabled="jiraTestLoading || !jiraUrl" @click="testJira">
            {{ jiraTestLoading ? 'Проверка...' : 'Проверить соединение' }}
          </button>
          <button class="btn-primary" :disabled="!canProceedJira" @click="store.goNext">
            Далее &rarr;
          </button>
        </div>
      </div>

      <!-- Шаг 2: Exchange -->
      <div v-else-if="store.currentStep === 'exchange'" class="onboarding-body">
        <p class="onboarding-hint">
          Интеграция с календарём Microsoft позволяет автоматически заполнять ворклог из событий.
          Можно пропустить и настроить позже в разделе «Профили».
        </p>
        <div v-if="exchangeTestError" class="onboarding-error">{{ exchangeTestError }}</div>
        <div v-if="exchangeTestOk" class="onboarding-success">✓ Exchange подключён!</div>
        <div class="onboarding-actions">
          <button class="btn-ghost" @click="store.skipExchange">Пропустить</button>
          <button class="btn-secondary" :disabled="exchangeTestLoading" @click="testExchange">
            {{ exchangeTestLoading ? 'Подключение...' : 'Подключить Exchange' }}
          </button>
          <button class="btn-primary" :disabled="!canProceedExchange" @click="store.goNext">
            Далее &rarr;
          </button>
        </div>
      </div>

      <!-- Шаг 3: Рабочий график -->
      <div v-else-if="store.currentStep === 'schedule'" class="onboarding-body">
        <p class="onboarding-hint">
          Эти данные используются для подсчёта плановых часов на дашборде. Можно изменить
          позже в Настройках.
        </p>
        <label class="field-label">
          Часов в день
          <input v-model.number="hoursPerDay" type="number" min="1" max="24" class="field-input field-input--sm" />
        </label>
        <div class="field-label">
          Рабочие дни
          <div class="day-picker">
            <button
              v-for="(label, i) in dayLabels"
              :key="i"
              :class="['day-btn', { active: workDays.includes(i + 1) }]"
              @click="toggleDay(i + 1)"
            >
              {{ label }}
            </button>
          </div>
        </div>
        <div class="onboarding-actions">
          <button class="btn-ghost" @click="store.goPrev">&larr; Назад</button>
          <button class="btn-primary" :disabled="!canProceedSchedule" @click="saveScheduleAndNext">
            Далее &rarr;
          </button>
        </div>
      </div>

      <!-- Шаг 4: Тур -->
      <div v-else class="onboarding-body">
        <div class="tour-card">
          <div class="tour-icon">{{ tourItems[tourStep].icon }}</div>
          <h2 class="tour-title">{{ tourItems[tourStep].title }}</h2>
          <p class="tour-text">{{ tourItems[tourStep].text }}</p>
        </div>
        <div class="tour-dots">
          <span
            v-for="(_, i) in tourItems"
            :key="i"
            :class="['tour-dot', { active: i === tourStep }]"
            @click="tourStep = i"
          />
        </div>
        <div class="onboarding-actions">
          <button v-if="tourStep > 0" class="btn-ghost" @click="tourStep--">&larr;</button>
          <button v-if="tourStep < tourItems.length - 1" class="btn-secondary" @click="tourStep++">
            Далее
          </button>
          <button v-else class="btn-primary" @click="finish">
            Начать работу ✨
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.onboarding-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.onboarding-card {
  width: min(520px, 94vw);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.onboarding-progress {
  height: 3px;
  background: var(--color-surface-offset);
}
.onboarding-progress-fill {
  height: 100%;
  background: var(--color-primary);
  transition: width 0.35s ease;
}

.onboarding-header {
  padding: 24px 28px 0;
}
.onboarding-step-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.onboarding-title {
  margin-top: 6px;
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--color-text);
}

.onboarding-body {
  padding: 20px 28px 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.onboarding-hint {
  font-size: 0.875rem;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.onboarding-hint a {
  color: var(--color-primary);
}

.field-label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text-muted);
}
.field-input {
  padding: 8px 10px;
  background: var(--color-surface-offset);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.9rem;
  color: var(--color-text);
  outline: none;
  transition: border-color 0.15s;
}
.field-input:focus {
  border-color: var(--color-primary);
}
.field-input--sm { width: 80px; }

.day-picker {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.day-btn {
  padding: 5px 10px;
  border-radius: 20px;
  font-size: 0.8rem;
  font-weight: 600;
  border: 1.5px solid var(--color-border);
  background: var(--color-surface-offset);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all 0.15s;
}
.day-btn.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}

.onboarding-error {
  font-size: 0.85rem;
  color: var(--color-error);
  background: var(--color-error-highlight);
  border-radius: 6px;
  padding: 8px 12px;
}
.onboarding-success {
  font-size: 0.85rem;
  color: var(--color-success);
  background: var(--color-success-highlight);
  border-radius: 6px;
  padding: 8px 12px;
}

.onboarding-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 6px;
}

.btn-primary,
.btn-secondary,
.btn-ghost {
  padding: 9px 18px;
  border-radius: 7px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}
.btn-primary {
  background: var(--color-primary);
  color: #fff;
  border: none;
}
.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-primary:not(:disabled):hover { background: var(--color-primary-hover); }
.btn-secondary {
  background: var(--color-surface-offset);
  color: var(--color-text);
  border: 1px solid var(--color-border);
}
.btn-secondary:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-ghost {
  background: none;
  color: var(--color-text-muted);
  border: none;
}
.btn-ghost:hover { color: var(--color-text); }

/* Tour */
.tour-card {
  background: var(--color-surface-offset);
  border-radius: 10px;
  padding: 24px;
  text-align: center;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.tour-icon { font-size: 2.2rem; }
.tour-title { font-size: 1rem; font-weight: 700; color: var(--color-text); }
.tour-text  { font-size: 0.875rem; color: var(--color-text-muted); line-height: 1.55; max-width: 380px; }

.tour-dots {
  display: flex;
  gap: 7px;
  justify-content: center;
}
.tour-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-border);
  cursor: pointer;
  transition: background 0.15s;
}
.tour-dot.active { background: var(--color-primary); }
</style>
