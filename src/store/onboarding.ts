import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export type OnboardingStep =
  | 'jira'        // Шаг 1: подключение Jira
  | 'exchange'    // Шаг 2: подключение Exchange (skиппабельный)
  | 'schedule'    // Шаг 3: рабочий график
  | 'tour';       // Шаг 4: интерактивный тур

const STEPS: OnboardingStep[] = ['jira', 'exchange', 'schedule', 'tour'];

export const useOnboardingStore = defineStore('onboarding', () => {
  const currentStep = ref<OnboardingStep>('jira');
  const jiraConnected = ref(false);
  const exchangeConnected = ref(false);
  const exchangeSkipped = ref(false);
  /** Пользовательские настройки графика */
  const scheduleHoursPerDay = ref(8);
  const scheduleDays = ref<number[]>([1, 2, 3, 4, 5]); // 1=Пн, 5=Пт

  const currentStepIndex = computed(() => STEPS.indexOf(currentStep.value));
  const isLastStep = computed(() => currentStepIndex.value === STEPS.length - 1);
  const progressPercent = computed(() =>
    Math.round(((currentStepIndex.value + 1) / STEPS.length) * 100)
  );

  function goNext() {
    const next = STEPS[currentStepIndex.value + 1];
    if (next) currentStep.value = next;
  }

  function goPrev() {
    const prev = STEPS[currentStepIndex.value - 1];
    if (prev) currentStep.value = prev;
  }

  function skipExchange() {
    exchangeSkipped.value = true;
    goNext();
  }

  /**
   * Завершает онбординг: сохраняет флаг в localStorage.
   * После этого router-guard перестанёт редиректировать на /onboarding.
   */
  function complete() {
    localStorage.setItem('jiratime-onboarding-done', '1');
  }

  return {
    currentStep,
    jiraConnected,
    exchangeConnected,
    exchangeSkipped,
    scheduleHoursPerDay,
    scheduleDays,
    currentStepIndex,
    isLastStep,
    progressPercent,
    goNext,
    goPrev,
    skipExchange,
    complete,
  };
});
