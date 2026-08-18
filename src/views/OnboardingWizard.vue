<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingsStore } from '../store/settings';
import { useJiraProfilesStore } from '../store/jiraProfiles';
import JiraConnectionStep from '../components/onboarding/JiraConnectionStep.vue';
import ExchangeConnectionStep from '../components/onboarding/ExchangeConnectionStep.vue';
import WorkScheduleStep from '../components/onboarding/WorkScheduleStep.vue';
import TourStep from '../components/onboarding/TourStep.vue';

const router = useRouter();
const settings = useSettingsStore();
const jiraProfiles = useJiraProfilesStore();

const currentStep = ref(0);

const steps = [
  { id: 'jira',     title: 'Подключение к Jira',        icon: '🔗' },
  { id: 'exchange', title: 'Подключение к Exchange',     icon: '📅' },
  { id: 'schedule', title: 'Рабочий график',             icon: '⏱️' },
  { id: 'tour',     title: 'Быстрый тур',                icon: '🚀' },
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
          <span class="step-icon">{{ step.icon }}</span>
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

.step-icon { font-size: 1.5em; }

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

/* Масштабирование Windows 125-200%: используем em-единицы */
@media (min-resolution: 120dpi) {
  .onboarding-card {
    width: min(600px, 90vw);
  }
}
</style>
