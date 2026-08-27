<!--
  Кнопка «О программе» — фиксированный значок ℹ в левом нижнем углу окна.
  По клику открывает модальное окно по центру экрана: крупный логотип,
  название, версия, автор, контакт в Telegram, copyright, блок лицензии
  с полем ввода кода активации.
  Закрывается кнопкой «ОК», крестиком, кликом по фону или клавишей Esc.
  Слушает событие 'license:open-panel' для автооткрытия из useLicenseStore.
-->
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { getVersion } from '@tauri-apps/api/app';
import AppLogo from './AppLogo.vue';
import ActionIcon from './ActionIcon.vue';
import { tauriApi, type LicenseStatus } from '../lib/tauriApi';
import { useLicenseStore } from '../store/license';

const APP_NAME = 'JiraTime';
const AUTHOR = 'Александр Юрасов';
const TELEGRAM = '@Alex_Yu_V';
const COPYRIGHT_YEAR = new Date().getFullYear();

const version = ref<string>('0.1.0');
const open = ref(false);

const licenseStore = useLicenseStore();

// License state
const licenseStatus = ref<LicenseStatus | null>(null);
const licenseCode = ref('');
const licenseLoading = ref(false);
const licenseMessage = ref<{ text: string; ok: boolean } | null>(null);

const licenseLabel = computed(() => {
  if (!licenseStatus.value) return '';
  const s = licenseStatus.value;
  if (!s.expiresAt) return 'Не активирована';
  if (!s.active) return 'Истекла';
  const d = s.daysLeft;
  const label = d === 1 ? 'день' : d >= 2 && d <= 4 ? 'дня' : 'дней';
  return `Активна — осталось ${d} ${label}`;
});

const licenseBadgeClass = computed(() => {
  if (!licenseStatus.value || !licenseStatus.value.expiresAt) return 'badge--none';
  if (!licenseStatus.value.active) return 'badge--expired';
  if (licenseStatus.value.daysLeft <= 7) return 'badge--warn';
  return 'badge--ok';
});

onMounted(async () => {
  try { version.value = await getVersion(); } catch { /* fallback */ }
  window.addEventListener('keydown', onKeydown);
  // Открывает панель при событии из useLicenseStore
  window.addEventListener('license:open-panel', openWithLicenseFocus);
  await loadLicenseStatus();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('license:open-panel', openWithLicenseFocus);
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) close();
}

function toggle() { open.value = !open.value; }
function close() { open.value = false; }

function openWithLicenseFocus() {
  open.value = true;
  setTimeout(() => {
    const inp = document.getElementById('license-code-input');
    if (inp) (inp as HTMLInputElement).focus();
  }, 100);
}

async function loadLicenseStatus() {
  try {
    licenseStatus.value = await tauriApi.getLicenseStatus();
  } catch {
    licenseStatus.value = { active: false, expiresAt: null, daysLeft: 0 };
  }
}

async function activateCode() {
  const code = licenseCode.value.trim();
  if (!code) return;
  licenseLoading.value = true;
  licenseMessage.value = null;
  try {
    const result = await tauriApi.activateLicenseCode(code);
    licenseStatus.value = result.status;
    licenseMessage.value = { text: result.message, ok: result.ok };
    if (result.ok) {
      licenseCode.value = '';
      // Обновляем store — разблокируем кнопки
      licenseStore.isActive = result.status.active;
    }
  } catch (e) {
    licenseMessage.value = { text: String(e), ok: false };
  } finally {
    licenseLoading.value = false;
  }
}
</script>

