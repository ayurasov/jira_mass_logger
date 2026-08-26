<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingsStore } from '../store/settings';
import { useJiraProfilesStore } from '../store/jiraProfiles';
import JiraConnectionStep from '../components/onboarding/JiraConnectionStep.vue';
import ExchangeConnectionStep from '../components/onboarding/ExchangeConnectionStep.vue';
import WorkScheduleStep from '../components/onboarding/WorkScheduleStep.vue';
import TourStep from '../components/onboarding/TourStep.vue';
import ActionIcon, { type ActionIconName } from '../components/ActionIcon.vue';

const router = useRouter();
const settings = useSettingsStore();
const jiraProfiles = useJiraProfilesStore();

const currentStep = ref(0);

const steps: { id: string; title: string; icon: ActionIconName }[] = [
  { id: 'jira',     title: 'Подключение к Jira',        icon: 'link' },
  { id: 'exchange', title: 'Подключение к Exchange',     icon: 'bell' },
  { id: 'schedule', title: 'Рабочий график',             icon: 'clock' },
  { id: 'tour',     title: 'Быстрый тур',                icon: 'bolt' },
];

const isLastStep = computed(() => currentStep.value === steps.length - 1);

function next() {
  if (isLastStep.value) {
    finish();
  } else {
    currentStep.value++;
  }
}

function skip() {
  // Exchange step is optional — skip directly to schedule
  if (currentStep.value === 1) {
    currentStep.value = 2;
  }
}

function finish() {
  settings.setOnboardingDone(true);
  router.replace({ name: 'dashboard' });
}

function goToStep(idx: number) {
  if (idx < currentStep.value) currentStep.value = idx;
}
</script>

<template>
  <div class="onboarding-overlay">
    <div class="onboarding-card" role="dialog" aria-modal="true" aria-label="Мастер первоначальной настройки">
      <!-- Прогресс -->
      <nav class="onboarding-steps" aria-label="Шаги настройки">
        <button
          v-for="(step, idx) in steps"
          :key="step.id"
          class="step-dot"
          :class="{ active: idx === currentStep, done: idx < currentStep }"
          :aria-current="idx === currentStep ? 'step' : undefined"
          :title="step.title"
          @click="goToStep(idx)"
        >
          <span class="step-icon"><ActionIcon :name="step.icon" :size="20" /></span>
          <span class="step-label">{{ step.title }}</span>
        </button>
      </nav>

      <!-- Шаги -->
      <div class="onboarding-body">
        <Transition name="slide-step" mode="out-in">
          <JiraConnectionStep
            v-if="currentStep === 0"
            key="jira"
            @done="next"
          />
          <ExchangeConnectionStep
            v-else-if="currentStep === 1"
            key="exchange"
            @done="next"
            @skip="skip"
          />
          <WorkScheduleStep
            v-else-if="currentStep === 2"
            key="schedule"
            @done="next"
          />
          <TourStep
            v-else-if="currentStep === 3"
            key="tour"
            @done="finish"
          />
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.onboarding-overlay {
  position: fixed;
  inset: 0;
  background: oklch(from var(--color-bg) l c h / 0.92);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.onboarding-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  width: min(640px, 94vw);
  max-height: 90vh;
  overflow-y: auto;
  padding: var(--space-8);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

/* Прогресс-шаги */
.onboarding-steps {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  overflow-x: auto;
  padding-bottom: var(--space-2);
}

.step-dot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  flex: 1;
  min-width: 80px;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  border: 2px solid transparent;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  cursor: default;
  transition: all var(--transition-interactive);
}

.step-dot.done {
  color: var(--color-primary);
  cursor: pointer;
}

.step-dot.active {
  background: var(--color-primary-highlight);
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}

.step-icon { display: inline-flex; align-items: center; justify-content: center; }

/* Анимация переходов между шагами */
.slide-step-enter-active,
.slide-step-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}
.slide-step-enter-from {
  opacity: 0;
  transform: translateX(24px);
}
.slide-step-leave-to {
  opacity: 0;
  transform: translateX(-24px);
}

@media (min-resolution: 120dpi) {
  .onboarding-card {
    width: min(600px, 90vw);
  }
}
</style>

<!-- Общие стили для всех step-компонентов (non-scoped, доступны дочерним) -->
<style>
/* ── Секция шага ── */
.step-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.step-title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 700;
  color: var(--color-text);
}

.step-desc {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: 1.5;
}

/* ── Форма шага ── */
.step-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* ── Строка полей ── */
.field-row {
  display: flex;
  gap: var(--space-3);
  align-items: flex-end;
}

.field-grow { flex: 1 1 0; min-width: 0; }
.field-auth { flex: 0 0 200px; }

/* ── Поля ── */
.field-label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field-name {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--color-text-muted);
}

.field-input {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-offset);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--text-sm);
  transition: border-color var(--transition-interactive),
              box-shadow var(--transition-interactive);
}

.field-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-highlight);
}

select.field-input {
  cursor: pointer;
  appearance: auto;
}

.field-input--narrow { max-width: 8rem; }

/* ── Чекбокс-строка ── */
.field-checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  cursor: pointer;
}

.field-checkbox input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  cursor: pointer;
}

/* ── Подсказки ── */
.step-hint {
  font-size: var(--text-xs);
  color: var(--color-warning);
  background: var(--color-warning-highlight);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.hint-text {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  margin-top: var(--space-1);
}

/* ── Статусы ── */
.step-error,
.step-success {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
}

.step-error {
  background: var(--color-error-highlight);
  color: var(--color-error);
}

.step-success {
  background: var(--color-success-highlight);
  color: var(--color-success);
}

.status-icon { flex-shrink: 0; }

/* ── Кнопки ── */
.step-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-top: var(--space-2);
  flex-wrap: wrap;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-6);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background var(--transition-interactive),
              opacity var(--transition-interactive);
}

.btn-primary {
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-color: var(--color-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}

.btn-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn-ghost {
  background: transparent;
  color: var(--color-text-muted);
  border-color: var(--color-border);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--color-surface-offset);
  color: var(--color-text);
}

.btn-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-primary);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  text-underline-offset: 2px;
  text-decoration: underline;
}

.btn-link:hover { color: var(--color-primary-hover); }

/* ── Ссылка ── */
.link {
  color: var(--color-primary);
  text-underline-offset: 2px;
}
.link:hover { color: var(--color-primary-hover); }

/* ── Табы (Exchange) ── */
.type-tabs {
  display: flex;
  gap: var(--space-2);
  border-bottom: 1px solid var(--color-border);
  padding-bottom: var(--space-2);
}

.tab-btn {
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-surface-offset);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-interactive);
}

.tab-btn.active {
  background: var(--color-primary-highlight);
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}

.tab-btn:hover:not(.active) {
  background: var(--color-surface-offset);
  color: var(--color-text);
}

/* ── Дни недели (WorkSchedule) ── */
.day-toggles {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-2);
}

.day-btn {
  min-width: 2.5rem;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-surface-offset);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-interactive);
}

.day-btn.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-text-inverse);
  font-weight: 600;
}

.day-btn:hover:not(.active) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

/* ── Спиннер ── */
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ob-spin 0.7s linear infinite;
  display: inline-block;
}

@keyframes ob-spin { to { transform: rotate(360deg); } }

/* ── Fade-анимация ── */
.fade-enter-active, .fade-leave-active { transition: opacity 200ms ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ── Адаптация под узкий экран ── */
@media (max-width: 480px) {
  .field-row { flex-direction: column; }
  .field-auth { flex: 1 1 auto; }
}
</style>
