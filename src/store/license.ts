/**
 * useLicenseStore — глобальный стор статуса лицензии.
 *
 * Предоставляет:
 *   - isActive: boolean — лицензия действительна
 *   - showModal: boolean — показывать ли модал "требуется лицензия"
 *   - requireLicense() — вызывается из guardedInvoke при ошибке LICENSE_REQUIRED
 *   - openActivation() — открыть AboutPanel на секции активации
 *   - guardWrite() — проверить лицензию перед write-операцией; возвращает false и показывает модал если не активна
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

  /**
   * Проверить наличие лицензии перед write-операцией.
   * Возвращает true если лицензия активна, false — если нет (и показывает модал).
   * Использование: if (!license.guardWrite()) return;
   */
  function guardWrite(): boolean {
    if (isActive.value) return true;
    showModal.value = true;
    return false;
  }

  /** Открыть панель About с фокусом на поле кода */
  function openActivation() {
    showModal.value = false;
    window.dispatchEvent(new CustomEvent('license:open-panel'));
  }

  function closeModal() {
    showModal.value = false;
  }

  return { isActive, showModal, load, requireLicense, guardWrite, openActivation, closeModal };
});
