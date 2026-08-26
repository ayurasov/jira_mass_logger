<script setup lang="ts">
import { ref, reactive } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import ActionIcon from '../ActionIcon.vue';

const emit = defineEmits<{ done: []; skip: [] }>();

const form = reactive({
  type: 'graph' as 'graph' | 'ews',
  tenantId: '',
  clientId: '',
  ewsUrl: '',
  ewsLogin: '',
  ewsPassword: '',
});

const saving = ref(false);
const error = ref('');

async function save() {
  error.value = '';
  saving.value = true;
  try {
    if (form.type === 'graph') {
      await invoke('add_exchange_profile', {
        profileType: 'Graph',
        tenantId: form.tenantId,
        clientId: form.clientId,
      });
    } else {
      await invoke('add_exchange_profile', {
        profileType: 'Ews',
        ewsUrl: form.ewsUrl,
        login: form.ewsLogin,
        password: form.ewsPassword,
      });
    }
    emit('done');
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="step-section">
    <h2 class="step-title">Подключение к Exchange</h2>
    <p class="step-desc">
      Необязательно. Импортирует встречи из вашего рабочего календаря.
      <button type="button" class="btn-link" @click="emit('skip')">Пропустить →</button>
    </p>

    <div class="type-tabs">
      <button
        :class="['tab-btn', { active: form.type === 'graph' }]"
        type="button"
        @click="form.type = 'graph'"
      >Microsoft Graph (M365)</button>
      <button
        :class="['tab-btn', { active: form.type === 'ews' }]"
        type="button"
        @click="form.type = 'ews'"
      >Exchange On-Premise (EWS)</button>
    </div>

    <form class="step-form" @submit.prevent="save" novalidate>
      <template v-if="form.type === 'graph'">
        <label class="field-label">
          <span class="field-name">Tenant ID (Directory ID)</span>
          <input
            v-model="form.tenantId"
            type="text"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            required
            class="field-input"
          />
        </label>
        <label class="field-label">
          <span class="field-name">Client ID (Application ID)</span>
          <input
            v-model="form.clientId"
            type="text"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            required
            class="field-input"
          />
        </label>
        <p class="hint-text">
          Redirect URI для Azure AD:
          <code>http://localhost:37842/oauth/callback</code>
        </p>
      </template>

      <template v-else>
        <label class="field-label">
          <span class="field-name">EWS URL</span>
          <input
            v-model="form.ewsUrl"
            type="url"
            placeholder="https://mail.corp.ru/EWS/Exchange.asmx"
            required
            class="field-input"
          />
        </label>
        <label class="field-label">
          <span class="field-name">Логин (domain\user или UPN)</span>
          <input
            v-model="form.ewsLogin"
            type="text"
            required
            autocomplete="username"
            class="field-input"
          />
        </label>
        <label class="field-label">
          <span class="field-name">Пароль</span>
          <input
            v-model="form.ewsPassword"
            type="password"
            required
            autocomplete="current-password"
            class="field-input"
          />
        </label>
      </template>

      <transition name="fade">
        <div v-if="error" class="step-error" role="alert">
          <span class="status-icon"><ActionIcon name="warning" :size="14" /></span> {{ error }}
        </div>
      </transition>

      <div class="step-actions">
        <button type="button" class="btn btn-ghost" @click="emit('skip')">Пропустить</button>
        <button type="submit" class="btn btn-primary" :disabled="saving">
          <span v-if="saving" class="spinner" aria-hidden="true"></span>
          {{ saving ? 'Подключение…' : 'Подключить и продолжить' }}
        </button>
      </div>
    </form>
  </section>
</template>
