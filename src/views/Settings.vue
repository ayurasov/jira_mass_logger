<template>
  <div class="settings-screen">
    <h2>Настройки</h2>

    <section class="settings-card">
      <h3>Интеграция с календарём Microsoft Exchange / Outlook</h3>

      <div class="form-grid">
        <label>
          Тип подключения
          <select v-model="form.authMode">
            <option value="graph">Microsoft Graph (рекомендуется)</option>
            <option value="ews">EWS / On-Prem Exchange</option>
          </select>
        </label>

        <label>
          Логин / UPN
          <input v-model="form.username" placeholder="user@company.com" />
        </label>

        <template v-if="form.authMode === 'graph'">
          <label>
            Tenant ID
            <input v-model="form.tenantId" placeholder="common или GUID tenant" />
          </label>

          <label>
            Client ID
            <input v-model="form.clientId" placeholder="Azure App Registration Client ID" />
          </label>

          <label>
            Secret ref для refresh token
            <input v-model="form.refreshTokenSecretRef" placeholder="exchange-graph-refresh-token" />
          </label>
        </template>

        <template v-else>
          <label>
            EWS URL
            <input v-model="form.ewsUrl" placeholder="https://mail.company.local/EWS/Exchange.asmx" />
          </label>

          <label>
            Тип авторизации EWS
            <select v-model="form.ewsAuthType">
              <option value="basic">Basic</option>
              <option value="ntlm">NTLM / Negotiate (best effort)</option>
            </select>
          </label>

          <label>
            Secret ref для пароля
            <input v-model="form.secretRef" placeholder="exchange-ews-password" />
          </label>
        </template>

        <label>
          Минимальная длительность встречи, мин
          <input v-model.number="form.minEventMinutes" type="number" min="0" />
        </label>

        <label class="checkbox-row">
          <input v-model="form.excludeDeclined" type="checkbox" />
          Исключать отклонённые встречи
        </label>

        <label class="checkbox-row">
          <input v-model="form.excludeFreeBusy" type="checkbox" />
          Исключать free / OOF / пустые фоновые события
        </label>
      </div>

      <div class="actions-row">
        <button class="btn btn--primary" :disabled="busy || form.authMode !== 'graph'" @click="connectGraph">
          {{ busy ? 'Подключение…' : 'Войти через Microsoft Graph' }}
        </button>
        <button class="btn btn--secondary" :disabled="busy" @click="testAccess">
          {{ busy ? 'Проверка…' : 'Проверить доступ к календарю' }}
        </button>
      </div>

      <p v-if="message" :class="['status-text', success ? 'status-text--ok' : 'status-text--error']">
        {{ message }}
      </p>

      <div class="policy-hint">
        <strong>Примечание для корпоративных Windows/Intune окружений:</strong>
        если встроенный WebView2 или OAuth redirect блокируется политиками, приложение покажет явную ошибку.
        В таком случае используйте loopback fallback (локальный redirect `http://127.0.0.1:43891/callback`) и проверьте,
        что политика не запрещает embedded browser sign-in.
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { tauriApi, type ExchangeConnectionParams } from '../lib/tauriApi';

const busy = ref(false);
const message = ref('');
const success = ref(false);

const form = reactive<ExchangeConnectionParams>({
  authMode: 'graph',
  username: '',
  secretRef: 'exchange-ews-password',
  tenantId: 'common',
  clientId: '',
  refreshTokenSecretRef: 'exchange-graph-refresh-token',
  ewsUrl: '',
  minEventMinutes: 0,
  excludeDeclined: true,
  excludeFreeBusy: true,
  ewsAuthType: 'basic',
});

function cloneParams(): ExchangeConnectionParams {
  return {
    authMode: form.authMode,
    username: form.username,
    secretRef: form.secretRef,
    tenantId: form.tenantId,
    clientId: form.clientId,
    refreshTokenSecretRef: form.refreshTokenSecretRef,
    ewsUrl: form.ewsUrl,
    minEventMinutes: form.minEventMinutes,
    excludeDeclined: form.excludeDeclined,
    excludeFreeBusy: form.excludeFreeBusy,
    ewsAuthType: form.ewsAuthType,
  };
}

async function connectGraph() {
  busy.value = true;
  success.value = false;
  message.value = '';
  try {
    await tauriApi.startGraphOauthEmbedded(cloneParams());
    const result = await tauriApi.completeGraphOauthLoopback();
    success.value = result.ok;
    message.value = result.message;
  } catch (err) {
    success.value = false;
    message.value = String(err);
  } finally {
    busy.value = false;
  }
}

async function testAccess() {
  busy.value = true;
  success.value = false;
  message.value = '';
  try {
    const ok = await tauriApi.testExchangeConnection(cloneParams());
    success.value = ok;
    message.value = ok
      ? 'Доступ к календарю подтверждён.'
      : 'Проверка подключения не прошла.';
  } catch (err) {
    success.value = false;
    message.value = String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.settings-screen {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
}

.settings-card {
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 0.75rem;
  padding: 1rem 1.25rem;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 0.875rem;
}

.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.9rem;
}

.form-grid input,
.form-grid select {
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 0.5rem;
}

.checkbox-row {
  flex-direction: row !important;
  align-items: center;
  gap: 0.5rem !important;
  padding-top: 1.75rem;
}

.actions-row {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
  flex-wrap: wrap;
}

.btn {
  border: none;
  border-radius: 0.5rem;
  padding: 0.65rem 0.95rem;
  font-weight: 600;
  cursor: pointer;
}

.btn--primary {
  background: var(--color-primary, #3366ff);
  color: #fff;
}

.btn--secondary {
  background: var(--color-surface-alt, #eef2f7);
  color: var(--color-text, #111827);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.status-text {
  margin-top: 1rem;
  font-size: 0.95rem;
}

.status-text--ok { color: #1b8a3d; }
.status-text--error { color: #c92a2a; }

.policy-hint {
  margin-top: 1rem;
  font-size: 0.875rem;
  line-height: 1.45;
  color: var(--color-text-muted, #6b7280);
}
</style>
