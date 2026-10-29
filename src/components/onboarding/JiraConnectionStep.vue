<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import ActionIcon from '../ActionIcon.vue';
import SettingsImportDialog from '../SettingsImportDialog.vue';
import { useSettingsTransferStore } from '../../store/settingsTransfer';
import type { SettingsFile } from '../../utils/settingsTransfer';

const emit = defineEmits<{ done: []; skip: [] }>();

// Переезд с другого компьютера: подключение из файла настроек заполняет форму —
// остаётся ввести токен или пароль.
const transfer = useSettingsTransferStore();
const fromFile = transfer.pending.jira[0] ?? null;

const form = reactive({
  url: fromFile?.baseUrl ?? '',
  email: fromFile?.email ?? '',
  token: '',
  authType: (fromFile?.authType === 'server_basic' ? 'Basic' : 'Bearer') as 'Bearer' | 'Basic',
  acceptInvalidCerts: fromFile?.acceptInvalidCerts ?? false,
});

const importFile = ref<SettingsFile | null>(null);
const importError = ref('');
// После импорта перезагружаем интерфейс: сторы читают настройки при запуске.
function reloadApp() {
  window.location.reload();
}

async function pickSettingsFile() {
  importError.value = '';
  try {
    importFile.value = await transfer.pickFile();
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e);
  }
}

const testing = ref(false);
const error  = ref('');
const success = ref(false);

const isBasic = computed(() => form.authType === 'Basic');

function instanceType() {
  if (form.authType === 'Basic') return 'server_basic';
  return form.url.includes('atlassian.net') ? 'cloud' : 'server';
}

function extractError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    if (typeof obj['message'] === 'string') return obj['message'];
    if (typeof obj['error'] === 'string') return obj['error'];
    try { return JSON.stringify(e); } catch { /* ignore */ }
  }
  return String(e);
}

async function testAndSave() {
  error.value = '';
  testing.value = true;
  const secretRef = `jira-onboarding-${Date.now()}`;
  try {
    await invoke('save_secret', { secretRef, value: form.token });

    const iType = instanceType();
    const params = {
      baseUrl: form.url.replace(/\/$/, ''),
      email: form.email,
      secretRef,
      instanceType: iType,
      extraRootCaPemPath: null,
      acceptInvalidCerts: form.acceptInvalidCerts,
      proxy: null,
      userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };

    console.debug('[JiraConnectionStep] test_connection params:', {
      baseUrl: params.baseUrl,
      email: params.email,
      instanceType: params.instanceType,
      acceptInvalidCerts: params.acceptInvalidCerts,
      hasProxy: params.proxy !== null,
      userTimezone: params.userTimezone,
    });

    await invoke('test_connection', { params });

    await invoke('save_jira_profile', {
      profile: {
        id: null,
        name: fromFile?.name || 'Default',
        instanceType: iType,
        authType: iType === 'cloud' ? 'token' : (iType === 'server_basic' ? 'server_basic' : 'pat'),
        baseUrl: params.baseUrl,
        email: form.email,
        token: form.token,
        isActive: true,
        // Без этого флаг действовал только на проверку подключения, а все
        // последующие запросы к Jira с самоподписанным сертификатом падали.
        acceptInvalidCerts: form.acceptInvalidCerts,
      },
    });

    transfer.resolveJira(params.baseUrl, form.email);
    success.value = true;
    setTimeout(() => emit('done'), 800);
  } catch (e: unknown) {
    const msg = extractError(e);
    console.error('[JiraConnectionStep] test_connection error:', e, '| extracted:', msg);
    error.value = msg;
  } finally {
    testing.value = false;
    // Временный секрет нужен только для проверки: профиль сохраняет свой собственный.
    invoke('delete_secret', { secretRef }).catch(() => {});
  }
}
</script>

