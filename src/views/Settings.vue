<template>
  <div class="settings-screen">
    <h2>Настройки</h2>

    <!-- ──────────── Exchange profiles list ──────────── -->
    <section class="settings-card">
      <div class="card-header">
        <h3>Профили Exchange / Outlook</h3>
        <button class="btn btn--primary btn--sm" @click="startCreate">+ Добавить профиль</button>
      </div>

      <p v-if="profiles.length === 0" class="muted">
        Нет сохранённых профилей. Нажмите «Добавить профиль» для настройки доступа к календарю.
      </p>

      <table v-else class="profiles-table">
        <thead>
          <tr>
            <th>Название</th>
            <th>Режим</th>
            <th>Логин</th>
            <th>Активный</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in profiles" :key="p.id ?? -1" :class="{ 'row--active': p.isActive }">
            <td>{{ p.name }}</td>
            <td>{{ p.authMode === 'graph' ? 'Microsoft Graph' : 'EWS' }}</td>
            <td>{{ p.username }}</td>
            <td>
              <span v-if="p.isActive" class="badge badge--ok">✓ Активный</span>
              <button v-else class="btn btn--ghost btn--sm" :disabled="busy" @click="setActive(p)">
                Сделать активным
              </button>
            </td>
            <td class="actions-cell">
              <button class="btn btn--ghost btn--sm" :disabled="busy" @click="startEdit(p)">Изменить</button>
              <button class="btn btn--danger btn--sm" :disabled="busy" @click="confirmDelete(p)">Удалить</button>
              <button
                v-if="p.authMode === 'graph'"
                class="btn btn--secondary btn--sm"
                :disabled="busy"
                @click="connectGraph(p)"
              >
                OAuth↗
              </button>
              <button class="btn btn--secondary btn--sm" :disabled="busy" @click="testProfile(p)">
                Тест
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ──────────── Edit / create form ──────────── -->
    <section v-if="editing" class="settings-card">
      <h3>{{ form.id == null ? 'Новый профиль' : 'Редактировать профиль' }}</h3>

      <div class="form-grid">
        <label class="span-2">
          Название профиля
          <input v-model="form.name" placeholder="Рабочий Exchange" />
        </label>

        <label>
          тип подключения
          <select v-model="form.authMode">
            <option value="graph">Microsoft Graph (рекомендуется)</option>
            <option value="ews">EWS / On-Prem Exchange</option>
          </select>
        </label>

        <label>
          Логин / UPN
          <input v-model="form.username" placeholder="user@company.com" />
        </label>

        <!-- Graph fields -->
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
            Secret ref (для хранения refresh token)
            <input v-model="form.refreshTokenSecretRef" placeholder="exchange-graph-refresh-token" />
            <span class="hint">Ключ в системном keyring — не сам токен.</span>
          </label>

          <label>
            Secret ref (пустой — для Graph не нужен, оставьте любой)
            <input v-model="form.secretRef" placeholder="exchange-graph-placeholder" />
          </label>
        </template>

        <!-- EWS fields -->
        <template v-else>
          <label>
            EWS URL
            <input v-model="form.ewsUrl" placeholder="https://mail.company.local/EWS/Exchange.asmx" />
          </label>

          <label>
            тип авторизации EWS
            <select v-model="form.ewsAuthType">
              <option value="basic">Basic</option>
              <option value="ntlm">NTLM (полный handshake через SSPI)</option>
            </select>
          </label>

          <label>
            Secret ref для пароля
            <input v-model="form.secretRef" placeholder="exchange-ews-password" />
            <span class="hint">Ключ в системном keyring/Credential Manager — не сам пароль.</span>
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

        <label class="checkbox-row">
          <input v-model="form.isActive" type="checkbox" />
          Сделать активным (заменит текущий активный профиль)
        </label>
      </div>

      <div class="actions-row">
        <button class="btn btn--primary" :disabled="busy" @click="saveProfile">
          {{ busy ? 'Сохранение…' : (form.id == null ? 'Создать' : 'Сохранить изменения') }}
        </button>
        <button class="btn btn--secondary" :disabled="busy" @click="cancelEdit">Отмена</button>
      </div>

      <p v-if="message" :class="['status-text', success ? 'status-text--ok' : 'status-text--error']">
        {{ message }}
      </p>
    </section>

    <!-- ──────────── Global status (test / OAuth) ──────────── -->
    <p v-if="!editing && message" :class="['status-text', success ? 'status-text--ok' : 'status-text--error']" style="padding: 0 1.5rem">
      {{ message }}
    </p>

    <!-- ──────────── Danger zone: сброс настроек ──────────── -->
    <section class="settings-card danger-zone">
      <div class="card-header">
        <h3>Сброс настроек</h3>
      </div>
      <p class="muted">
        Удалит все профили Jira и Exchange, сохранённые токены/пароли в системном
        keychain и общие настройки, а затем запустит онбординг заново. Используйте,
        если экран «Профили» или мастер логирования ведут себя некорректно после ошибки или
        неудачного обновления.
      </p>
      <button class="btn btn--danger" :disabled="resetting" @click="resetAppData">
        {{ resetting ? 'Сброс…' : 'Сбросить настройки и пройти онбординг заново' }}
      </button>
      <p v-if="resetMessage" :class="['status-text', resetSuccess ? 'status-text--ok' : 'status-text--error']">
        {{ resetMessage }}
      </p>
    </section>

    <div class="policy-hint">
      <strong>Примечание для корпоративных Windows / Intune окружений:</strong>
      если встроенный WebView2 или OAuth redirect блокируется политиками, приложение покажет явную ошибку.
      В таком случае проверьте, что политика не запрещает embedded browser sign-in, или используйте EWS с NTLM.
      Пароли и токены хранятся в системном keyring (Windows Credential Manager) по ключу secret&nbsp;ref.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import {
  tauriApi,
  profileToConnectionParams,
  type ExchangeProfileDto,
} from '../lib/tauriApi';
import { useSettingsStore } from '../store/settings';

