<!--
  Предпросмотр импорта настроек: что есть в файле (по разделам, с галочками) и итог.
  После импорта интерфейс перезагружается — сторы читают настройки при старте.
  Используется в «Настройках» и на первом шаге онбординга.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { summarize, type SectionId, type SettingsFile } from '../utils/settingsTransfer';
import { useSettingsTransferStore } from '../store/settingsTransfer';

const props = defineProps<{ file: SettingsFile }>();
const emit = defineEmits<{ close: []; done: [] }>();

const transfer = useSettingsTransferStore();
const sections = computed(() => summarize(props.file));
const selected = ref(new Set<SectionId>(sections.value.filter((s) => !s.empty).map((s) => s.id)));
const result = ref<string[] | null>(null);
const error = ref('');

const fileInfo = computed(() => {
  const d = props.file.exportedAt ? new Date(props.file.exportedAt) : null;
  const when = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('ru-RU') : '';
  return [when && `сохранён ${when}`, props.file.appVersion && `JiraTime ${props.file.appVersion}`].filter(Boolean).join(' · ');
});

function toggle(id: SectionId, on: boolean) {
  const next = new Set(selected.value);
  if (on) next.add(id); else next.delete(id);
  selected.value = next;
}

async function run() {
  error.value = '';
  try {
    result.value = await transfer.apply(props.file, selected.value);
  } catch (e) {
    error.value = `Не удалось импортировать: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const hasPending = computed(() => transfer.pending.jira.length + transfer.pending.exchange.length > 0);
</script>

<template>
  <div class="imp-backdrop" @click.self="!transfer.busy && emit('close')">
    <div class="imp" role="dialog" aria-modal="true" aria-labelledby="imp-title">
      <h2 id="imp-title">Перенос настроек</h2>
      <template v-if="!result">
        <p v-if="fileInfo" class="imp-muted">Файл {{ fileInfo }}</p>
        <ul class="imp-list">
          <li v-for="s in sections" :key="s.id" :class="{ 'is-empty': s.empty }">
            <label>
              <input type="checkbox" :checked="selected.has(s.id)" :disabled="s.empty || transfer.busy" @change="toggle(s.id, ($event.target as HTMLInputElement).checked)" />
              <span>
                <span class="imp-title">{{ s.title }}</span>
                <span class="imp-muted">{{ s.detail }}</span>
              </span>
            </label>
          </li>
        </ul>
        <p class="imp-note">Ничего не удаляется: шаблоны, правила и избранное добавляются без дублей. Пароли и токены в файле не хранятся — для подключений их нужно будет ввести.</p>
        <p v-if="error" class="imp-error">{{ error }}</p>
        <div class="imp-actions">
          <button class="imp-btn" :disabled="transfer.busy" @click="emit('close')">Отмена</button>
          <button class="imp-btn imp-btn--primary" :disabled="transfer.busy || !selected.size" @click="run">
            {{ transfer.busy ? 'Импорт…' : 'Импортировать' }}
          </button>
        </div>
      </template>
      <template v-else>
        <p class="imp-ok">Настройки перенесены{{ result.length ? ':' : '.' }}</p>
        <ul v-if="result.length" class="imp-result"><li v-for="line in result" :key="line">{{ line }}</li></ul>
        <p v-if="hasPending" class="imp-note">Подключения из файла появятся на экране «Профили» (и в онбординге) с заполненными полями — останется ввести пароль или токен.</p>
        <div class="imp-actions">
          <button class="imp-btn imp-btn--primary" @click="emit('done')">Готово</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.imp-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(10, 14, 22, 0.5); display: flex; align-items: center; justify-content: center; padding: 1rem; }
.imp { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 0.875rem; box-shadow: 0 1rem 2.5rem rgba(0, 0, 0, 0.25); width: min(34rem, 100%); max-height: 90vh; overflow: auto; padding: 1.25rem 1.375rem; display: flex; flex-direction: column; gap: 0.75rem; }
.imp h2 { margin: 0; font-size: 1.125rem; }
.imp-muted { color: var(--muted); font-size: 0.8125rem; }
p.imp-muted { margin: 0; }
.imp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.imp-list label { display: flex; gap: 0.6rem; align-items: flex-start; padding: 0.45rem 0.5rem; border-radius: 0.5rem; cursor: pointer; }
.imp-list label:hover { background: var(--chip); }
.imp-list input { margin-top: 0.2rem; }
.imp-list li.is-empty { opacity: 0.55; }
.imp-list li.is-empty label { cursor: default; }
.imp-list span > span { display: block; }
.imp-title { font-weight: 600; font-size: 0.875rem; }
.imp-note { margin: 0; font-size: 0.8125rem; color: var(--muted); line-height: 1.45; }
.imp-error { margin: 0; color: var(--danger); font-size: 0.875rem; }
.imp-ok { margin: 0; color: var(--success); font-weight: 600; }
.imp-result { margin: 0; padding-left: 1.25rem; font-size: 0.875rem; line-height: 1.6; }
.imp-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.25rem; }
.imp-btn { border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 0.5rem; padding: 0.45rem 0.9rem; font-weight: 600; font-size: 0.875rem; cursor: pointer; }
.imp-btn:hover:not(:disabled) { background: var(--chip); }
.imp-btn--primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.imp-btn--primary:hover:not(:disabled) { background: var(--primary-hover, var(--primary)); }
.imp-btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
