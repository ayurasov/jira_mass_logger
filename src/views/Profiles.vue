<template>
  <div class="profiles-page">
    <h1 class="page-title">&#x1F517; Подключения</h1>

    <!-- JIRA PROFILES -->
    <section class="card">
      <div class="card-header">
        <span class="card-title">Jira</span>
        <button class="btn btn-primary" @click="openJiraForm(null)">+ Добавить</button>
      </div>

      <div v-if="jiraProfiles.length === 0" class="empty-hint">Профилей Jira нет. Добавьте первый.</div>
      <table v-else class="profile-table">
        <thead>
          <tr>
            <th>&#x2714;</th><th>Название</th><th>URL</th><th>Тип</th><th>Пользователь</th><th>Авторизация</th><th>Статус</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in jiraProfiles" :key="p.id" :class="{ active: p.isActive }">
            <td>
              <button class="icon-btn" :title="p.isActive ? 'Активен' : 'Сделать активным'" @click="setJiraActive(p.id)">
                {{ p.isActive ? '&#x1F7E2;' : '&#x26AA;' }}
              </button>
            </td>
            <td class="name-cell">{{ p.name }}</td>
            <td class="url-cell">{{ p.baseUrl }}</td>
            <td><span class="badge" :class="p.instanceType">{{ p.instanceType }}</span></td>
            <td>{{ p.email }}</td>
            <td>
              <span class="badge" :class="p.authType || 'token'">{{ authTypeLabel(p.authType) }}</span>
            </td>
            <td>
              <span v-if="jiraTestResults[p.id] === 'ok'" class="status-ok">&#x2705; OK</span>
              <span v-else-if="jiraTestResults[p.id] === 'err'" class="status-err">&#x274C; Ошибка</span>
              <span v-else-if="jiraTestResults[p.id] === 'testing'" class="status-testing">⏳</span>
              <span v-else class="status-none">—</span>
            </td>
            <td class="actions-cell">
              <button class="icon-btn" title="Тест" @click="testJiraProfile(p)">&#x1F50C;</button>
              <button class="icon-btn" title="Редактировать" @click="openJiraForm(p)">&#x270F;&#xFE0F;</button>
              <button class="icon-btn danger" title="Удалить" @click="deleteJiraProfile(p.id)">&#x1F5D1;&#xFE0F;</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- EXCHANGE PROFILES -->
    <section class="card" style="margin-top:1.5rem">
      <div class="card-header">
        <span class="card-title">Microsoft Exchange / Outlook</span>
        <button class="btn btn-primary" @click="openExchForm(null)">+ Добавить</button>
      </div>

      <div v-if="exchProfiles.length === 0" class="empty-hint">Профилей Exchange нет.</div>
      <table v-else class="profile-table">
        <thead>
          <tr>
            <th>&#x2714;</th><th>Название</th><th>Режим</th><th>URL / Tenant</th><th>Пользователь</th><th>Статус</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in exchProfiles" :key="p.id" :class="{ active: p.isActive }">
            <td>
              <button class="icon-btn" @click="setExchActive(p.id)">
                {{ p.isActive ? '&#x1F7E2;' : '&#x26AA;' }}
              </button>
            </td>
            <td class="name-cell">{{ p.name }}</td>
            <td><span class="badge" :class="p.authMode">{{ p.authMode === 'graph' ? 'Graph OAuth2' : 'EWS' }}</span></td>
            <td class="url-cell">{{ p.authMode === 'graph' ? (p.tenantId || '—') : (p.ewsUrl || '—') }}</td>
            <td>{{ p.username }}</td>
            <td>
              <span v-if="exchTestResults[p.id] === 'ok'" class="status-ok">&#x2705; OK</span>
              <span v-else-if="exchTestResults[p.id] === 'err'" class="status-err">&#x274C; Ошибка</span>
              <span v-else-if="exchTestResults[p.id] === 'testing'" class="status-testing">⏳</span>
              <span v-else class="status-none">—</span>
            </td>
            <td class="actions-cell">
              <button class="icon-btn" title="Тест" @click="testExchProfile(p)">&#x1F50C;</button>
              <button class="icon-btn" title="Редактировать" @click="openExchForm(p)">&#x270F;&#xFE0F;</button>
              <button class="icon-btn danger" title="Удалить" @click="deleteExchProfile(p.id)">&#x1F5D1;&#xFE0F;</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- JIRA FORM MODAL -->
    <div v-if="jiraFormOpen" class="modal-backdrop" @click.self="jiraFormOpen = false">
      <div class="modal">
        <h2>{{ jiraForm.id ? 'Редактирование Jira-профиля' : 'Новый Jira-профиль' }}</h2>

        <label>Название <input v-model="jiraForm.name" placeholder="Work Jira" /></label>

        <label>Тип инстанса
          <select v-model="jiraForm.instanceType" @change="onInstanceTypeChange">
            <option value="cloud">Cloud (atlassian.net)</option>
            <option value="server">Server / Data Center</option>
          </select>
        </label>

        <label>Base URL <input v-model="jiraForm.baseUrl" :placeholder="jiraForm.instanceType === 'cloud' ? 'https://yourorg.atlassian.net' : 'https://jira.corp.local'" /></label>

        <!-- Auth type — only shown for Server; Cloud always uses API Token -->
        <template v-if="jiraForm.instanceType === 'server'">
          <label>Способ авторизации
            <select v-model="jiraForm.authType">
              <option value="pat">Personal Access Token (PAT) — Jira ≥ 8.14</option>
              <option value="server_basic">Логин + Пароль (Basic Auth) — Jira &lt; 8.14 / без PAT</option>
            </select>
          </label>
          <div v-if="jiraForm.authType === 'server_basic'" class="auth-hint">
            ⚠️ Basic Auth передаёт пароль в заголовке Authorization (Base64). Убедитесь, что соединение по HTTPS.
            Пароль сохраняется в Windows Credential Manager, а не в базе приложения.
          </div>
          <div v-else class="auth-hint">
            PAT появился в Jira Server 8.14. Для более ранних версий (например, 8.3.x) выберите «Логин + Пароль».
          </div>
        </template>

        <label>{{ jiraForm.instanceType === 'cloud' ? 'Email' : 'Логин (username)' }}
          <input v-model="jiraForm.email" :placeholder="jiraForm.instanceType === 'cloud' ? 'user@example.com' : 'john.smith'" />
        </label>

        <!-- Credential field changes by authType -->
        <label v-if="jiraForm.instanceType === 'cloud' || jiraForm.authType === 'pat'">
          {{ jiraForm.instanceType === 'cloud' ? 'API Token' : 'Personal Access Token (PAT)' }}
          <input v-model="jiraForm.token" type="password"
            :placeholder="jiraForm.instanceType === 'cloud' ? 'Atlassian API token' : 'Jira Server PAT'"
            autocomplete="new-password" />
          <span class="hint" v-if="jiraForm.instanceType === 'cloud'">
            Получить: <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">id.atlassian.com → API tokens</a>
          </span>
          <span class="hint" v-else>
            Создать в Jira: Профиль → Personal Access Tokens (требуется Jira ≥ 8.14)
          </span>
        </label>

        <label v-else-if="jiraForm.authType === 'server_basic'">
          Пароль
          <input v-model="jiraForm.token" type="password"
            placeholder="Пароль от учётной записи Jira"
            autocomplete="new-password" />
        </label>

        <label class="checkbox-label">
          <input type="checkbox" v-model="jiraForm.isActive" /> Сделать активным
        </label>

        <div class="modal-actions">
          <button class="btn" @click="jiraFormOpen = false">Отмена</button>
          <button class="btn btn-primary" :disabled="jiraSaving" @click="saveJiraProfile">
            {{ jiraSaving ? 'Сохранение...' : 'Сохранить' }}
          </button>
        </div>
        <div v-if="jiraFormError" class="form-error">{{ jiraFormError }}</div>
      </div>
    </div>

    <!-- EXCHANGE FORM MODAL -->
    <div v-if="exchFormOpen" class="modal-backdrop" @click.self="exchFormOpen = false">
      <div class="modal">
        <h2>{{ exchForm.id ? 'Редактирование Exchange-профиля' : 'Новый Exchange-профиль' }}</h2>
        <label>Название <input v-model="exchForm.name" placeholder="Corporate Calendar" /></label>
        <label>Режим
          <select v-model="exchForm.authMode">
            <option value="graph">Microsoft Graph API (OAuth2)</option>
            <option value="ews">EWS (on-premise Exchange)</option>
          </select>
        </label>
        <template v-if="exchForm.authMode === 'graph'">
          <label>Tenant ID <input v-model="exchForm.tenantId" placeholder="your-tenant-id.onmicrosoft.com" /></label>
          <label>Client ID <input v-model="exchForm.clientId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></label>
          <label>Пользователь (UPN) <input v-model="exchForm.username" placeholder="user@corp.com" /></label>
          <div class="oauth-hint">
            После сохранения нажмите «Авторизация Graph» — откроется окно браузера Microsoft.
          </div>
          <button v-if="exchForm.clientId && exchForm.tenantId" class="btn btn-secondary" :disabled="oauthInProgress" @click="startOAuth">
            {{ oauthInProgress ? 'Ожидание авторизации...' : '&#x1F511; Авторизация Graph' }}
          </button>
          <div v-if="oauthResult" :class="oauthResult.ok ? 'status-ok' : 'status-err'">{{ oauthResult.message }}</div>
        </template>
        <template v-else>
          <label>EWS URL <input v-model="exchForm.ewsUrl" placeholder="https://mail.corp.com/EWS/Exchange.asmx" /></label>
          <label>Авторизация
            <select v-model="exchForm.ewsAuthType">
              <option value="basic">Basic</option>
              <option value="ntlm">NTLM (Windows only)</option>
            </select>
          </label>
          <label>Пользователь <input v-model="exchForm.username" placeholder="DOMAIN\\user" /></label>
          <label>Пароль <input v-model="exchForm.password" type="password" autocomplete="new-password" /></label>
        </template>
        <div class="filters-section">
          <div class="filters-title">Фильтры событий</div>
          <label class="checkbox-label">
            <input type="checkbox" v-model="exchForm.excludeDeclined" /> Исключать отклонённые
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="exchForm.excludeFreeBusy" /> Исключать Free/OOF/пустые
          </label>
          <label>Мин. длительность (мин)
            <input type="number" v-model.number="exchForm.minEventMinutes" min="0" style="width:80px" />
          </label>
        </div>
        <label class="checkbox-label">
          <input type="checkbox" v-model="exchForm.isActive" /> Сделать активным
        </label>
        <div class="modal-actions">
          <button class="btn" @click="exchFormOpen = false">Отмена</button>
          <button class="btn btn-primary" :disabled="exchSaving" @click="saveExchProfile">
            {{ exchSaving ? 'Сохранение...' : 'Сохранить' }}
          </button>
        </div>
        <div v-if="exchFormError" class="form-error">{{ exchFormError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open as openUrl } from '@tauri-apps/plugin-opener';

// ────────── Types ──────────

interface JiraProfile {
  id: number;
  name: string;
  instanceType: string;
  /** 'token' (Cloud API token) | 'pat' (Server PAT) | 'server_basic' (login+password) */
  authType?: string;
  baseUrl: string;
  email: string;
  secretRef: string;
  isActive: boolean;
}

interface ExchProfile {
  id: number;
  name: string;
  authMode: string;
  ewsUrl?: string;
  ewsAuthType?: string;
  username: string;
  secretRef: string;
  tenantId?: string;
  clientId?: string;
  refreshTokenSecretRef?: string;
  minEventMinutes?: number;
  excludeFreeBusy?: boolean;
  excludeDeclined?: boolean;
  isActive: boolean;
}

// ────────── State ──────────

const jiraProfiles = ref<JiraProfile[]>([]);
const exchProfiles = ref<ExchProfile[]>([]);
const jiraTestResults = reactive<Record<number, 'ok' | 'err' | 'testing' | undefined>>({});
const exchTestResults = reactive<Record<number, 'ok' | 'err' | 'testing' | undefined>>({});

// Jira form
const jiraFormOpen = ref(false);
const jiraSaving = ref(false);
const jiraFormError = ref('');
const jiraForm = reactive({
  id: null as number | null,
  name: '',
  instanceType: 'cloud',
  /** 'token' | 'pat' | 'server_basic' */
  authType: 'token',
  baseUrl: '',
  email: '',
  token: '',
  isActive: false,
});

// Exchange form
const exchFormOpen = ref(false);
const exchSaving = ref(false);
const exchFormError = ref('');
const oauthInProgress = ref(false);
const oauthResult = ref<{ ok: boolean; message: string } | null>(null);
const exchForm = reactive({
  id: null as number | null,
  name: '',
  authMode: 'graph',
  ewsUrl: '',
  ewsAuthType: 'basic',
  username: '',
  password: '',
  tenantId: '',
  clientId: '',
  minEventMinutes: 0,
  excludeFreeBusy: true,
  excludeDeclined: true,
  isActive: false,
});

// ────────── Helpers ──────────

function authTypeLabel(authType?: string): string {
  switch (authType) {
    case 'pat': return 'PAT';
    case 'server_basic': return 'Basic Auth';
    case 'token': return 'API Token';
    default: return authType ?? 'API Token';
  }
}

/**
 * When user switches instance type, reset authType to sensible default:
 * - cloud  → 'token'
 * - server → 'server_basic' (safe default; user can switch to 'pat' manually)
 */
function onInstanceTypeChange() {
  jiraForm.authType = jiraForm.instanceType === 'cloud' ? 'token' : 'server_basic';
}

// ────────── Load ──────────

async function loadProfiles() {
  try {
    jiraProfiles.value = await invoke<JiraProfile[]>('list_jira_profiles');
  } catch (e) {
    console.error('list_jira_profiles:', e);
  }
  try {
    exchProfiles.value = await invoke<ExchProfile[]>('list_exchange_profiles');
  } catch (e) {
    console.error('list_exchange_profiles:', e);
  }
}

onMounted(loadProfiles);

// ────────── Jira actions ──────────

function openJiraForm(p: JiraProfile | null) {
  jiraFormError.value = '';
  if (p) {
    Object.assign(jiraForm, {
      id: p.id,
      name: p.name,
      instanceType: p.instanceType,
      authType: p.authType ?? (p.instanceType === 'cloud' ? 'token' : 'server_basic'),
      baseUrl: p.baseUrl,
      email: p.email,
      token: '',
      isActive: p.isActive,
    });
  } else {
    Object.assign(jiraForm, {
      id: null,
      name: '',
      instanceType: 'cloud',
      authType: 'token',
      baseUrl: '',
      email: '',
      token: '',
      isActive: false,
    });
  }
  jiraFormOpen.value = true;
}

async function saveJiraProfile() {
  jiraFormError.value = '';
  if (!jiraForm.name || !jiraForm.baseUrl || !jiraForm.email) {
    jiraFormError.value = 'Заполните название, URL и логин/email.';
    return;
  }
  if (!jiraForm.token) {
    const credLabel = jiraForm.authType === 'server_basic' ? 'пароль' : 'токен';
    jiraFormError.value = `Введите ${credLabel} (поле не может быть пустым при сохранении новых учётных данных).`;
    return;
  }
  jiraSaving.value = true;
  try {
    await invoke('save_jira_profile', {
      profile: {
        id: jiraForm.id,
        name: jiraForm.name,
        instanceType: jiraForm.instanceType,
        authType: jiraForm.instanceType === 'cloud' ? 'token' : jiraForm.authType,
        baseUrl: jiraForm.baseUrl,
        email: jiraForm.email,
        token: jiraForm.token || null,
        isActive: jiraForm.isActive,
      },
    });
    jiraFormOpen.value = false;
    await loadProfiles();
  } catch (e: any) {
    jiraFormError.value = String(e);
  } finally {
    jiraSaving.value = false;
  }
}

async function setJiraActive(id: number) {
  try {
    await invoke('save_jira_profile', {
      profile: {
        ...jiraProfiles.value.find((p) => p.id === id),
        id,
        isActive: true,
        token: null,
      },
    });
    await loadProfiles();
  } catch (e) {
    console.error(e);
  }
}

async function testJiraProfile(p: JiraProfile) {
  jiraTestResults[p.id] = 'testing';
  try {
    const ok = await invoke<boolean>('test_jira_connection', {
      profileId: p.id,
    });
    jiraTestResults[p.id] = ok ? 'ok' : 'err';
  } catch {
    jiraTestResults[p.id] = 'err';
  }
}

async function deleteJiraProfile(id: number) {
  if (!confirm('Удалить профиль Jira?')) return;
  try {
    await invoke('delete_jira_profile', { id });
    await loadProfiles();
  } catch (e) {
    console.error(e);
  }
}

// ────────── Exchange actions ──────────

function openExchForm(p: ExchProfile | null) {
  exchFormError.value = '';
  oauthResult.value = null;
  if (p) {
    Object.assign(exchForm, {
      id: p.id, name: p.name, authMode: p.authMode,
      ewsUrl: p.ewsUrl || '', ewsAuthType: p.ewsAuthType || 'basic',
      username: p.username, password: '',
      tenantId: p.tenantId || '', clientId: p.clientId || '',
      minEventMinutes: p.minEventMinutes || 0,
      excludeFreeBusy: p.excludeFreeBusy ?? true,
      excludeDeclined: p.excludeDeclined ?? true,
      isActive: p.isActive,
    });
  } else {
    Object.assign(exchForm, {
      id: null, name: '', authMode: 'graph',
      ewsUrl: '', ewsAuthType: 'basic',
      username: '', password: '', tenantId: '', clientId: '',
      minEventMinutes: 0, excludeFreeBusy: true, excludeDeclined: true, isActive: false,
    });
  }
  exchFormOpen.value = true;
}

async function saveExchProfile() {
  exchFormError.value = '';
  if (!exchForm.name || !exchForm.username) {
    exchFormError.value = 'Заполните название и пользователя.';
    return;
  }
  exchSaving.value = true;
  try {
    let secretRef = `exchange_${exchForm.username}`;
    if (exchForm.authMode === 'ews' && exchForm.password) {
      await invoke('set_secret', { key: secretRef, value: exchForm.password });
    }
    await invoke('save_exchange_profile', {
      profile: {
        id: exchForm.id,
        name: exchForm.name,
        authMode: exchForm.authMode,
        ewsUrl: exchForm.ewsUrl || null,
        ewsAuthType: exchForm.ewsAuthType,
        username: exchForm.username,
        secretRef,
        tenantId: exchForm.tenantId || null,
        clientId: exchForm.clientId || null,
        refreshTokenSecretRef: exchForm.authMode === 'graph' ? `${secretRef}_refresh` : null,
        minEventMinutes: exchForm.minEventMinutes,
        excludeFreeBusy: exchForm.excludeFreeBusy,
        excludeDeclined: exchForm.excludeDeclined,
        isActive: exchForm.isActive,
      },
    });
    exchFormOpen.value = false;
    await loadProfiles();
  } catch (e: any) {
    exchFormError.value = String(e);
  } finally {
    exchSaving.value = false;
  }
}

async function setExchActive(id: number) {
  const p = exchProfiles.value.find((x) => x.id === id);
  if (!p) return;
  try {
    await invoke('save_exchange_profile', {
      profile: { ...p, id, isActive: true },
    });
    await loadProfiles();
  } catch (e) { console.error(e); }
}

async function testExchProfile(p: ExchProfile) {
  exchTestResults[p.id] = 'testing';
  try {
    const ok = await invoke<boolean>('test_exchange_connection', {
      params: {
        authMode: p.authMode,
        ewsUrl: p.ewsUrl || null,
        username: p.username,
        secretRef: p.secretRef,
        tenantId: p.tenantId || null,
        clientId: p.clientId || null,
        refreshTokenSecretRef: p.refreshTokenSecretRef || null,
        minEventMinutes: p.minEventMinutes ?? 0,
        excludeFreeBusy: p.excludeFreeBusy ?? true,
        excludeDeclined: p.excludeDeclined ?? true,
        ewsAuthType: p.ewsAuthType || 'basic',
      },
    });
    exchTestResults[p.id] = ok ? 'ok' : 'err';
  } catch {
    exchTestResults[p.id] = 'err';
  }
}

async function deleteExchProfile(id: number) {
  if (!confirm('Удалить профиль Exchange?')) return;
  try {
    await invoke('delete_exchange_profile', { id });
    await loadProfiles();
  } catch (e) { console.error(e); }
}

async function startOAuth() {
  oauthInProgress.value = true;
  oauthResult.value = null;
  try {
    const secretRef = `exchange_${exchForm.username}`;
    const res = await invoke<{ authUrl: string; windowLabel: string }>(
      'start_graph_oauth_embedded',
      {
        params: {
          authMode: 'graph',
          username: exchForm.username,
          secretRef,
          tenantId: exchForm.tenantId || null,
          clientId: exchForm.clientId || null,
          refreshTokenSecretRef: `${secretRef}_refresh`,
          ewsUrl: null,
          ewsAuthType: null,
          minEventMinutes: 0,
          excludeFreeBusy: true,
          excludeDeclined: true,
        },
      },
    );
    await openUrl(res.authUrl);
    const completeRes = await invoke<{ ok: boolean; message: string }>(
      'complete_graph_oauth_loopback',
    );
    oauthResult.value = completeRes;
    exchForm.password = '';
  } catch (e: any) {
    oauthResult.value = { ok: false, message: String(e) };
  } finally {
    oauthInProgress.value = false;
  }
}
</script>

<style scoped>
.profiles-page { padding: 1.5rem; max-width: 1100px; }
.page-title { font-size: 1.4rem; font-weight: 700; margin-bottom: 1.2rem; }
.card { background: var(--surface, #fff); border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,.08); padding: 1.2rem 1.4rem; }
.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
.card-title { font-size: 1.05rem; font-weight: 600; }
.btn { padding: .4rem .9rem; border-radius: 6px; border: 1px solid var(--border, #d0d5dd); cursor: pointer; font-size: .9rem; background: var(--surface, #fff); }
.btn-primary { background: #0052cc; color: #fff; border-color: #0052cc; }
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.btn-secondary { background: #f0f0f0; border-color: #bbb; }
.profile-table { width: 100%; border-collapse: collapse; font-size: .9rem; }
.profile-table th, .profile-table td { padding: .45rem .6rem; text-align: left; border-bottom: 1px solid var(--border, #eee); }
.profile-table tr.active td { background: #f0f8ff; }
.profile-table tr:hover td { background: #fafafa; }
.name-cell { font-weight: 600; }
.url-cell { color: #555; font-size: .82rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: .75rem; padding: .15rem .5rem; border-radius: 4px; background: #e0e8ff; color: #1a3a8f; }
.badge.cloud { background: #e0f0e8; color: #186a3b; }
.badge.server { background: #fde8cc; color: #7d4500; }
.badge.ews { background: #fde8cc; color: #7d4500; }
.badge.graph { background: #e0f0e8; color: #186a3b; }
.badge.token { background: #e0e8ff; color: #1a3a8f; }
.badge.pat { background: #f0e8ff; color: #5a1a8f; }
.badge.server_basic { background: #fff3cd; color: #664d03; }
.actions-cell { white-space: nowrap; }
.icon-btn { background: none; border: none; cursor: pointer; font-size: 1rem; padding: .2rem .3rem; border-radius: 4px; }
.icon-btn:hover { background: #f0f0f0; }
.icon-btn.danger:hover { background: #fee2e2; }
.status-ok { color: #15803d; font-size: .85rem; }
.status-err { color: #dc2626; font-size: .85rem; }
.status-testing { color: #888; font-size: .85rem; }
.status-none { color: #bbb; font-size: .85rem; }
.empty-hint { color: #999; font-size: .9rem; padding: .5rem 0; }

/* Modal */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--surface, #fff); border-radius: 12px; padding: 1.8rem; min-width: 460px; max-width: 540px; box-shadow: 0 8px 32px rgba(0,0,0,.18); display: flex; flex-direction: column; gap: .75rem; max-height: 92vh; overflow-y: auto; }
.modal h2 { margin: 0 0 .5rem; font-size: 1.1rem; }
.modal label { display: flex; flex-direction: column; gap: .2rem; font-size: .88rem; font-weight: 500; }
.modal input, .modal select { padding: .38rem .6rem; border: 1px solid var(--border, #d0d5dd); border-radius: 6px; font-size: .9rem; background: var(--input-bg, #fafafa); }
.checkbox-label { flex-direction: row !important; align-items: center; gap: .5rem; font-weight: 400; }
.modal-actions { display: flex; justify-content: flex-end; gap: .6rem; margin-top: .5rem; }
.form-error { color: #dc2626; font-size: .85rem; }
.filters-section { border-top: 1px solid #eee; padding-top: .75rem; display: flex; flex-direction: column; gap: .4rem; }
.filters-title { font-size: .82rem; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.oauth-hint { font-size: .82rem; color: #888; }
.auth-hint {
  font-size: .82rem;
  line-height: 1.45;
  padding: .5rem .75rem;
  border-radius: 6px;
  background: #fffbea;
  border: 1px solid #f5d569;
  color: #664d03;
}
.hint {
  font-size: .78rem;
  color: var(--color-text-muted, #6b7280);
  line-height: 1.35;
}
.hint a { color: #0052cc; }
</style>
