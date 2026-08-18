<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{ done: [] }>();

const tourSteps = [
  {
    icon: '⌨️',
    title: 'Ctrl+N — Быстрый трекинг',
    text: 'В любой момент нажмите Ctrl+N, чтобы открыть мастер массового логирования. Выберите задачи, укажите дни и часы — готово.',
  },
  {
    icon: '📊',
    title: 'Дашборд аналитики',
    text: 'На главном экране видно загрузку за неделю, heatmap заполненности за 3 месяца и список дней с «дырками» в worklog.',
  },
  {
    icon: '📅',
    title: 'Ctrl+L — Мой журнал',
    text: 'Ctrl+L открывает таблицу worklog. Двойной клик по ячейке — inline-редактирование. Enter сохраняет, Esc отменяет.',
  },
  {
    icon: '🔔',
    title: 'Напоминания',
    text: 'В разделе Настройки включите напоминание в конце рабочего дня. JiraTime пришлёт уведомление, если worklog не заполнен.',
  },
];

const current = ref(0);

function next() {
  if (current.value < tourSteps.length - 1) {
    current.value++;
  } else {
    emit('done');
  }
}

const isLast = () => current.value === tourSteps.length - 1;
</script>

<template>
  <section class="step-section">
    <h2 class="step-title">Быстрый тур</h2>

    <Transition name="slide-step" mode="out-in">
      <div :key="current" class="tour-card">
        <div class="tour-icon" aria-hidden="true">{{ tourSteps[current].icon }}</div>
        <h3 class="tour-card-title">{{ tourSteps[current].title }}</h3>
        <p class="tour-card-text">{{ tourSteps[current].text }}</p>
      </div>
    </Transition>

    <!-- Точки прогресса -->
    <div class="tour-dots" role="tablist" aria-label="Шаги тура">
      <button
        v-for="(_, idx) in tourSteps"
        :key="idx"
        :class="['tour-dot', { active: idx === current }]"
        role="tab"
        :aria-selected="idx === current"
        :aria-label="`Шаг ${idx + 1}`"
        @click="current = idx"
      />
    </div>

    <div class="step-actions">
      <button class="btn btn-primary" @click="next">
        {{ isLast() ? 'Начать работу 🚀' : 'Далее' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.tour-card {
  background: var(--color-surface-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-8);
  text-align: center;
  min-height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
}

.tour-icon { font-size: 3rem; }

.tour-card-title {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--color-text);
}

.tour-card-text {
  font-size: var(--text-base);
  color: var(--color-text-muted);
  max-width: 40ch;
}

.tour-dots {
  display: flex;
  justify-content: center;
  gap: var(--space-2);
}

.tour-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-border);
  transition: all var(--transition-interactive);
}

.tour-dot.active {
  background: var(--color-primary);
  width: 24px;
}
</style>
