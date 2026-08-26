<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import ActionIcon from '../ActionIcon.vue';

const emit = defineEmits<{ done: [] }>();

const form = reactive({
  url: '',
  email: '',
  token: '',
  authType: 'Bearer' as 'Bearer' | 'Basic',
  acceptInvalidCerts: false,
});

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
  try {
    const secretRef = `jira-onboarding-${Date.now()}`;
    await invoke('save_secret', { secretRef, value: form.token });

    const iType = instanceType();
    const params = {
      base_url: form.url.replace(/\/$/, ''),
      email: form.email,
      secret_ref: secretRef,
      instance_type: iType,
      extra_root_ca_pem_path: null,
      accept_invalid_certs: form.acceptInvalidCerts,
      proxy: null,
      user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };

    console.debug('[JiraConnectionStep] test_connection params:', {
      base_url: params.base_url,
      email: params.email,
      instance_type: params.instance_type,
      accept_invalid_certs: params.accept_invalid_certs,
      has_proxy: params.proxy !== null,
      user_timezone: params.user_timezone,
    });

    await invoke('test_connection', { params });

    await invoke('save_jira_profile', {
      profile: {
        id: null,
        name: 'Default',
        instanceType: iType,
        authType: iType === 'cloud' ? 'token' : (iType === 'server_basic' ? 'server_basic' : 'pat'),
        baseUrl: params.base_url,
        email: form.email,
        token: form.token,
        isActive: true,
      },
    });

    success.value = true;
    setTimeout(() => emit('done'), 800);
  } catch (e: unknown) {
    const msg = extractError(e);
    console.error('[JiraConnectionStep] test_connection error:', e, '| extracted:', msg);
    error.value = msg;
  } finally {
    testing.value = false;
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
      </div>

    </form>
  </section>
</template>
