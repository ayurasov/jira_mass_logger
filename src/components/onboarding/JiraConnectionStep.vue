<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';

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

// Маппинг пользовательского authType -> instance_type в Rust-схеме
function instanceType() {
  if (form.authType === 'Basic') return 'server_basic';
  // Bearer — определяем по URL: *.atlassian.net = cloud, иначе = server
  return form.url.includes('atlassian.net') ? 'cloud' : 'server';
}

/**
 * Tauri invoke отдаёт ошибку как строку (Rust String -> IPC),
 * а не как объект с .message. Извлекаем текст универсально.
 */
function extractError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    if (typeof obj['message'] === 'string') return obj['message'];
    // Tauri v2 иногда кладёт текст в .error
    if (typeof obj['error'] === 'string') return obj['error'];
    try { return JSON.stringify(e); } catch { /* ignore */ }
  }
  return String(e);
}

async function testAndSave() {
  error.value = '';
  testing.value = true;
  try {
    // 1. Сохраняем секрет в OS keychain
    const secretRef = `jira-onboarding-${Date.now()}`;
    await invoke('save_secret', { secretRef, value: form.token });

    // 2. Проверяем подключение
    const params = {
      base_url: form.url.replace(/\/$/, ''),
      email: form.email,
      secret_ref: secretRef,
      instance_type: instanceType(),
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

    // 3. Сохраняем профиль в SQLite
    const db = await Database.load('sqlite:jiratime.db');
    await db.execute(
      `INSERT OR REPLACE INTO jira_profiles (name, base_url, email, instance_type, secret_ref)
       VALUES (?, ?, ?, ?, ?)`,
      ['Default', params.base_url, form.email, instanceType(), secretRef]
    );
    await db.close();

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
        ⚠️️ Basic Auth передаёт пароль в base64. Используйте только по HTTPS.
      </p>

      <!-- Статус -->
      <transition name="fade">
        <div v-if="error" class="step-error" role="alert">
          <span class="status-icon">⚠️</span> {{ error }}
        </div>
      </transition>
      <transition name="fade">
        <div v-if="success" class="step-success" role="status">
          <span class="status-icon">✅</span> Соединение установлено
        </div>
      </transition>

      <div class="step-actions">
  
      <!-- TLS опция для корпоративных серверов с самоподписанным сертификатом -->
      <label class="field-label field-checkbox" style="margin-top:0.25rem">
        <input type="checkbox" v-model="form.acceptInvalidCerts" />
        <span>Не проверять TLS-сертификат сервера (для самоподписанных/корпоративных)</span>
      </label>

      <button type="submit" class="btn btn-primary" :disabled="testing">
          <span v-if="testing" class="spinner" aria-hidden="true"></span>
          {{ testing ? 'Проверка…' : 'Проверить и продолжить' }}
        </button>
      </div>

    </form>
  </section>
</template>

<style scoped>
/* Макет формы */
.step-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Два поля в ряд */
.field-row {
  display: flex;
  gap: var(--space-3);
  align-items: flex-end;
}

.field-grow {
  flex: 1 1 0;
  min-width: 0;
}

.field-auth {
  flex: 0 0 200px;
}

.field-label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field-name {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--color-text-muted);
}

.field-input {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-offset);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--text-sm);
  transition: border-color var(--transition-interactive),
              box-shadow var(--transition-interactive);
}

.field-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-highlight);
}

select.field-input {
  cursor: pointer;
  appearance: auto;
}

/* Подсказка */
.step-hint {
  font-size: var(--text-xs);
  color: var(--color-warning);
  background: var(--color-warning-highlight);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
}

/* Ошибка / успех */
.step-error,
.step-success {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
}
.step-error {
  background: var(--color-error-highlight);
  color: var(--color-error);
}
.step-success {
  background: var(--color-success-highlight);
  color: var(--color-success);
}
.status-icon {
  flex-shrink: 0;
}

/* Кнопка */
.step-actions {
  padding-top: var(--space-2);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-6);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--transition-interactive),
              opacity var(--transition-interactive);
}
.btn-primary {
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border: none;
}
.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}
.btn-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* Спиннер */
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Ссылка */
.link {
  color: var(--color-primary);
  text-underline-offset: 2px;
}
.link:hover {
  color: var(--color-primary-hover);
}

/* Плавное появление/исчезновение статусов */
.fade-enter-active, .fade-leave-active { transition: opacity 200ms ease; } 
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* Адаптация под узкий экран */
@media (max-width: 480px) {
  .field-row {
    flex-direction: column;
  }
  .field-auth {
    flex: 1 1 auto;
  }
}
</style>
