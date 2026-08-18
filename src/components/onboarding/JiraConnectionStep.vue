<script setup lang="ts">
import { ref, reactive } from 'vue';
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
      Введите адрес вашего Jira и API-токен.
      <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">Получить токен →</a>
    </p>

    <form class="step-form" @submit.prevent="testAndSave">
      <label class="field-label">
        Jira URL
        <input
          v-model="form.url"
          type="url"
          placeholder="https://yourcompany.atlassian.net"
          required
          autocomplete="off"
          class="field-input"
        />
      </label>

      <label class="field-label">
        Email
        <input
          v-model="form.email"
          type="email"
          placeholder="you@company.com"
          required
          autocomplete="email"
          class="field-input"
        />
      </label>

      <label class="field-label">
        Тип аутентификации
        <select v-model="form.authType" class="field-input">
          <option value="Bearer">Bearer (Cloud / Server PAT)</option>
          <option value="Basic">Basic (устаревшее)</option>
        </select>
      </label>

      <label class="field-label">
        API-токен / PAT
        <input
          v-model="form.token"
          type="password"
          placeholder="Вставьте токен"
          required
          autocomplete="current-password"
          class="field-input"
        />
      </label>

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
