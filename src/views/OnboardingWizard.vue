<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingsStore } from '../store/settings';
import JiraConnectionStep from '../components/onboarding/JiraConnectionStep.vue';
import ExchangeConnectionStep from '../components/onboarding/ExchangeConnectionStep.vue';
import WorkScheduleStep from '../components/onboarding/WorkScheduleStep.vue';
import TourStep from '../components/onboarding/TourStep.vue';
import ActionIcon, { type ActionIconName } from '../components/ActionIcon.vue';

const router = useRouter();
const settings = useSettingsStore();

const currentStep = ref(0);

const steps: { id: string; title: string; icon: ActionIconName }[] = [
  { id: 'jira',     title: 'Подключение\nк Jira',        icon: 'link' },
  { id: 'exchange', title: 'Подключение\nк Exchange',     icon: 'bell' },
  { id: 'schedule', title: 'Рабочий\nграфик',             icon: 'clock' },
  { id: 'tour',     title: 'Быстрый\nтур',                icon: 'bolt' },
];

const isLastStep = computed(() => currentStep.value === steps.length - 1);

function next() {
  if (isLastStep.value) finish();
  else currentStep.value++;
}

function skipStep() {
  if (currentStep.value < steps.length - 1) currentStep.value++;
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

      <nav class="onboarding-steps" aria-label="Шаги настройки">
        <button
          v-for="(step, idx) in steps"
          :key="step.id"
          class="step-dot"
          :class="{ active: idx === currentStep, done: idx < currentStep }"
          :aria-current="idx === currentStep ? 'step' : undefined"
          :title="step.title.replace('\\n', ' ')"
          @click="goToStep(idx)"
        >
          <span class="step-icon"><ActionIcon :name="step.icon" :size="18" /></span>
          <span class="step-label">{{ step.title }}</span>
        </button>
      </nav>

      <div class="onboarding-body">
        <Transition name="slide-step" mode="out-in">
          <JiraConnectionStep     v-if="currentStep === 0" key="jira"     @done="next" @skip="skipStep" />
          <ExchangeConnectionStep v-else-if="currentStep === 1" key="exchange" @done="next" @skip="skipStep" />
          <WorkScheduleStep       v-else-if="currentStep === 2" key="schedule" @done="next" />
          <TourStep               v-else-if="currentStep === 3" key="tour"     @done="finish" />
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.onboarding-overlay {
  position: fixed;
  inset: 0;
  background: oklch(from var(--color-bg, #f7f6f2) l c h / 0.88);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.onboarding-card {
  background: var(--color-surface, var(--card, #ffffff));
  border: 1px solid var(--color-border, var(--border, #d8deea));
  border-radius: var(--radius-xl, 1rem);
  box-shadow: var(--shadow-lg, 0 0.75rem 2rem rgba(42,59,88,0.08));
  width: min(660px, 94vw);
  max-height: 90vh;
  overflow-y: auto;
  padding: var(--space-8, 2rem);
  display: flex;
  flex-direction: column;
  gap: var(--space-7, 1.75rem);
}

.onboarding-steps {
  display: flex;
  gap: var(--space-2, 0.5rem);
  align-items: stretch;
}

.step-dot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1, 0.25rem);
  flex: 1;
  min-width: 0;
  min-height: 72px;
  padding: var(--space-3, 0.75rem) var(--space-2, 0.5rem);
  border-radius: var(--radius-lg, 0.75rem);
  border: 1.5px solid var(--color-border, var(--border, #d8deea));
  background: var(--color-surface-offset, var(--card, var(--chip)));
  color: var(--color-text-muted, var(--muted, #5d6475));
  font-size: var(--text-xs, 0.75rem);
  line-height: 1.3;
  cursor: default;
  transition: all var(--transition-interactive, 180ms ease);
  white-space: pre-line;
  text-align: center;
}

.step-dot.done {
  color: var(--color-primary, var(--primary, #2a62ff));
  cursor: pointer;
  border-color: color-mix(in srgb, var(--color-primary, var(--primary, #2a62ff)) 30%, transparent);
}

.step-dot.active {
  background: var(--color-primary-highlight, var(--chip, #eef3ff));
  border-color: var(--color-primary, var(--primary, #2a62ff));
  color: var(--color-primary, var(--primary, #2a62ff));
  font-weight: 600;
}

.step-dot:not(.active):hover.done {
  background: var(--color-primary-highlight, var(--chip, #eef3ff));
}

.step-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.75;
}

.step-dot.active .step-icon,
.step-dot.done .step-icon { opacity: 1; }

.step-label {
  display: block;
  white-space: pre-line;
  text-align: center;
  font-size: var(--text-xs, 0.75rem);
  line-height: 1.35;
}

.slide-step-enter-active,
.slide-step-leave-active { transition: opacity 180ms ease, transform 180ms ease; }
.slide-step-enter-from   { opacity: 0; transform: translateX(20px); }
.slide-step-leave-to     { opacity: 0; transform: translateX(-20px); }
</style>

<!-- Общие стили для всех step-компонентов (non-scoped) -->
<style>
.step-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-5, 1.25rem);
}

.step-title {
  margin: 0;
  font-size: var(--text-xl, 1.5rem);
  font-weight: 700;
  color: var(--color-text, var(--fg, #1a1a1a));
  letter-spacing: -0.01em;
}

.step-desc {
  margin: 0;
  font-size: var(--text-sm, 0.875rem);
  color: var(--color-text-muted, var(--muted, #5d6475));
  line-height: 1.55;
}

.step-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4, 1rem);
}

.field-row {
  display: flex;
  gap: var(--space-4, 1rem);
  align-items: flex-end;
}

.field-grow { flex: 1 1 0; min-width: 0; }
.field-auth { flex: 0 0 210px; }

.field-label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 0.25rem);
}

.field-name {
  font-size: var(--text-xs, 0.75rem);
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--color-text-muted, var(--muted, #5d6475));
}

.field-input {
  width: 100%;
  padding: 0.55rem var(--space-3, 0.75rem);
  background: color-mix(in srgb, var(--border, #d8deea) 18%, var(--card, #fff));
  border: 1.5px solid var(--color-border, var(--border, #d8deea));
  border-radius: var(--radius-md, 0.5rem);
  color: var(--color-text, var(--fg, #1a1a1a));
  font-size: var(--text-sm, 0.875rem);
  transition: border-color 180ms ease, background 180ms ease, box-shadow 180ms ease;
}

.field-input::placeholder { color: var(--color-text-muted, var(--muted, #5d6475)); opacity: 0.6; }

.field-input:hover:not(:focus) {
  border-color: color-mix(in srgb, var(--primary, #2a62ff) 40%, var(--border, #d8deea));
}

.field-input:focus {
  outline: none;
  background: var(--card, #fff);
  border-color: var(--color-primary, var(--primary, #2a62ff));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary, #2a62ff) 18%, transparent);
}

select.field-input { cursor: pointer; appearance: auto; }
.field-input--narrow { max-width: 8rem; }

.field-checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--space-2, 0.5rem);
  font-size: var(--text-sm, 0.875rem);
  color: var(--color-text-muted, var(--muted, #5d6475));
  cursor: pointer;
  padding: var(--space-1, 0.25rem) 0;
}

.field-checkbox input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  cursor: pointer;
  accent-color: var(--color-primary, var(--primary, #2a62ff));
}

.step-hint {
  font-size: var(--text-xs, 0.75rem);
  color: var(--color-warning, var(--warning, #b97900));
  background: color-mix(in srgb, var(--warning, #b97900) 12%, var(--card, #fff));
  border-radius: var(--radius-sm, 0.375rem);
  padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
  display: flex;
  align-items: center;
  gap: var(--space-1, 0.25rem);
}

.hint-text {
  font-size: var(--text-xs, 0.75rem);
  color: var(--color-text-muted, var(--muted, #5d6475));
  margin-top: var(--space-1, 0.25rem);
}

.step-error,
.step-success {
  display: flex;
  align-items: center;
  gap: var(--space-2, 0.5rem);
  padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
  border-radius: var(--radius-md, 0.5rem);
  font-size: var(--text-sm, 0.875rem);
}

.step-error   { background: color-mix(in srgb, var(--danger, #cb2b2b) 10%, var(--card, #fff)); color: var(--color-error, var(--danger, #cb2b2b)); }
.step-success { background: color-mix(in srgb, var(--success, #1c8c4e) 10%, var(--card, #fff)); color: var(--color-success, var(--success, #1c8c4e)); }
.status-icon  { flex-shrink: 0; }

.step-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3, 0.75rem);
  padding-top: var(--space-3, 0.75rem);
  flex-wrap: wrap;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2, 0.5rem);
  padding: 0.55rem var(--space-6, 1.5rem);
  border-radius: var(--radius-md, 0.5rem);
  font-size: var(--text-sm, 0.875rem);
  font-weight: 600;
  cursor: pointer;
  border: 1.5px solid transparent;
  white-space: nowrap;
  transition: background 180ms ease, border-color 180ms ease, opacity 180ms ease, box-shadow 180ms ease;
}

.btn-primary {
  background: var(--color-primary, var(--primary, #2a62ff));
  color: #ffffff;
  border-color: var(--color-primary, var(--primary, #2a62ff));
  box-shadow: 0 1px 4px color-mix(in srgb, var(--primary, #2a62ff) 35%, transparent);
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover, var(--primary-strong, #1f4fd3));
  border-color: var(--color-primary-hover, var(--primary-strong, #1f4fd3));
}

.btn-primary:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: none;
}

.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-ghost {
  background: transparent;
  color: var(--color-text-muted, var(--muted, #5d6475));
  border-color: var(--color-border, var(--border, #d8deea));
}

.btn-ghost:hover:not(:disabled) {
  background: var(--color-surface-offset, var(--chip, #eef3ff));
  color: var(--color-text, var(--fg, #1a1a1a));
}

.btn-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-primary, var(--primary, #2a62ff));
  font-size: var(--text-sm, 0.875rem);
  font-weight: 500;
  cursor: pointer;
  text-underline-offset: 2px;
  text-decoration: underline;
}

.btn-link:hover { color: var(--color-primary-hover, var(--primary-strong, #1f4fd3)); }

.link { color: var(--color-primary, var(--primary, #2a62ff)); text-underline-offset: 2px; }
.link:hover { color: var(--color-primary-hover, var(--primary-strong, #1f4fd3)); }
.link-btn { border: none; background: none; padding: 0; font: inherit; cursor: pointer; text-decoration: underline; }
/* Перенос настроек на первом шаге */
.step-transfer, .step-from-file { margin: 0; font-size: var(--text-sm, 0.875rem); color: var(--color-text-muted, var(--muted, #5d6475)); }
.step-from-file { display: flex; align-items: center; gap: 0.4rem; color: var(--success, #1a7f37); }
.step-error-inline { margin: 0; font-size: var(--text-sm, 0.875rem); color: var(--danger, #c62828); }

/* Табы (Exchange) */
.type-tabs {
  display: flex;
  gap: var(--space-2, 0.5rem);
  border-bottom: 1.5px solid var(--color-border, var(--border, #d8deea));
  padding-bottom: var(--space-2, 0.5rem);
}

.tab-btn {
  padding: var(--space-2, 0.5rem) var(--space-4, 1rem);
  border-radius: var(--radius-md, 0.5rem);
  border: 1.5px solid var(--color-border, var(--border, #d8deea));
  background: var(--color-surface-offset, var(--card, #fff));
  color: var(--color-text-muted, var(--muted, #5d6475));
  font-size: var(--text-sm, 0.875rem);
  font-weight: 500;
  cursor: pointer;
  transition: all 180ms ease;
}

.tab-btn.active {
  background: var(--color-primary-highlight, var(--chip, #eef3ff));
  border-color: var(--color-primary, var(--primary, #2a62ff));
  color: var(--color-primary, var(--primary, #2a62ff));
  font-weight: 600;
}

.tab-btn:hover:not(.active) {
  color: var(--color-text, var(--fg, #1a1a1a));
  background: var(--chip, #eef3ff);
}

/* Дни недели (WorkSchedule) */
.day-toggles {
  display: flex;
  gap: var(--space-2, 0.5rem);
  flex-wrap: wrap;
  margin-top: var(--space-2, 0.5rem);
}

.day-btn {
  min-width: 2.75rem;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-md, 0.5rem);
  border: 1.5px solid var(--color-border, var(--border, #d8deea));
  background: var(--color-surface-offset, var(--card, #ffffff));
  color: var(--color-text-muted, var(--muted, #5d6475));
  font-size: var(--text-sm, 0.875rem);
  font-weight: 500;
  cursor: pointer;
  transition: all 180ms ease;
  text-align: center;
}

.day-btn.active {
  background: var(--color-primary-highlight, var(--chip, #eef3ff));
  border-color: var(--color-primary, var(--primary, #2a62ff));
  color: var(--color-primary, var(--primary, #2a62ff));
  font-weight: 700;
}

.day-btn:hover:not(.active) {
  background: var(--chip, #eef3ff);
  color: var(--color-text, var(--fg, #1a1a1a));
}

/* Спиннер */
.spinner {
  width: 0.875rem;
  height: 0.875rem;
  border: 2px solid rgba(255,255,255,0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
