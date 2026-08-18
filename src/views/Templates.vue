<template>
  <div class="templates-page">
    <h1 class="page-title">&#x1F4CB; Шаблоны описаний</h1>
    <p class="page-hint">
      Создайте шаблоны для описаний worklog. Доступные переменные:
      <code>{date}</code>, <code>{week}</code>, <code>{week_number}</code>,
      <code>{issue}</code>, <code>{meeting_title}</code>.
    </p>

    <div class="toolbar">
      <input
        v-model="searchQuery"
        class="search-input"
        placeholder="&#x1F50D; Поиск..."
      />
      <button class="btn btn-primary" @click="openForm(null)">+ Новый шаблон</button>
    </div>

    <div v-if="filtered.length === 0" class="empty-hint">
      {{ templates.length === 0 ? 'Шаблонов пока нет.' : 'Ничего не найдено.' }}
    </div>

    <div class="template-list">
      <div
        v-for="t in filtered"
        :key="t.id"
        class="template-card"
        :class="{ pinned: t.isPinned }"
      >
        <div class="tc-header">
          <span class="tc-name">{{ t.name }}</span>
          <span class="tc-uses">исп. {{ t.useCount ?? 0 }} раз</span>
          <div class="tc-actions">
            <button class="icon-btn" :title="t.isPinned ? 'Открепить' : 'Закрепить'" @click="togglePin(t)">
              {{ t.isPinned ? '&#x1F4CC;' : '&#x1F4CD;' }}
            </button>
            <button class="icon-btn" title="Редактировать" @click="openForm(t)">&#x270F;&#xFE0F;</button>
            <button class="icon-btn danger" title="Удалить" @click="deleteTemplate(t.id)">&#x1F5D1;&#xFE0F;</button>
          </div>
        </div>
        <div class="tc-body">
          <div class="tc-text">{{ t.text }}</div>
          <div class="tc-preview" v-if="t.text">
            <span class="tc-preview-label">Превью:</span>
            {{ renderPreview(t.text) }}
          </div>
        </div>
      </div>
    </div>

    <!-- FORM MODAL -->
    <div v-if="formOpen" class="modal-backdrop" @click.self="formOpen = false">
      <div class="modal">
        <h2>{{ form.id ? 'Редактировать шаблон' : 'Новый шаблон' }}</h2>

        <label>
          Название
          <input v-model="form.name" placeholder="Например: Разработка" />
        </label>
        <label>
          Текст шаблона
          <textarea
            v-model="form.text"
            rows="4"
            placeholder="Разработка по задаче {issue} за {date}"
          />
        </label>

        <!-- Панель быстрой вставки переменных -->
        <div class="var-chips">
          <span class="var-label">Вставить:</span>
          <button
            v-for="v in VARIABLES"
            :key="v.token"
            class="var-chip"
            :title="v.desc"
            @click="insertVar(v.token)"
          >{{{ v.token }}}</button>
        </div>

        <!-- Live-превью -->
        <div v-if="form.text" class="preview-box">
          <div class="preview-box-label">Превью:</div>
          <div class="preview-box-text">{{ renderPreview(form.text) }}</div>
        </div>

        <label class="checkbox-label">
          <input type="checkbox" v-model="form.isPinned" />
          Закрепить (показывать первым)
        </label>

        <div class="modal-actions">
          <button class="btn" @click="formOpen = false">Отмена</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveTemplate">
            {{ saving ? 'Сохранение...' : 'Сохранить' }}
          </button>
        </div>
        <div v-if="formError" class="form-error">{{ formError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { format, getWeek } from 'date-fns';
import { ru } from 'date-fns/locale';

interface TemplateItem {
  id: number;
  name: string;
  text: string;
  isPinned: boolean;
  useCount: number;
}

const VARIABLES: { token: string; desc: string }[] = [
  { token: 'date',          desc: 'Текущая дата, например: 18.08.2026' },
  { token: 'week',          desc: 'Название недели' },
  { token: 'week_number',   desc: 'Номер недели в году' },
  { token: 'issue',         desc: 'Ключ задачи Jira' },
  { token: 'meeting_title', desc: 'Тема встречи из календаря' },
];

const templates = ref<TemplateItem[]>([]);
const searchQuery = ref('');
const formOpen = ref(false);
const saving = ref(false);
const formError = ref('');

const form = reactive({
  id: null as number | null,
  name: '',
  text: '',
  isPinned: false,
});

// Ref для фокуса textarea при вставке переменных
const textareaEl = ref<HTMLTextAreaElement | null>(null);

const filtered = computed(() => {
  const q = searchQuery.value.toLowerCase();
  const list = templates.value.filter(
    (t) =>
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.text.toLowerCase().includes(q),
  );
  // Сначала закреплённые, затем по частоте использования
  return [...list].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return (b.useCount ?? 0) - (a.useCount ?? 0);
  });
});

function renderPreview(text: string): string {
  const now = new Date();
  return text
    .replace(/\{date\}/g, format(now, 'dd.MM.yyyy'))
    .replace(/\{week\}/g, format(now, 'EEEE', { locale: ru }))
    .replace(/\{week_number\}/g, String(getWeek(now, { locale: ru })))
    .replace(/\{issue\}/g, 'PROJ-123')
    .replace(/\{meeting_title\}/g, 'Daily Standup');
}

async function loadTemplates() {
  try {
    templates.value = await invoke<TemplateItem[]>('list_templates');
  } catch (e) {
    console.error('list_templates:', e);
  }
}

onMounted(loadTemplates);

