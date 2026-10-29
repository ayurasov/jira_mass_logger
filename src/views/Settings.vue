<template>
  <div class="settings-screen">
    <h1 class="settings-title">Настройки</h1>

    <!-- ──────────── Общие настройки ──────────── -->
    <section class="settings-card">
      <div class="card-header">
        <h3>Общие</h3>
      </div>

      <label class="checkbox-row-inline">
        <input
          type="checkbox"
          :checked="autostartEnabled"
          :disabled="autostartBusy"
          @change="onToggleAutostart(($event.target as HTMLInputElement).checked)"
        />
        Запускать при входе в {{ osName() }}
      </label>
      <p v-if="isMac" class="hint">JiraTime появится в «Системные настройки → Основные → Объекты входа».</p>
      <p v-else-if="isWindows" class="hint">
        Использует <code>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</code> — не требует прав администратора.
      </p>
      <p v-if="autostartMessage" :class="['status-text', autostartSuccess ? 'status-text--ok' : 'status-text--error']">
        {{ autostartMessage }}
      </p>
    </section>

    <!-- ──────────── Обновления ──────────── -->
    <section id="updates" class="settings-card">
      <div class="card-header">
        <h3>Обновления</h3>
        <span v-if="appVersion" class="version-tag">версия {{ appVersion }}</span>
      </div>
      <p v-if="updates.configured === false" class="hint">
        В этой сборке автообновление не настроено — новые версии устанавливаются вручную из файла установщика.
      </p>
      <template v-else>
        <label class="checkbox-row-inline">
          <input type="checkbox" :checked="updates.prefs.autoCheck" @change="updates.setAutoCheck(($event.target as HTMLInputElement).checked)" />
          Проверять обновления при запуске
        </label>
        <div class="inline-actions">
          <button class="btn btn--secondary btn--sm" :disabled="updates.checking || updates.busy" @click="updates.check()">
            {{ updates.checking ? 'Проверка…' : 'Проверить сейчас' }}
          </button>
          <span v-if="updates.prefs.lastCheckAt" class="hint update-last">
            Последняя проверка: {{ fmtDateTime(updates.prefs.lastCheckAt) }}<template v-if="updates.status"> — {{ updates.status }}</template>
          </span>
        </div>
        <div v-if="updates.available" class="update-card">
          <div class="update-card__head">
            <strong>Доступна версия {{ updates.available.version }}</strong>
            <span v-if="updates.available.date" class="hint">от {{ fmtIsoDate(updates.available.date) }}</span>
          </div>
          <pre v-if="updates.available.notes" class="update-notes">{{ updates.available.notes }}</pre>
          <div v-if="updates.busy" class="update-progress">
            <div class="update-progress__bar"><span :style="{ width: (updates.progressPercent ?? 100) + '%' }" /></div>
            <span class="hint">{{ updates.progressText }}</span>
          </div>
          <div v-else class="inline-actions">
            <button class="btn btn--primary btn--sm" @click="updates.install()">Скачать и установить</button>
            <span class="hint">{{ isWindows ? 'Установщик закроет JiraTime и сразу откроет новую версию.' : 'После установки JiraTime перезапустится.' }}</span>
          </div>
        </div>
        <p v-if="updates.error" class="status-text status-text--error">{{ updates.error }}</p>
      </template>
    </section>

    <!-- ──────────── Рабочий график ──────────── -->
    <section class="settings-card">
      <div class="card-header">
        <h3>Рабочий график</h3>
      </div>
      <p class="hint">Норма и рабочие дни используются в «Моём worklog», на дашборде, в мастере и при проверке заполнения на экране «Команда».</p>
      <div class="sched-grid">
        <label class="field">
          <span>Норма в день, ч</span>
          <input v-model.number="schedule.workdayHours" type="number" min="1" max="24" step="0.5" @change="saveSchedule" />
        </label>
        <label class="field">
          <span>Часовой пояс</span>
          <select v-model="schedule.timezone" @change="saveSchedule">
            <option v-for="tz in timezones" :key="tz" :value="tz">{{ tz }}</option>
          </select>
        </label>
      </div>
      <div class="weekday-chips" role="group" aria-label="Рабочие дни">
        <button
          v-for="d in WEEK_ORDER" :key="d" type="button" class="weekday-chip"
          :class="{ 'weekday-chip--on': schedule.workdays.includes(d) }" @click="toggleWorkday(d)"
        >{{ WEEKDAY_NAMES[d] }}</button>
      </div>
    </section>

    <!-- ──────────── Напоминание ──────────── -->
    <section class="settings-card">
      <div class="card-header">
        <h3>Напоминание о незаполненном времени</h3>
      </div>
      <label class="checkbox-row-inline">
        <input v-model="reminder.reminderEnabled" type="checkbox" @change="saveReminder" />
        Показывать системное уведомление, если за день списано меньше нормы
      </label>
      <div class="sched-grid" :class="{ 'is-disabled': !reminder.reminderEnabled }">
        <label class="field">
          <span>Время</span>
          <input v-model="reminder.reminderTime" type="time" :disabled="!reminder.reminderEnabled" @change="saveReminder" />
        </label>
        <label class="checkbox-row-inline">
          <input v-model="reminder.reminderWorkdaysOnly" type="checkbox" :disabled="!reminder.reminderEnabled" @change="saveReminder" />
          Только в будни
        </label>
      </div>
      <p class="hint">Проверка идёт по записям, загруженным в приложение. Уведомление приходит один раз в день, после указанного времени.</p>
      <p v-if="reminderMessage" :class="['status-text', reminderOk ? 'status-text--ok' : 'status-text--error']">{{ reminderMessage }}</p>
    </section>

    <!-- ──────────── Производственный календарь РФ ──────────── -->
    <section class="settings-card">
      <div class="card-header">
        <h3>Производственный календарь</h3>
      </div>
      <p class="hint">
        Праздничные дни РФ на 2026&ndash;2027 годы (с учётом переносов выходных)
        учитываются как нерабочие: они не отображаются как «незаполненное» время
        в дашборде и в списке недозаполненных дней worklog.
      </p>

      <div class="holidays-year-tabs">
        <button
          v-for="y in holidayYears"
          :key="y"
          class="btn btn--ghost btn--sm"
          :class="{ 'btn--active': holidayYearFilter === y }"
          @click="holidayYearFilter = y"
        >{{ y }}</button>
      </div>

      <table class="holidays-table">
        <thead>
          <tr>
            <th>Дата</th>
            <th>Праздник</th>
            <th>Учитывать как выходной</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in filteredHolidays" :key="h.date">
            <td class="holidays-table__date">{{ formatHolidayDate(h.date) }}</td>
            <td>{{ h.title }}</td>
            <td>
              <label class="checkbox-row-inline">
                <input
                  type="checkbox"
                  :checked="!isBaseHolidayDisabled(h.date)"
                  @change="onToggleHoliday(h.date, ($event.target as HTMLInputElement).checked)"
                />
              </label>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="card-header" style="margin-top: 1rem">
        <h3 style="font-size: 0.95rem">Дополнительные выходные</h3>
      </div>
      <p v-if="customHolidays.length === 0" class="muted" style="margin-top: 0">
        Нет добавленных вручную выходных дней.
      </p>
      <table v-else class="holidays-table">
        <tbody>
          <tr v-for="h in customHolidays" :key="h.date">
            <td class="holidays-table__date">{{ formatHolidayDate(h.date) }}</td>
            <td>{{ h.title }}</td>
            <td>
              <button class="btn btn--ghost btn--sm" @click="settingsStore.removeCustomHoliday(h.date)">Удалить</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="form-grid" style="margin-top: 0.75rem">
        <label>
          Дата
          <DatePicker v-model="newHolidayDate" />
        </label>
        <label class="span-2">
          Название
          <input v-model="newHolidayTitle" placeholder="Например, корпоративный выходной" />
        </label>
      </div>
      <div class="actions-row">
        <button class="btn btn--secondary btn--sm" :disabled="!newHolidayDate" @click="addCustomHoliday">
          + Добавить выходной
        </button>
        <button class="btn btn--ghost btn--sm" @click="settingsStore.resetHolidayOverrides()">
          Сбросить к производственному календарю по умолчанию
        </button>
      </div>
    </section>

    <!-- ──────────── Битрикс24 (необязательно) ──────────── -->
    <section id="bitrix" class="settings-card">
      <div class="card-header">
        <h3>Битрикс24 <span class="optional-tag">необязательно</span></h3>
      </div>
      <p class="hint">
        Раздел «Битрикс24» показывает ваши задачи и задачи, за которыми вы наблюдаете, позволяет искать их,
        писать комментарии и добавлять результаты. Подключение — через входящий вебхук: в Битрикс24 откройте
        «Разработчикам» → «Другое» → «Входящий вебхук», отметьте права <b>Задачи (task)</b> и <b>Пользователи (user)</b>
        и скопируйте адрес вида <code>https://портал.bitrix24.ru/rest/1/код/</code>.
      </p>
      <template v-if="bitrix.connected">
        <div class="bitrix-status">
          <span class="bitrix-status__dot"></span>
          Подключено: <b>{{ bitrix.settings.user?.name || 'пользователь ' + bitrix.settings.user?.id }}</b>
          · {{ bitrix.settings.user?.portal.replace(/^https?:\/\//, '') }}
        </div>
        <label class="checkbox-row-inline">
          <input type="checkbox" :checked="bitrix.settings.enabled" @change="bitrix.setEnabled(($event.target as HTMLInputElement).checked)" />
          Показывать раздел «Битрикс24» в меню
        </label>
        <div class="inline-actions">
          <button class="btn btn--secondary btn--sm" :disabled="bitrixBusy" @click="recheckBitrix">Проверить подключение</button>
          <button class="btn btn--ghost btn--sm" :disabled="bitrixBusy" @click="disconnectBitrix">Отключить и удалить вебхук</button>
        </div>
      </template>
      <template v-else>
        <label class="field">
          Адрес входящего вебхука
          <input v-model="bitrixWebhook" type="password" autocomplete="off" placeholder="https://портал.bitrix24.ru/rest/1/xxxxxxxxxxxx/" @keydown.enter="connectBitrix" />
        </label>
        <div class="inline-actions">
          <button class="btn btn--primary btn--sm" :disabled="!bitrixWebhook.trim() || bitrix.connecting" @click="connectBitrix">
            {{ bitrix.connecting ? 'Проверка…' : 'Подключить' }}
          </button>
        </div>
        <p class="hint">Адрес вебхука хранится только в {{ secretStoreName() }}.</p>
      </template>
      <p v-if="bitrixMessage" :class="['status-text', bitrixOk ? 'status-text--ok' : 'status-text--error']">{{ bitrixMessage }}</p>
    </section>

    <!-- ──────────── Перенос настроек ──────────── -->
    <section id="transfer" class="settings-card">
      <div class="card-header">
        <h3>Перенос настроек</h3>
      </div>
      <p class="hint">
        Сохраните настройки в файл и откройте его в JiraTime на другом компьютере: рабочий график и праздники,
        шаблоны, правила встреч, избранные задачи, команды, сохранённые JQL и подключения.
        Пароли, токены и вебхуки в файл не попадают — их нужно будет ввести заново.
      </p>
      <div class="inline-actions">
        <button class="btn btn--secondary btn--sm" :disabled="transfer.busy" @click="exportSettings">Сохранить в файл…</button>
        <button class="btn btn--secondary btn--sm" :disabled="transfer.busy" @click="pickImport">Загрузить из файла…</button>
      </div>
      <p v-if="transferMessage" :class="['status-text', transferOk ? 'status-text--ok' : 'status-text--error']">{{ transferMessage }}</p>
    </section>
    <SettingsImportDialog v-if="importFile" :file="importFile" @close="importFile = null" @done="reloadAfterImport" />

    <!-- ──────────── Danger zone: сброс настроек ──────────── -->
    <section class="settings-card danger-zone">
      <div class="card-header">
        <h3>Сброс настроек</h3>
      </div>
      <p class="muted">
        Удалит все профили Jira и Exchange, сохранённые токены и пароли из системного
        хранилища и общие настройки, а затем запустит онбординг заново. Используйте,
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
      <template v-if="isWindows">
        <strong>Примечание для корпоративных Windows / Intune окружений:</strong>
        если встроенный WebView2 или OAuth redirect блокируется политиками, приложение покажет явную ошибку.
        В таком случае проверьте, что политика не запрещает embedded browser sign-in, или используйте EWS с NTLM.
      </template>
      <template v-else>
        <strong>Примечание для корпоративных окружений:</strong>
        если вход через Microsoft (OAuth) блокируется политиками, приложение покажет явную ошибку —
        в таком случае используйте подключение к Exchange через EWS.
      </template>
      Пароли и токены хранятся в {{ secretStoreName() }}, а не в базе приложения.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { isEnabled, enable, disable } from '@tauri-apps/plugin-autostart';
import DatePicker from '../components/DatePicker.vue';
import { useSettingsStore } from '../store/settings';
import { RU_HOLIDAYS_DEFAULT } from '../lib/ruHolidays';
import { tauriApi, type SchedulerSettings } from '../lib/tauriApi';
import { useBitrixStore } from '../store/bitrix';
import { useUpdatesStore } from '../store/updates';
import { useSettingsTransferStore } from '../store/settingsTransfer';
import SettingsImportDialog from '../components/SettingsImportDialog.vue';
import type { SettingsFile } from '../utils/settingsTransfer';
import { getVersion } from '@tauri-apps/api/app';
import { useRoute } from 'vue-router';
import { isMac, isWindows, osName, secretStoreName } from '../utils/platform';

const settingsStore = useSettingsStore();

const resetting = ref(false);
const resetMessage = ref('');
const resetSuccess = ref(false);

// ──────────── Автозапуск при старте Windows ────────────
const autostartEnabled = ref(false);
const autostartBusy = ref(false);
const autostartMessage = ref('');
const autostartSuccess = ref(false);

async function loadAutostartState() {
  try {
    autostartEnabled.value = await isEnabled();
  } catch (err) {
    autostartMessage.value = `Не удалось получить статус автозапуска: ${err}`;
    autostartSuccess.value = false;
  }
}

async function onToggleAutostart(checked: boolean) {
  autostartBusy.value = true;
  autostartMessage.value = '';
  try {
    if (checked) {
      await enable();
    } else {
      await disable();
    }
    autostartEnabled.value = checked;
    autostartSuccess.value = true;
    autostartMessage.value = checked
      ? `Автозапуск включён: JiraTime будет запускаться при входе в ${osName()}.`
      : 'Автозапуск отключён.';
  } catch (err) {
    autostartSuccess.value = false;
    autostartMessage.value = `Ошибка изменения автозапуска: ${err}`;
    await loadAutostartState();
  } finally {
    autostartBusy.value = false;
  }
}

// ──────────── Производственный календарь РФ ────────────
const holidayYears = ['2026', '2027'];
const holidayYearFilter = ref<string>('2026');

const filteredHolidays = computed(() =>
  RU_HOLIDAYS_DEFAULT.filter((h) => h.date.startsWith(holidayYearFilter.value)),
);

const customHolidays = computed(() => settingsStore.holidays.filter((h) => !RU_HOLIDAYS_DEFAULT.some((b) => b.date === h.date)));

function isBaseHolidayDisabled(dateIso: string): boolean {
  return !settingsStore.isHoliday(dateIso);
}

function onToggleHoliday(dateIso: string, enabled: boolean) {
  settingsStore.toggleBaseHoliday(dateIso, enabled);
}

function formatHolidayDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

const newHolidayDate = ref('');
const newHolidayTitle = ref('');

function addCustomHoliday() {
  if (!newHolidayDate.value) return;
  settingsStore.addCustomHoliday(newHolidayDate.value, newHolidayTitle.value.trim());
  newHolidayDate.value = '';
  newHolidayTitle.value = '';
}

/**
 * Полный сброс локальных данных
 */
// ──────────── Битрикс24 ────────────
const bitrix = useBitrixStore();
const bitrixWebhook = ref('');
const bitrixMessage = ref('');
const bitrixOk = ref(false);
const bitrixBusy = ref(false);

async function connectBitrix() {
  if (!bitrixWebhook.value.trim()) return;
  bitrixMessage.value = '';
  try {
    const user = await bitrix.connect(bitrixWebhook.value);
    bitrixWebhook.value = '';
    bitrixOk.value = true;
    bitrixMessage.value = `Готово: подключено как ${user.name || 'пользователь ' + user.id}. Раздел «Битрикс24» появился в меню.`;
  } catch (e) {
    bitrixOk.value = false;
    bitrixMessage.value = e instanceof Error ? e.message : String(e);
  }
}

async function recheckBitrix() {
  bitrixBusy.value = true;
  try {
    const user = await bitrix.recheck();
    bitrixOk.value = true;
    bitrixMessage.value = `Подключение работает: ${user.name || 'пользователь ' + user.id}.`;
  } catch (e) {
    bitrixOk.value = false;
    bitrixMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    bitrixBusy.value = false;
  }
}

async function disconnectBitrix() {
  bitrixBusy.value = true;
  try {
    await bitrix.disconnect();
    bitrixOk.value = true;
    bitrixMessage.value = 'Битрикс24 отключён, вебхук удалён.';
  } finally {
    bitrixBusy.value = false;
  }
}

async function resetAppData() {
  if (!confirm('Удалить все профили и настройки и пройти онбординг заново? Отменить нельзя.')) return;
  resetting.value = true;
  resetMessage.value = '';
  try {
    await invoke('reset_app_data');
    await invoke('delete_secret', { secretRef: 'bitrix-webhook' }).catch(() => {});
    // Чистим ВСЕ ключи приложения: иначе, например, watermark инкрементальной
    // синхронизации пережил бы сброс, и после повторной настройки того же профиля
    // «Мой worklog» не догрузил бы старые записи из Jira.
    Object.keys(localStorage)
      .filter((k) => k.startsWith('jiratime-'))
      .forEach((k) => localStorage.removeItem(k));
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

// ──────────── Рабочий график ────────────
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const schedule = reactive({
  workdayHours: settingsStore.workdayHours,
  workdays: [...settingsStore.workdays],
  timezone: settingsStore.timezone,
});
const timezones = computed(() => {
  const list: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return list.includes(schedule.timezone) ? list : [schedule.timezone, ...list];
});
function toggleWorkday(d: number) {
  const set = new Set(schedule.workdays);
  if (set.has(d)) { if (set.size > 1) set.delete(d); } else set.add(d);
  schedule.workdays = [...set].sort();
  saveSchedule();
}
function saveSchedule() {
  const hours = Number(schedule.workdayHours);
  if (!hours || hours <= 0 || hours > 24) return;
  settingsStore.setWorkSchedule({ workdayHours: hours, workdays: schedule.workdays, timezone: schedule.timezone });
  // Норма для напоминания — та же, что и в графике.
  if (reminder.dailyHoursNorm !== hours) { reminder.dailyHoursNorm = hours; saveReminder(); }
}

// ──────────── Напоминание ────────────
const reminder = reactive<SchedulerSettings>({
  autoSyncEnabled: true, syncIntervalMinutes: 15, reminderEnabled: false,
  reminderTime: '17:30', reminderWorkdaysOnly: true, dailyHoursNorm: settingsStore.workdayHours,
});
const reminderMessage = ref('');
const reminderOk = ref(true);
let reminderLoaded = false;
async function loadReminder() {
  try {
    Object.assign(reminder, await tauriApi.getSchedulerSettings());
    reminderLoaded = true;
  } catch { /* старый бэкенд — оставляем значения по умолчанию */ }
}
async function saveReminder() {
  if (!reminderLoaded) return;
  try {
    await tauriApi.saveSchedulerSettings({ ...reminder, dailyHoursNorm: Number(schedule.workdayHours) || reminder.dailyHoursNorm });
    reminderOk.value = true;
    reminderMessage.value = reminder.reminderEnabled ? `Напоминание включено на ${reminder.reminderTime}.` : 'Напоминание выключено.';
  } catch (e) {
    reminderOk.value = false;
    reminderMessage.value = `Не удалось сохранить: ${e}`;
  }
}

// ──────────── Перенос настроек ────────────
const transfer = useSettingsTransferStore();
const transferMessage = ref('');
const transferOk = ref(true);
const importFile = ref<SettingsFile | null>(null);

async function exportSettings() {
  transferMessage.value = '';
  try {
    const path = await transfer.exportToFile();
    if (path) { transferOk.value = true; transferMessage.value = `Настройки сохранены: ${path}`; }
  } catch (e) {
    transferOk.value = false;
    transferMessage.value = `Не удалось сохранить: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function pickImport() {
  transferMessage.value = '';
  try {
    importFile.value = await transfer.pickFile();
  } catch (e) {
    transferOk.value = false;
    transferMessage.value = e instanceof Error ? e.message : String(e);
  }
}

// Сторы читают настройки при запуске — после импорта перезагружаем интерфейс.
function reloadAfterImport() {
  window.location.reload();
}

// ──────────── Обновления ────────────
const updates = useUpdatesStore();
const appVersion = ref('');

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtIsoDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// Переход по ссылке вида #/settings#updates: прокручиваем к нужному разделу
// (прокрутка у приложения — внутри .app-main, а не у окна).
const route = useRoute();
function scrollToHash() {
  const id = route.hash?.slice(1);
  if (id) nextTick(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
}
watch(() => route.hash, scrollToHash);

onMounted(() => {
  loadAutostartState();
  loadReminder();
  updates.init();
  getVersion().then((v) => { appVersion.value = v; }).catch(() => {});
  scrollToHash();
});
</script>

<style scoped>
.sched-grid { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; margin: 0.75rem 0; }
.sched-grid.is-disabled { opacity: 0.55; }
.field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.8125rem; color: var(--muted); font-weight: 600; }
.field input, .field select { padding: 0.45rem 0.6rem; font-size: 0.9375rem; min-width: 8rem; }
.field select { min-width: 16rem; }
.weekday-chips { display: flex; gap: 0.375rem; flex-wrap: wrap; }
.weekday-chip { border: 1px solid var(--border); background: var(--card); color: var(--muted); border-radius: 0.5rem; padding: 0.4rem 0.75rem; font-weight: 600; min-width: 3rem; }
.weekday-chip:hover { border-color: var(--primary); }
.weekday-chip--on { background: var(--primary); border-color: var(--primary); color: #fff; }
.settings-screen {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 72rem;
}
.settings-title { margin: 0; font-size: 1.5rem; letter-spacing: -0.01em; }

.settings-card {
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, var(--border));
  border-radius: 0.75rem;
  padding: 1rem 1.25rem;
}

.danger-zone {
  border-color: var(--color-danger-bg);
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

.checkbox-row-inline {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 500;
}

.holidays-year-tabs {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.btn--active { background: var(--color-primary, #3366ff); color: #fff; text-decoration: none; }

.holidays-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
}
.holidays-table th,
.holidays-table td {
  padding: 0.4rem 0.6rem;
  text-align: left;
  border-bottom: 1px solid var(--color-border-light, var(--chip));
}
.holidays-table th { font-weight: 600; color: var(--color-text-muted, var(--muted)); }
.holidays-table__date { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--color-text-muted, var(--muted)); }

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
  border: 1px solid var(--color-border, var(--border));
  border-radius: 0.5rem;
}

.hint {
  font-size: 0.78rem;
  color: var(--color-text-muted, var(--muted));
  line-height: 1.35;
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
.btn--secondary { background: var(--color-surface-alt, #eef2f7); color: var(--color-text, var(--fg)); }
.btn--ghost { background: transparent; color: var(--color-primary, #3366ff); text-decoration: underline; padding-left: 0; padding-right: 0; }
.btn--danger { background: var(--danger); color: #fff; align-self: flex-start; }

.btn:disabled { opacity: 0.6; cursor: not-allowed; }

.muted { color: var(--color-text-muted, var(--muted)); font-size: 0.9rem; }

.status-text { margin-top: 1rem; font-size: 0.95rem; }
.status-text--ok { color: var(--success); }
.status-text--error { color: var(--danger); }

.policy-hint {
  padding: 0.75rem 1.25rem;
  font-size: 0.875rem;
  line-height: 1.45;
  color: var(--color-text-muted, var(--muted));
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, var(--border));
  border-radius: 0.75rem;
}
.optional-tag { font-size: 0.6875rem; font-weight: 600; color: var(--muted); background: var(--chip); border-radius: 999px; padding: 0.1rem 0.5rem; margin-left: 0.35rem; vertical-align: middle; }
.bitrix-status { display: flex; align-items: center; gap: 0.4rem; font-size: 0.875rem; }
.bitrix-status__dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; background: var(--success); }
#bitrix .field input { max-width: 36rem; }
#bitrix .inline-actions { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
#bitrix .checkbox-row-inline { font-size: 0.875rem; margin: 0.25rem 0; }
#bitrix .bitrix-status { margin-bottom: 0.25rem; }
/* Обновления */
.version-tag { font-size: 0.8125rem; color: var(--muted); font-variant-numeric: tabular-nums; }
#updates .inline-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem 0.75rem; margin-top: 0.6rem; }
#updates .inline-actions .hint { margin: 0; }
.update-card { margin-top: 0.85rem; border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--border)); background: color-mix(in srgb, var(--primary) 5%, var(--card)); border-radius: 0.625rem; padding: 0.75rem 0.9rem; display: flex; flex-direction: column; gap: 0.5rem; }
.update-card__head { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
.update-card__head .hint { margin: 0; }
.update-notes { margin: 0; max-height: 10rem; overflow: auto; white-space: pre-wrap; font: inherit; font-size: 0.8125rem; line-height: 1.45; color: var(--fg); }
.update-progress { display: flex; flex-direction: column; gap: 0.35rem; }
.update-progress .hint { margin: 0; }
.update-progress__bar { height: 6px; border-radius: 999px; background: var(--chip); overflow: hidden; max-width: 28rem; }
.update-progress__bar span { display: block; height: 100%; background: var(--primary); transition: width 200ms ease; }
</style>
