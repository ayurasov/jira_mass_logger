/**
 * useLicenseStore — глобальный стор статуса лицензии.
 *
 * Предоставляет:
 *   - isActive: boolean — лицензия действительна
 *   - showModal: boolean — показывать ли модал "требуется лицензия"
 *   - requireLicense() — вызывается из guardedInvoke при ошибке LICENSE_REQUIRED
 *   - openActivation() — открыть AboutPanel на секции активации
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { tauriApi } from '../lib/tauriApi';

export const useLicenseStore = defineStore('license', () => {
  const isActive = ref<boolean>(true); // оптимистично true до первой загрузки
  const showModal = ref(false);

  async function load() {
    try {
      const s = await tauriApi.getLicenseStatus();
      isActive.value = s.active;
    } catch {
      isActive.value = false;
    }
  }

  /** Вызывается когда бэкенд вернул LICENSE_REQUIRED */
  function requireLicense() {
    showModal.value = true;
  }

  /** Открыть панель About с фокусом на поле кода */
  function openActivation() {
    showModal.value = false;
    window.dispatchEvent(new CustomEvent('license:open-panel'));
  }

  function closeModal() {
    showModal.value = false;
  }

  return { isActive, showModal, load, requireLicense, openActivation, closeModal };
});