const settingsStore = useSettingsStore();

const busy = ref(false);
const message = ref('');
const success = ref(false);
const editing = ref(false);

const resetting = ref(false);
const resetMessage = ref('');
const resetSuccess = ref(false);

const profiles = ref<ExchangeProfileDto[]>([]);

function makeBlankForm(): ExchangeProfileDto {
  return {
    id: null,
    name: '',
    authMode: 'graph',
    username: '',
    secretRef: 'exchange-graph-placeholder',
    tenantId: 'common',
    clientId: '',
    refreshTokenSecretRef: 'exchange-graph-refresh-token',
    ewsUrl: '',
    ewsAuthType: 'basic',
    minEventMinutes: 0,
    excludeDeclined: true,
    excludeFreeBusy: true,
    isActive: false,
  };
}

const form = reactive<ExchangeProfileDto>(makeBlankForm());

async function loadProfiles() {
  try {
    profiles.value = await tauriApi.listExchangeProfiles();
  } catch (err) {
    message.value = `Ошибка загрузки профилей: ${err}`;
    success.value = false;
  }
}

onMounted(loadProfiles);

function startCreate() {
  Object.assign(form, makeBlankForm());
  message.value = '';
  editing.value = true;
}

function startEdit(p: ExchangeProfileDto) {
  Object.assign(form, { ...p });
  message.value = '';
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  message.value = '';
}

async function saveProfile() {
  if (!form.name.trim()) {
    message.value = 'Укажите название профиля.';
    success.value = false;
    return;
  }
  if (!form.username.trim()) {
    message.value = 'Укажите логин / UPN.';
    success.value = false;
    return;
  }
  busy.value = true;
  message.value = '';
  try {
    const id = await tauriApi.saveExchangeProfile({ ...form });
    message.value = `Профиль сохранён (id=${id}).`;
    success.value = true;
    editing.value = false;
    await loadProfiles();
  } catch (err) {
    message.value = String(err);
    success.value = false;
  } finally {
    busy.value = false;
  }
}

async function confirmDelete(p: ExchangeProfileDto) {
  if (!p.id) return;
  if (!confirm(`Удалить профиль «${p.name}»?`)) return;
  busy.value = true;
  message.value = '';
  try {
    await tauriApi.deleteExchangeProfile(p.id);
    message.value = `Профиль «${p.name}» удалён.`;
    success.value = true;
    await loadProfiles();
  } catch (err) {
    message.value = String(err);
    success.value = false;
  } finally {
    busy.value = false;
  }
}

