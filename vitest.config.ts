import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Тесты логики интерфейса: чистые функции и сторы Pinia против поддельного бэкенда
// (src/test/fakeBackend.ts). Окружение happy-dom даёт localStorage и window.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'tests/**/*.test.mjs'],
    restoreMocks: true,
  },
});
