<script setup lang="ts">
import { reactive } from 'vue';
import { useSettingsStore } from '../../store/settings';

const emit = defineEmits<{ done: [] }>();
const settings = useSettingsStore();

const form = reactive({
  workdayHours: settings.workdayHours ?? 8,
  workdays: settings.workdays ?? [1, 2, 3, 4, 5], // Пн–Пт
  timezone: settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
});

const DAYS = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 0, label: 'Вс' },
];

function toggleDay(d: number) {
  const idx = form.workdays.indexOf(d);
  if (idx >= 0) form.workdays.splice(idx, 1);
  else form.workdays.push(d);
}

function save() {
  settings.setWorkSchedule({
    workdayHours: form.workdayHours,
    workdays: [...form.workdays],
    timezone: form.timezone,
  });
  emit('done');
}
</script>

<template>
  <section class="step-section">
    <h2 class="step-title">Рабочий график</h2>
    <p class="step-desc">Используется для расчёта плановой нормы часов на дашборде.</p>

    <form class="step-form" @submit.prevent="save">
      <label class="field-label">
        Часов в рабочем дне
        <input
          v-model.number="form.workdayHours"
          type="number"
          min="1" max="24" step="0.5"
          required
          class="field-input field-input--narrow"
        />
      </label>

      <fieldset class="field-label">
        <legend>Рабочие дни</legend>
        <div class="day-toggles">
          <button
            v-for="day in DAYS"
            :key="day.value"
            type="button"
            :class="['day-btn', { active: form.workdays.includes(day.value) }]"
            :aria-pressed="form.workdays.includes(day.value)"
            @click="toggleDay(day.value)"
          >
            {{ day.label }}
          </button>
        </div>
      </fieldset>

      <label class="field-label">
        Часовой пояс
        <input
          v-model="form.timezone"
          type="text"
          placeholder="Europe/Moscow"
          class="field-input"
        />
        <span class="hint-text">Определён автоматически. Изменяйте только при необходимости.</span>
      </label>

      <div class="step-actions">
        <button type="submit" class="btn btn-primary">Сохранить и продолжить</button>
      </div>
    </form>
  </section>
</template>