async function setActive(p: ExchangeProfileDto) {
  if (!p.id) return;
  busy.value = true;
  message.value = '';
  try {
    await tauriApi.saveExchangeProfile({ ...p, isActive: true });
    message.value = `Профиль «${p.name}» выбран активным.`;
    success.value = true;
    await loadProfiles();
  } catch (err) {
    message.value = String(err);
    success.value = false;
  } finally {
    busy.value = false;
  }
}

async function connectGraph(p: ExchangeProfileDto) {
  busy.value = true;
  success.value = false;
  message.value = '';
  try {
    await tauriApi.startGraphOauthEmbedded(profileToConnectionParams(p));
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

async function testProfile(p: ExchangeProfileDto) {
  busy.value = true;
  success.value = false;
  message.value = '';
  try {
    const ok = await tauriApi.testExchangeConnection(profileToConnectionParams(p));
    success.value = ok;
    message.value = ok
      ? `Профиль «${p.name}»: доступ к календарю подтверждён.`
      : `Профиль «${p.name}»: проверка не прошла.`;
  } catch (err) {
    success.value = false;
    message.value = String(err);
  } finally {
    busy.value = false;
  }
}

/**
 * Полный сброс локальных данных: вызывает Rust-команду `reset_app_data`
 * (удаляет профили Jira/Exchange, settings и связанные секреты в OS keychain),
 * сбрасывает флаг onboardingDone и перезагружает окно, чтобы мастер
 * онбординга заработал с чистого листа.
 */
async function resetAppData() {
  if (!confirm('Удалить все профили и настройки и пройти онбординг заново? Отменить нельзя.')) return;
  resetting.value = true;
  resetMessage.value = '';
  try {
    await invoke('reset_app_data');
    localStorage.removeItem('jiratime-onboarding-done');
    localStorage.removeItem('jiratime-work-schedule');
    settingsStore.setOnboardingDone(false);
    resetSuccess.value = true;
    resetMessage.value = 'Данные сброшены. Перезагрузка приложения…';
    setTimeout(() => window.location.reload(), 600);
  } catch (err) {
    resetSuccess.value = false;
    resetMessage.value = String(err);
  } finally {
    resetting.value = false;
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

.danger-zone {
  border-color: #f3c2c2;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.card-header h3 { margin: 0; }

.profiles-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.profiles-table th,
.profiles-table td {
  padding: 0.55rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
}

.profiles-table th { font-weight: 600; color: var(--color-text-muted, #6b7280); }
.row--active { background: var(--color-surface-alt, #f0f5ff); }

.actions-cell {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.badge {
  display: inline-block;
  padding: 0.2rem 0.55rem;
  border-radius: 9999px;
  font-size: 0.8rem;
  font-weight: 600;
}

.badge--ok { background: #d1fae5; color: #065f46; }

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 0.875rem;
}

.form-grid .span-2 { grid-column: span 2; }

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

.hint {
  font-size: 0.78rem;
  color: var(--color-text-muted, #6b7280);
  line-height: 1.35;
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
  white-space: nowrap;
}

.btn--sm { padding: 0.4rem 0.7rem; font-size: 0.85rem; }

.btn--primary { background: var(--color-primary, #3366ff); color: #fff; }
.btn--secondary { background: var(--color-surface-alt, #eef2f7); color: var(--color-text, #111827); }
.btn--ghost { background: transparent; color: var(--color-primary, #3366ff); text-decoration: underline; padding-left: 0; padding-right: 0; }
.btn--danger { background: #c92a2a; color: #fff; align-self: flex-start; }
.btn--danger.btn--sm { background: transparent; color: #c92a2a; text-decoration: underline; padding-left: 0; padding-right: 0; }

.btn:disabled { opacity: 0.6; cursor: not-allowed; }

.muted { color: var(--color-text-muted, #6b7280); font-size: 0.9rem; }

.status-text { margin-top: 1rem; font-size: 0.95rem; }
.status-text--ok { color: #1b8a3d; }
.status-text--error { color: #c92a2a; }

.policy-hint {
  padding: 0.75rem 1.25rem;
  font-size: 0.875rem;
  line-height: 1.45;
  color: var(--color-text-muted, #6b7280);
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 0.75rem;
}
</style>
