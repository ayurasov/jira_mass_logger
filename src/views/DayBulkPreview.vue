<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useDayFromCalendarStore } from '../store/dayFromCalendar';

const store = useDayFromCalendarStore();
const router = useRouter();
const submitting = ref(false);
const results = ref<{ issueKey: string; success: boolean; error?: string | null }[]>([]);
const done = ref(false);

onMounted(() => {
  if (store.bulkPreview.length === 0) router.replace('/day-from-calendar');
});

function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

async function submit() {
  submitting.value = true;
  try {
    const res = await store.logBulk(store.bulkPreview);
    results.value = res.map((r) => ({
      issueKey: r.issueKey ?? '?',
      success: r.success,
      error: r.error,
    }));
    done.value = true;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="preview-page">
    <div class="preview-header">
      <button @click="router.back()" class="btn-back">← Назад</button>
      <h2>Предпросмотр: залогировать весь день</h2>
    </div>

    <div v-if="!done">
      <p class="preview-hint">Проверьте список записей и нажмите «Залогировать всё».</p>
      <table class="preview-table">
        <thead>
          <tr>
            <th>Встреча</th>
            <th>Задача</th>
            <th>Время начала</th>
            <th>Длительность</th>
            <th>Комментарий</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in store.bulkPreview" :key="item.event.id">
            <td>{{ item.event.subject }}</td>
            <td>
              <strong>{{ item.issueKey }}</strong>
              <span v-if="item.issueSummary" class="td-summary"> {{ item.issueSummary }}</span>
            </td>
            <td class="td-mono">{{ item.startedLocal.slice(0, 16).replace('T', ' ') }}</td>
            <td>{{ fmtDuration(item.roundedSeconds) }}</td>
            <td>{{ item.comment }}</td>
          </tr>
        </tbody>
      </table>
      <div class="preview-footer">
        <span>Всего записей: <strong>{{ store.bulkPreview.length }}</strong></span>
        <button @click="submit" :disabled="submitting" class="btn-submit">
          {{ submitting ? 'Логируем…' : '✅ Залогировать всё' }}
        </button>
      </div>
    </div>

    <div v-else class="results">
      <h3>Результаты</h3>
      <div
        v-for="(r, i) in results"
        :key="i"
        class="result-row"
        :class="r.success ? 'ok' : 'fail'">
        <span>{{ r.success ? '✅' : '❌' }}</span>
        <strong>{{ r.issueKey }}</strong>
        <span v-if="!r.success" class="err-msg">{{ r.error }}</span>
      </div>
      <button @click="router.push('/day-from-calendar')" class="btn-back btn-done">
        ← Вернуться к дню
      </button>
    </div>
  </div>
</template>

<style scoped>
.preview-page { padding: 16px; max-width: 960px; }
.preview-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.btn-back {
  background: none; border: 1px solid var(--border, #ddd);
  border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 13px;
}
.preview-hint { color: #666; font-size: 13px; margin-bottom: 8px; }
.preview-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.preview-table th,
.preview-table td { padding: 6px 10px; border: 1px solid var(--border, #ddd); text-align: left; }
.preview-table thead { background: var(--surface2, #f4f5f7); }
.td-summary { color: #666; font-size: 11px; }
.td-mono { font-family: monospace; font-size: 12px; }
.preview-footer {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border, #ddd);
}
.btn-submit {
  padding: 6px 20px; background: var(--accent, #0052cc); color: #fff;
  border: none; border-radius: 4px; cursor: pointer; font-size: 14px;
}
.btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
.results { display: flex; flex-direction: column; gap: 6px; }
.result-row {
  display: flex; gap: 8px; align-items: center;
  padding: 6px 10px; border-radius: 4px; font-size: 13px;
}
.result-row.ok   { background: #d4edda; }
.result-row.fail { background: #f8d7da; }
.err-msg { color: #721c24; font-size: 11px; }
.btn-done { margin-top: 16px; }
</style>
