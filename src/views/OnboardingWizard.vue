<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../store/settings';

const router = useRouter();
const settings = useSettingsStore();

// Шаги онбординга
const STEPS = [
  { id: 'jira',     title: 'Подключение Jira',       icon: '🔗' },
  { id: 'exchange', title: 'Подключение Exchange', icon: '📅' },
  { id: 'schedule', title: 'Рабочий график',      icon: '⏰' },
  { id: 'tour',     title: 'Быстрый тур',          icon: '🚀' },
];

const step = ref(0);
const loading = ref(false);
const error = ref('');

// --- Шаг 1: Jira ---
const jiraUrl   = ref('');
const jiraEmail = ref('');
const jiraToken = ref('');
const jiraOk    = ref(false);

async function testJira() {
  error.value = '';
  loading.value = true;
  try {
    await invoke('test_connection', {
      baseUrl: jiraUrl.value.trim().replace(/\/$/, ''),
      email: jiraEmail.value.trim(),
      token: jiraToken.value.trim(),
    });
    await invoke('save_secret', { key: 'jira_base_url',  value: jiraUrl.value.trim().replace(/\/$/, '') });
    await invoke('save_secret', { key: 'jira_email',     value: jiraEmail.value.trim() });
    await invoke('save_secret', { key: 'jira_api_token', value: jiraToken.value.trim() });
    jiraOk.value = true;
  } catch (e: any) {
    error.value = 'Ошибка подключения: ' + (e?.message ?? String(e));
  } finally {
    loading.value = false;
  }
}

// --- Шаг 2: Exchange (можно пропустить) ---
const exchangeSkipped = ref(false);

// --- Шаг 3: Рабочий график ---
const workdayStart = ref('09:00');
const workdayEnd   = ref('18:00');
const workDays     = ref<number[]>([1, 2, 3, 4, 5]); // 0=Вс, 6=Сб
const dailyHours   = ref(8);

const DAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
function toggleDay(d: number) {
  const idx = workDays.value.indexOf(d);
  if (idx >= 0) workDays.value.splice(idx, 1);
  else workDays.value.push(d);
}

async function saveSchedule() {
  error.value = '';
  loading.value = true;
  try {
    await invoke('save_scheduler_settings', {
      settings: {
        workday_start: workdayStart.value,
        workday_end: workdayEnd.value,
        work_days: workDays.value,
        daily_hours: dailyHours.value,
      },
    });
    nextStep();
  } catch (e: any) {
    error.value = 'Ошибка сохранения: ' + (e?.message ?? String(e));
  } finally {
    loading.value = false;
  }
}

// --- Шаг 4: Тур по мастеру ---
const tourStep = ref(0);
const TOUR_STEPS = [
  { title: 'Создайте записи за период', desc: 'В мастере выберите диапазон дат и нажмите «Далее».', img: '📆' },
  { title: 'Добавьте задачи', desc: 'Выберите задачи Jira из списка или начните вводить ключ Jira-таска.', img: '🔍' },
  { title: 'Примените шаблон', desc: 'Сохраните набор задач как шаблон для повторного использования.', img: '📋' },
  { title: 'Отправка в Jira', desc: 'Проверьте итоговую таблицу и нажмите «Аплодировать» — записи уйдут в Jira.', img: '✅' },
];

// --- Навигация ---
function nextStep() {
  error.value = '';
  if (step.value < STEPS.length - 1) step.value++;
}
function prevStep() {
  error.value = '';
  if (step.value > 0) step.value--;
}
async function finish() {
  localStorage.setItem('onboarding_done', '1');
  settings.markOnboardingDone();
  await router.replace('/');
}

const canNextJira = computed(() => jiraOk.value);
</script>