function openForm(t: TemplateItem | null) {
  formError.value = '';
  if (t) {
    Object.assign(form, { id: t.id, name: t.name, text: t.text, isPinned: t.isPinned });
  } else {
    Object.assign(form, { id: null, name: '', text: '', isPinned: false });
  }
  formOpen.value = true;
}

async function saveTemplate() {
  formError.value = '';
  if (!form.name.trim() || !form.text.trim()) {
    formError.value = 'Заполните название и текст.';
    return;
  }
  saving.value = true;
  try {
    await invoke('save_template', {
      template: {
        id: form.id,
        name: form.name,
        text: form.text,
        isPinned: form.isPinned,
      },
    });
    formOpen.value = false;
    await loadTemplates();
  } catch (e: any) {
    formError.value = String(e);
  } finally {
    saving.value = false;
  }
}

async function deleteTemplate(id: number) {
  if (!confirm('Удалить шаблон?')) return;
  try {
    await invoke('delete_template', { id });
    await loadTemplates();
  } catch (e) {
    console.error(e);
  }
}

async function togglePin(t: TemplateItem) {
  try {
    await invoke('save_template', {
      template: { id: t.id, name: t.name, text: t.text, isPinned: !t.isPinned },
    });
    await loadTemplates();
  } catch (e) {
    console.error(e);
  }
}

function insertVar(token: string) {
  const insertion = `{${token}}`;
  const el = document.querySelector<HTMLTextAreaElement>('.modal textarea');
  if (el) {
    const start = el.selectionStart ?? form.text.length;
    const end = el.selectionEnd ?? start;
    form.text = form.text.slice(0, start) + insertion + form.text.slice(end);
    nextTick(() => {
      el.focus();
      const pos = start + insertion.length;
      el.setSelectionRange(pos, pos);
    });
  } else {
    form.text += insertion;
  }
}
</script>

<style scoped>
.templates-page { padding: 1.5rem; max-width: 860px; }
.page-title { font-size: 1.4rem; font-weight: 700; margin-bottom: .4rem; }
.page-hint { font-size: .88rem; color: #666; margin-bottom: 1.2rem; }
.page-hint code { background: #f0f0f0; border-radius: 3px; padding: .05rem .3rem; font-size: .82rem; }
.toolbar { display: flex; gap: .8rem; margin-bottom: 1.2rem; align-items: center; }
.search-input { flex: 1; padding: .4rem .75rem; border: 1px solid var(--border, #d0d5dd); border-radius: 7px; font-size: .9rem; background: var(--input-bg, #fafafa); }
.btn { padding: .4rem .9rem; border-radius: 6px; border: 1px solid var(--border, #d0d5dd); cursor: pointer; font-size: .9rem; background: var(--surface, #fff); }
.btn-primary { background: #0052cc; color: #fff; border-color: #0052cc; }
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.empty-hint { color: #999; font-size: .9rem; padding: 1.5rem 0; text-align: center; }

.template-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
.template-card { background: var(--surface, #fff); border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,.07); padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .5rem; border: 1.5px solid transparent; transition: border-color .15s; }
.template-card.pinned { border-color: #0052cc44; }
.template-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,.12); }
.tc-header { display: flex; align-items: center; gap: .5rem; }
.tc-name { font-weight: 600; flex: 1; font-size: .95rem; }
.tc-uses { font-size: .75rem; color: #aaa; white-space: nowrap; }
.tc-actions { display: flex; gap: .1rem; }
.tc-body { font-size: .87rem; }
.tc-text { color: #333; white-space: pre-wrap; word-break: break-word; background: #f9f9f9; border-radius: 5px; padding: .45rem .6rem; font-family: monospace; font-size: .82rem; }
.tc-preview { display: flex; gap: .4rem; font-size: .82rem; color: #555; margin-top: .2rem; }
.tc-preview-label { color: #aaa; white-space: nowrap; }
.icon-btn { background: none; border: none; cursor: pointer; font-size: 1rem; padding: .2rem .3rem; border-radius: 4px; }
.icon-btn:hover { background: #f0f0f0; }
.icon-btn.danger:hover { background: #fee2e2; }

/* Modal */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--surface, #fff); border-radius: 12px; padding: 1.8rem; min-width: 460px; max-width: 560px; box-shadow: 0 8px 32px rgba(0,0,0,.18); display: flex; flex-direction: column; gap: .75rem; }
.modal h2 { margin: 0 0 .5rem; font-size: 1.1rem; }
.modal label { display: flex; flex-direction: column; gap: .2rem; font-size: .88rem; font-weight: 500; }
.modal input, .modal textarea { padding: .38rem .6rem; border: 1px solid var(--border, #d0d5dd); border-radius: 6px; font-size: .9rem; background: var(--input-bg, #fafafa); font-family: inherit; resize: vertical; }
.checkbox-label { flex-direction: row !important; align-items: center; gap: .5rem; font-weight: 400; }

.var-chips { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
.var-label { font-size: .8rem; color: #888; }
.var-chip { padding: .15rem .5rem; background: #e8eeff; color: #1a3a8f; border: none; border-radius: 4px; cursor: pointer; font-size: .8rem; font-family: monospace; }
.var-chip:hover { background: #d0daff; }

.preview-box { background: #f0f8ff; border-radius: 6px; padding: .5rem .75rem; }
.preview-box-label { font-size: .75rem; color: #888; margin-bottom: .2rem; }
.preview-box-text { font-size: .9rem; color: #333; word-break: break-word; }

.modal-actions { display: flex; justify-content: flex-end; gap: .6rem; margin-top: .5rem; }
.form-error { color: #dc2626; font-size: .85rem; }
</style>