<template>
  <section class="step-section">
    <h2 class="step-title">Подключение к Jira</h2>

    <p class="step-desc">
      <template v-if="isBasic">
        Jira Server без PAT — войдите через логин и пароль (Basic Auth).
      </template>
      <template v-else>
        Введите адрес Jira и API-токен.
        <a
          href="https://id.atlassian.com/manage-profile/security/api-tokens"
          target="_blank"
          rel="noopener noreferrer"
          class="link"
        >Получить токен →</a>
      </template>
    </p>

    <p v-if="fromFile" class="step-from-file">
      <ActionIcon name="check-circle" :size="14" /> Подключение «{{ fromFile.name }}» взято из файла настроек — введите токен или пароль.
    </p>
    <p v-else class="step-transfer">
      Переезжаете с другого компьютера?
      <button type="button" class="link link-btn" @click="pickSettingsFile">Загрузить настройки из файла</button>
    </p>
    <p v-if="importError" class="step-error-inline">{{ importError }}</p>
    <SettingsImportDialog v-if="importFile" :file="importFile" @close="importFile = null" @done="reloadApp" />

    <form class="step-form" @submit.prevent="testAndSave" novalidate>

      <!-- Ряд 1: URL + тип -->
      <div class="field-row">
        <label class="field-label field-grow">
          <span class="field-name">Jira URL</span>
          <input
            v-model="form.url"
            type="url"
            placeholder="https://jira.yourcompany.com"
            required
            autocomplete="off"
            class="field-input"
          />
        </label>

        <label class="field-label field-auth">
          <span class="field-name">Тип аутентификации</span>
          <select v-model="form.authType" class="field-input">
            <option value="Bearer">Bearer / PAT (≥ 8.14)</option>
            <option value="Basic">Basic — логин + пароль (&lt; 8.14)</option>
          </select>
        </label>
      </div>

      <!-- Ряд 2: Логин / Email + Пароль / Токен -->
      <div class="field-row">
        <label class="field-label field-grow">
          <span class="field-name">{{ isBasic ? 'Логин (username)' : 'Email' }}</span>
          <input
            v-model="form.email"
            :type="isBasic ? 'text' : 'email'"
            :placeholder="isBasic ? 'Ваш логин в Jira' : 'you@company.com'"
            required
            autocomplete="username"
            class="field-input"
          />
        </label>

        <label class="field-label field-grow">
          <span class="field-name">{{ isBasic ? 'Пароль' : 'API-токен / PAT' }}</span>
          <input
            v-model="form.token"
            type="password"
            :placeholder="isBasic ? 'Пароль от Jira' : 'Вставьте токен'"
            required
            autocomplete="current-password"
            class="field-input"
          />
        </label>
      </div>

      <!-- Подсказка Basic -->
      <p v-if="isBasic" class="step-hint">
        <ActionIcon name="warning" :size="13" /> Basic Auth передаёт пароль в base64. Используйте только по HTTPS.
      </p>

      <!-- TLS опция -->
      <label class="field-label field-checkbox">
        <input type="checkbox" v-model="form.acceptInvalidCerts" />
        <span>Не проверять TLS-сертификат сервера (для самоподписанных/корпоративных)</span>
      </label>

      <!-- Статус -->
      <transition name="fade">
        <div v-if="error" class="step-error" role="alert">
          <span class="status-icon"><ActionIcon name="warning" :size="14" /></span> {{ error }}
        </div>
      </transition>
      <transition name="fade">
        <div v-if="success" class="step-success" role="status">
          <span class="status-icon"><ActionIcon name="check-circle" :size="14" /></span> Соединение установлено
        </div>
      </transition>

      <div class="step-actions">
        <button type="submit" class="btn btn-primary" :disabled="testing">
          <span v-if="testing" class="spinner" aria-hidden="true"></span>
          {{ testing ? 'Проверка…' : 'Проверить и продолжить' }}
        </button>
        <button type="button" class="btn btn-ghost" @click="emit('skip')">
          Пропустить
        </button>
      </div>

    </form>
  </section>
</template>
