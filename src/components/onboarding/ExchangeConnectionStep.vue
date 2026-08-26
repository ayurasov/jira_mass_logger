<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import ActionIcon from '../ActionIcon.vue';

const emit = defineEmits<{ done: []; skip: [] }>();

const form = reactive({
  type: 'graph' as 'graph' | 'ews',
  // Graph fields
  tenantId: '',
  clientId: '',
  profileName: 'Microsoft 365',
  // EWS fields
  ewsUrl: '',
  ewsLogin: '',
  ewsPassword: '',
  ewsAuthType: 'basic' as 'basic' | 'ntlm',
  ewsProfileName: 'Exchange On-Premise',
});

const saving = ref(false);
const error = ref('');
const oauthPending = ref(false);

function makeSecretRef(prefix: string): string {
  return `${prefix}_${Date.now()}`;
}

async function saveEws() {
  if (!form.ewsUrl || !form.ewsLogin || !form.ewsPassword) {
    error.value = 'Заполните все поля EWS';
    return;
  }
  error.value = '';
  saving.value = true;
  try {
    const secretRef = makeSecretRef('ews_pw');
    await invoke('save_secret', { secretRef, value: form.ewsPassword });
    await invoke('test_exchange_connection', {
      params: {
        authMode: 'ews',
        ewsUrl: form.ewsUrl,
        username: form.ewsLogin,
        secretRef,
        ewsAuthType: form.ewsAuthType,
      },
    });
    await invoke('save_exchange_profile', {
      profile: {
        name: form.ewsProfileName,
        authMode: 'ews',
        ewsUrl: form.ewsUrl,
        ewsAuthType: form.ewsAuthType,
        username: form.ewsLogin,
        secretRef,
        isActive: true,
      },
    });
    emit('done');
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}

async function startGraphOAuth() {
  if (!form.tenantId || !form.clientId) {
    error.value = 'Введите Tenant ID и Client ID';
    return;
  }
  error.value = '';
  saving.value = true;
  oauthPending.value = true;
  try {
    const refreshRef = makeSecretRef('graph_rt');
    await invoke('start_graph_oauth_embedded', {
      params: {
        authMode: 'graph',
        tenantId: form.tenantId,
        clientId: form.clientId,
        username: '',
        secretRef: refreshRef,
        refreshTokenSecretRef: refreshRef,
      },
    });
    const result: { ok: boolean; message: string } = await invoke(
      'complete_graph_oauth_loopback',
    );
    if (!result.ok) throw new Error(result.message);
    await invoke('save_exchange_profile', {
      profile: {
        name: form.profileName,
        authMode: 'graph',
        username: '',
        secretRef: refreshRef,
        tenantId: form.tenantId,
        clientId: form.clientId,
        refreshTokenSecretRef: refreshRef,
        isActive: true,
      },
    });
    emit('done');
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
    oauthPending.value = false;
  }
}

const isGraphReady = computed(() => form.tenantId.trim() && form.clientId.trim());
const isEwsReady = computed(() => form.ewsUrl.trim() && form.ewsLogin.trim() && form.ewsPassword.trim());
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

    <!-- Microsoft Graph -->
    <form v-if="form.type === 'graph'" class="step-form" @submit.prevent="startGraphOAuth" novalidate>
      <label class="field-label">
        <span class="field-name">Название профиля</span>
        <input v-model="form.profileName" type="text" class="field-input" />
      </label>
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
        Redirect URI для Azure AD: <code>http://localhost:43782/callback</code>
      </p>

      <transition name="fade">
        <div v-if="error" class="step-error" role="alert">
          <span class="status-icon"><ActionIcon name="warning" :size="14" /></span> {{ error }}
        </div>
      </transition>

      <div class="step-actions">
        <button type="button" class="btn btn-ghost" @click="emit('skip')">Пропустить</button>
        <button type="submit" class="btn btn-primary" :disabled="saving || !isGraphReady">
          <span v-if="oauthPending" class="spinner" aria-hidden="true"></span>
          {{ oauthPending ? 'Ожидание авторизации в браузере…' : saving ? 'Подключение…' : 'Войти через браузер' }}
        </button>
      </div>
    </form>

    <!-- EWS -->
    <form v-else class="step-form" @submit.prevent="saveEws" novalidate>
      <label class="field-label">
        <span class="field-name">Название профиля</span>
        <input v-model="form.ewsProfileName" type="text" class="field-input" />
      </label>
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
      <label class="field-label">
        <span class="field-name">Тип авторизации</span>
        <select v-model="form.ewsAuthType" class="field-input">
          <option value="basic">Basic (HTTP)</option>
          <option value="ntlm">NTLM</option>
        </select>
      </label>

      <transition name="fade">
        <div v-if="error" class="step-error" role="alert">
          <span class="status-icon"><ActionIcon name="warning" :size="14" /></span> {{ error }}
        </div>
      </transition>

      <div class="step-actions">
        <button type="button" class="btn btn-ghost" @click="emit('skip')">Пропустить</button>
        <button type="submit" class="btn btn-primary" :disabled="saving || !isEwsReady">
          <span v-if="saving" class="spinner" aria-hidden="true"></span>
          {{ saving ? 'Проверка…' : 'Подключить и продолжить' }}
        </button>
      </div>
    </form>
  </section>
</template>