<template>
  <button
    class="about-toggle"
    type="button"
    title="О программе"
    aria-label="О программе"
    @click="toggle"
  >
    <ActionIcon name="info" :size="18" />
  </button>

  <transition name="about-fade">
    <div v-if="open" class="about-overlay" @click.self="close">
      <div class="about-modal" role="dialog" aria-modal="true" aria-label="О программе">
        <button class="about-close" type="button" title="Закрыть" aria-label="Закрыть" @click="close">
          <ActionIcon name="close" :size="18" />
        </button>

        <div class="about-modal__logo">
          <AppLogo :size="72" />
        </div>

        <div class="about-modal__title">{{ APP_NAME }}</div>
        <div class="about-modal__version">Версия {{ version }}</div>

        <dl class="about-meta">
          <div class="about-row">
            <dt>Автор</dt>
            <dd>{{ AUTHOR }}</dd>
          </div>
          <div class="about-row">
            <dt>Связь</dt>
            <dd>
              <a :href="`https://t.me/${TELEGRAM.replace('@', '')}`" target="_blank" rel="noopener noreferrer">
                {{ TELEGRAM }}
              </a>
            </dd>
          </div>
          <div class="about-row">
            <dt>Copyright</dt>
            <dd>© {{ COPYRIGHT_YEAR }} Alexander Yurasov</dd>
          </div>
        </dl>

        <!-- ──── Блок лицензии ──────────────────────────────────────────── -->
        <div class="license-block">
          <div class="license-status-row">
            <span class="license-status-label">Лицензия</span>
            <span class="license-badge" :class="licenseBadgeClass">{{ licenseLabel || '…' }}</span>
          </div>

          <div v-if="licenseStatus?.expiresAt" class="license-expires">
            До {{ new Date(licenseStatus.expiresAt).toLocaleDateString('ru-RU') }}
          </div>

          <div class="license-input-row">
            <input
              id="license-code-input"
              v-model="licenseCode"
              class="license-input"
              type="text"
              placeholder="Код активации (XXXXX-XXXXX-…)"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter="activateCode"
            />
            <button
              class="license-activate-btn"
              type="button"
              :disabled="licenseLoading || !licenseCode.trim()"
              @click="activateCode"
            >
              {{ licenseLoading ? '…' : 'Активировать' }}
            </button>
          </div>

          <div
            v-if="licenseMessage"
            class="license-msg"
            :class="licenseMessage.ok ? 'license-msg--ok' : 'license-msg--err'"
          >
            {{ licenseMessage.text }}
          </div>
        </div>
        <!-- ──── /Блок лицензии ─────────────────────────────────────────── -->

        <p class="about-thanks">Спасибо, что пользуетесь {{ APP_NAME }}! 🙌</p>

        <button class="about-ok" type="button" @click="close">ОК</button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.about-toggle {
  position: fixed;
  left: 12px;
  bottom: 10px;
  z-index: 9999;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--border, #d8deea);
  background: var(--card, #ffffff);
  color: var(--muted, #5d6475);
  border-radius: 999rem;
  box-shadow: var(--shadow, 0 0.5rem 1.25rem rgba(42, 59, 88, 0.1));
  opacity: 0.85;
  cursor: pointer;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.about-toggle:hover {
  opacity: 1;
  background: var(--chip, #f0f2f7);
  color: var(--fg, #1a1a1a);
}

.about-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 20, 30, 0.45);
  backdrop-filter: blur(2px);
}

.about-modal {
  position: relative;
  /* +20% от прежних 28rem → 33.6rem */
  width: 33.6rem;
  max-width: calc(100vw - 2rem);
  background: var(--card, #ffffff);
  border: 1px solid var(--border, #d8deea);
  border-radius: 1.1rem;
  box-shadow: 0 1.5rem 3.5rem rgba(20, 28, 46, 0.25);
  padding: 2rem 2.5rem 1.75rem;
  color: var(--fg, #1a1a1a);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.about-close {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: none;
  background: transparent;
  color: var(--muted, #5d6475);
  border-radius: 0.5rem;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.about-close:hover {
  background: var(--chip, #f0f2f7);
  color: var(--fg, #1a1a1a);
}

.about-modal__logo { margin-bottom: 0.9rem; }

.about-modal__title {
  font-weight: 700;
  font-size: 1.4rem;
  letter-spacing: -0.01em;
}

.about-modal__version {
  font-size: 0.9rem;
  color: var(--muted, #5d6475);
  margin-top: 0.15rem;
  margin-bottom: 1.4rem;
}

.about-meta {
  margin: 0 0 1.3rem;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.about-row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.9rem;
  border-bottom: 1px solid var(--border, #eef0f5);
  padding-bottom: 0.45rem;
}
.about-row:last-child { border-bottom: none; padding-bottom: 0; }
.about-row dt { color: var(--muted, #5d6475); }
.about-row dd { margin: 0; text-align: right; font-weight: 500; }
.about-row a { color: var(--primary, #2a62ff); text-decoration: underline; }

/* ── License block ─────────────────────────────────────────────────────── */
.license-block {
  width: 100%;
  border: 1px solid var(--border, #d8deea);
  border-radius: 0.7rem;
  padding: 0.85rem 1rem;
  margin-bottom: 1.3rem;
  text-align: left;
  background: var(--chip, #f7f8fc);
}

.license-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
}

.license-status-label {
  font-size: 0.82rem;
  color: var(--muted, #5d6475);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.license-badge {
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.15rem 0.6rem;
  border-radius: 999rem;
  white-space: nowrap;
}
.badge--ok    { background: #d4f0dc; color: #1a6e38; }
.badge--warn  { background: #fff3cd; color: #8a6000; }
.badge--expired { background: #fde8e8; color: #b91c1c; }
.badge--none  { background: var(--chip, #eef0f5); color: var(--muted, #5d6475); }

.license-expires {
  font-size: 0.78rem;
  color: var(--muted, #5d6475);
  margin-bottom: 0.65rem;
}

.license-input-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.license-input {
  flex: 1;
  min-width: 0;
  padding: 0.4rem 0.65rem;
  font-size: 0.82rem;
  font-family: 'Courier New', monospace;
  border: 1px solid var(--border, #d0d5e0);
  border-radius: 0.45rem;
  background: var(--card, #fff);
  color: var(--fg, #1a1a1a);
  outline: none;
  transition: border-color 0.15s;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.license-input:focus { border-color: var(--primary, #2a62ff); }

.license-activate-btn {
  flex-shrink: 0;
  padding: 0.4rem 0.9rem;
  font-size: 0.82rem;
  font-weight: 600;
  border: none;
  border-radius: 0.45rem;
  background: var(--primary, #2a62ff);
  color: #fff;
  cursor: pointer;
  transition: opacity 0.15s;
  white-space: nowrap;
}
.license-activate-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.license-activate-btn:not(:disabled):hover { opacity: 0.88; }

.license-msg {
  margin-top: 0.55rem;
  font-size: 0.8rem;
  line-height: 1.4;
  border-radius: 0.35rem;
  padding: 0.35rem 0.6rem;
}
.license-msg--ok  { background: #d4f0dc; color: #1a6e38; }
.license-msg--err { background: #fde8e8; color: #b91c1c; }
/* ── /License block ─────────────────────────────────────────────────────── */

.about-thanks {
  margin: 0 0 1.5rem;
  font-size: 0.95rem;
  color: var(--fg, #1a1a1a);
}

.about-ok {
  width: 100%;
  padding: 0.65rem 1rem;
  border: none;
  border-radius: 0.6rem;
  background: var(--primary, #2a62ff);
  color: #fff;
  font-weight: 600;
  font-size: 0.95rem;
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.about-ok:hover { opacity: 0.9; }

.about-fade-enter-active,
.about-fade-leave-active { transition: opacity 0.15s ease; }
.about-fade-enter-from,
.about-fade-leave-to { opacity: 0; }
</style>
