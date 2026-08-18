<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';

const emit = defineEmits<{ done: [] }>();

const form = reactive({
  url: '',
  email: '',
  token: '',
  authType: 'Bearer' as 'Bearer' | 'Basic',
});

const testing = ref(false);
const error = ref('');
const success = ref(false);

/** true — выбран Basic (логин + пароль, Jira Server < 8.14) */
const isBasic = computed(() => form.authType === 'Basic');

const tokenLabel = computed(() =>
  isBasic.value ? 'Пароль' : 'API-токен / PAT'
);
const tokenPlaceholder = computed(() =>
  isBasic.value ? 'Введите пароль от Jira' : 'Вставьте токен'
);
const emailLabel = computed(() =>
  isBasic.value ? 'Логин (username)' : 'Email'
);
const emailPlaceholder = computed(() =>
  isBasic.value ? 'Ваш логин в Jira' : 'you@company.com'
);
const emailType = computed(() =>
  isBasic.value ? 'text' : 'email'
);

async function testAndSave() {
  error.value = '';
  testing.value = true;
  try {
    await invoke('add_jira_profile', {
      baseUrl: form.url.replace(/\/$/, ''),
      email: form.email,
      token: form.token,
      authType: form.authType,
      name: 'Default',
    });
    success.value = true;
    setTimeout(() => emit('done'), 600);
  } catch (e: any) {
    error.value = e?.message ?? String(e);
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
        Введите адрес вашего Jira и API-токен.
        <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">Получить токен →</a>
      </template>
    </p>

    <form class="step-form" @submit.prevent="testAndSave">
      <label class="field-label">
        Jira URL
        <input
          v-model="form.url"
          type="url"
          placeholder="https://jira.yourcompany.com"
          required
          autocomplete="off"
          class="field-input"
        />
      </label>

      <!-- Тип аутентификации — выбирается первым, чтобы менялись подписи ниже -->
      <label class="field-label">
        Тип аутентификации
        <select v-model="form.authType" class="field-input">
          <option value="Bearer">Bearer (Cloud / Server PAT, Jira ≥ 8.14)</option>
          <option value="Basic">Basic — логин + пароль (Jira Server &lt; 8.14)</option>
        </select>
      </label>

      <label class="field-label">
        {{ emailLabel }}
        <input
          v-model="form.email"
          :type="emailType"
          :placeholder="emailPlaceholder"
          required
          autocomplete="username"
          class="field-input"
        />
      </label>

      <label class="field-label">
        {{ tokenLabel }}
        <input
          v-model="form.token"
          type="password"
          :placeholder="tokenPlaceholder"
          required
          autocomplete="current-password"
          class="field-input"
        />
      </label>

      <!-- Подсказка для Basic -->
      <p v-if="isBasic" class="step-hint">
        ⚠️ Basic Auth передаёт пароль в base64. Используйте только по HTTPS.
      </p>

      <div v-if="error" class="step-error" role="alert">{{ error }}</div>
      <div v-if="success" class="step-success" role="status">✓ Соединение установлено</div>

      <div class="step-actions">
        <button type="submit" class="btn btn-primary" :disabled="testing">
          {{ testing ? 'Проверка…' : 'Проверить и продолжить' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.step-hint {
  font-size: var(--text-xs);
  color: var(--color-warning);
  background: var(--color-warning-highlight);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  margin-top: calc(-1 * var(--space-2));
}
</style>