<template>
  <div class="ob-overlay">
    <div class="ob-card">

      <!-- Заголовок -->
      <div class="ob-header">
        <span class="ob-logo">⏱️ JiraTime</span>
        <span class="ob-step-label">Шаг {{ step + 1 }} / {{ STEPS.length }}</span>
      </div>

      <!-- Индикатор прогресса -->
      <div class="ob-progress">
        <div
          v-for="(s, i) in STEPS"
          :key="s.id"
          :class="['ob-progress-dot', { active: i === step, done: i < step }]"
        >
          <span class="ob-progress-icon">{{ i < step ? '✓' : s.icon }}</span>
          <span class="ob-progress-title">{{ s.title }}</span>
        </div>
      </div>

      <div class="ob-body">

        <!-- ── Шаг 1: Jira ── -->
        <template v-if="step === 0">
          <h2>Подключите Jira</h2>
          <p class="ob-hint">API-токен можно создать на
            <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">id.atlassian.com</a>.
          </p>
          <label>Адрес Jira (https://company.atlassian.net)
            <input v-model="jiraUrl" type="url" placeholder="https://company.atlassian.net" autocomplete="off" />
          </label>
          <label>Email
            <input v-model="jiraEmail" type="email" placeholder="you@company.com" autocomplete="email" />
          </label>
          <label>API токен
            <input v-model="jiraToken" type="password" placeholder="ATATT3x…" autocomplete="new-password" />
          </label>
          <div v-if="error" class="ob-error">{{ error }}</div>
          <div v-if="jiraOk" class="ob-success">✔ Подключение успешно</div>
          <div class="ob-actions">
            <button class="ob-btn-secondary" :disabled="loading" @click="testJira">
              {{ loading ? 'Проверка…' : 'Проверить подключение' }}
            </button>
            <button class="ob-btn-primary" :disabled="!canNextJira" @click="nextStep">Далее →</button>
          </div>
        </template>

        <!-- ── Шаг 2: Exchange ── -->
        <template v-else-if="step === 1">
          <h2>Подключение Exchange / M365</h2>
          <p class="ob-hint">Exchange позволяет автоматически заполнять ворклог
            из вашего календаря. Можно настроить позже в «Настройках».
          </p>
          <div class="ob-exchange-hint">
            <span>📌</span>
            <span>Для подключения нужно Azure AD приложение с правами
              <code>Calendars.Read</code>.
              См. README → «Azure AD».
            </span>
          </div>
          <div class="ob-actions">
            <button class="ob-btn-ghost" @click="exchangeSkipped = true; nextStep()">Пропустить</button>
            <button class="ob-btn-primary" @click="router.push('/profiles'); nextStep()"> Настроить Exchange</button>
          </div>
        </template>

        <!-- ── Шаг 3: График ── -->
        <template v-else-if="step === 2">
          <h2>Рабочий график</h2>
          <p class="ob-hint">Эти данные используются для расчёта нормы часов и выделения незаполненных дней.</p>
          <label>Начало рабочего дня
            <input v-model="workdayStart" type="time" />
          </label>
          <label>Окончание рабочего дня
            <input v-model="workdayEnd" type="time" />
          </label>
          <label>Норма часов в день
            <input v-model.number="dailyHours" type="number" min="1" max="24" step="0.5" />
          </label>
          <div class="ob-days">
            <button
              v-for="(label, idx) in DAY_LABELS"
              :key="idx"
              :class="['ob-day-btn', { active: workDays.includes(idx) }]"
              @click="toggleDay(idx)"
              type="button"
            >{{ label }}</button>
          </div>
          <div v-if="error" class="ob-error">{{ error }}</div>
          <div class="ob-actions">
            <button class="ob-btn-ghost" @click="prevStep">← Назад</button>
            <button class="ob-btn-primary" :disabled="loading" @click="saveSchedule">
              {{ loading ? 'Сохранение…' : 'Далее →' }}
            </button>
          </div>
        </template>

        <!-- ── Шаг 4: Тур ── -->
        <template v-else-if="step === 3">
          <h2>Быстрый тур</h2>
          <div class="ob-tour">
            <div class="ob-tour-img">{{ TOUR_STEPS[tourStep].img }}</div>
            <h3>{{ TOUR_STEPS[tourStep].title }}</h3>
            <p>{{ TOUR_STEPS[tourStep].desc }}</p>
            <div class="ob-tour-dots">
              <span
                v-for="(_, i) in TOUR_STEPS"
                :key="i"
                :class="['ob-tour-dot', { active: i === tourStep }]"
                @click="tourStep = i"
              />
            </div>
          </div>
          <div class="ob-actions">
            <button
              v-if="tourStep > 0"
              class="ob-btn-ghost"
              @click="tourStep--"
            >←</button>
            <button
              v-if="tourStep < TOUR_STEPS.length - 1"
              class="ob-btn-secondary"
              @click="tourStep++"
            >Далее</button>
            <button
              v-else
              class="ob-btn-primary"
              @click="finish"
            >Начать работу 🎉</button>
          </div>
        </template>

      </div>
    </div>
  </div>
</template>

<style scoped>
.ob-overlay {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.45);
  z-index: 10000;
}
.ob-card {
  background: var(--color-surface, #fff);
  border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0,0,0,.22);
  width: min(560px, 96vw);
  max-height: 92vh;
  overflow-y: auto;
  padding: 2rem;
  display: flex; flex-direction: column; gap: 1.25rem;
}
.ob-header {
  display: flex; justify-content: space-between; align-items: center;
}
.ob-logo { font-size: 1.25rem; font-weight: 700; color: var(--color-primary, #01696f); }
.ob-step-label { font-size: .85rem; color: var(--color-text-muted, #888); }

.ob-progress {
  display: flex; gap: .5rem;
}
.ob-progress-dot {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  gap: .25rem; padding: .5rem .25rem;
  border-radius: 8px;
  background: var(--color-surface-offset, #f0f0f0);
  transition: background .2s;
  font-size: .75rem; text-align: center;
}
.ob-progress-dot.active { background: var(--color-primary-highlight, #cedcd8); }
.ob-progress-dot.done   { background: var(--color-success-highlight, #d4dfcc); }
.ob-progress-icon { font-size: 1.25rem; }

.ob-body { display: flex; flex-direction: column; gap: 1rem; }
.ob-body h2 { font-size: 1.25rem; font-weight: 700; color: var(--color-text, #28251d); }
.ob-body p.ob-hint { font-size: .9rem; color: var(--color-text-muted, #888); }
.ob-body a { color: var(--color-primary, #01696f); }

label {
  display: flex; flex-direction: column; gap: .35rem;
  font-size: .9rem; color: var(--color-text, #28251d);
}
input[type=text], input[type=url], input[type=email], input[type=password], input[type=time], input[type=number] {
  padding: .55rem .75rem;
  border: 1px solid var(--color-border, #d4d1ca);
  border-radius: 8px;
  background: var(--color-surface-2, #fff);
  color: var(--color-text, #28251d);
  font-size: .95rem;
  outline: none;
}
input:focus { border-color: var(--color-primary, #01696f); box-shadow: 0 0 0 3px var(--color-primary-highlight, #cedcd8); }

.ob-error   { color: var(--color-error, #a12c7b);   font-size: .88rem; }
.ob-success { color: var(--color-success, #437a22); font-size: .88rem; }

.ob-exchange-hint {
  display: flex; gap: .6rem; align-items: flex-start;
  background: var(--color-surface-offset, #f0f0f0);
  border-radius: 8px; padding: .75rem 1rem;
  font-size: .88rem; color: var(--color-text-muted, #888);
}
.ob-exchange-hint code { background: var(--color-surface-dynamic, #e6e4df); border-radius: 4px; padding: 0 .35rem; }

.ob-days { display: flex; gap: .4rem; flex-wrap: wrap; }
.ob-day-btn {
  width: 40px; height: 40px; border-radius: 50%;
  border: 2px solid var(--color-border, #d4d1ca);
  background: var(--color-surface-2, #fff);
  color: var(--color-text, #28251d);
  font-size: .82rem; font-weight: 600; cursor: pointer;
  transition: all .15s;
}
.ob-day-btn.active {
  background: var(--color-primary, #01696f);
  border-color: var(--color-primary, #01696f);
  color: #fff;
}

.ob-actions {
  display: flex; gap: .75rem; justify-content: flex-end; margin-top: .5rem;
}
.ob-btn-primary, .ob-btn-secondary, .ob-btn-ghost {
  padding: .55rem 1.25rem; border-radius: 8px;
  font-size: .95rem; font-weight: 600; cursor: pointer;
  border: none; transition: all .15s;
}
.ob-btn-primary   { background: var(--color-primary, #01696f); color: #fff; }
.ob-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.ob-btn-primary:not(:disabled):hover { background: var(--color-primary-hover, #0c4e54); }
.ob-btn-secondary { background: var(--color-surface-offset, #f0f0f0); color: var(--color-text, #28251d); }
.ob-btn-secondary:hover { background: var(--color-surface-dynamic, #e6e4df); }
.ob-btn-ghost { background: transparent; color: var(--color-text-muted, #888); }
.ob-btn-ghost:hover { color: var(--color-text, #28251d); }

.ob-tour {
  display: flex; flex-direction: column; align-items: center; gap: .75rem;
  text-align: center; padding: 1rem 0;
}
.ob-tour-img { font-size: 3.5rem; }
.ob-tour h3 { font-size: 1.1rem; font-weight: 700; }
.ob-tour p { font-size: .9rem; color: var(--color-text-muted, #888); max-width: 34ch; }
.ob-tour-dots { display: flex; gap: .5rem; justify-content: center; margin-top: .5rem; }
.ob-tour-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--color-border, #d4d1ca); cursor: pointer; transition: background .15s;
}
.ob-tour-dot.active { background: var(--color-primary, #01696f); }
</style>
