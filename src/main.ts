import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { getCurrentWindow } from '@tauri-apps/api/window'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// Показываем окно только после полной загрузки DOM.
// Старт скрытым (visible:false в tauri.conf.json) + show() здесь —
// стандартный паттерн Tauri для устранения мигания белого экрана на Windows.
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await getCurrentWindow().show()
  } catch {
    // в dev-режиме окно уже видимо, ошибка безопасна
  }
})
