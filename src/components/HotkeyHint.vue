<!--
  Подсказка горячих клавиш — встраивается в любой вьюхе для отображения доступных хоткеев.
  Использование: <HotkeyHint />
-->
<template>
  <div class="hk-bar" aria-label="Горячие клавиши">
    <span v-for="hk in HOTKEYS" :key="hk.key" class="hk-item">
      <kbd>{{ hk.key }}</kbd>
      <span>{{ hk.label }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
const HOTKEYS = [
  { key: 'Ctrl+N', label: 'Новый worklog' },
  { key: 'Ctrl+L', label: 'Мой worklog' },
  { key: 'Ctrl+,', label: 'Настройки' },
  { key: 'Ctrl+M', label: 'Свернуть в трей' },
  { key: 'F1',     label: 'Логи' },
  { key: 'Enter',  label: 'Сохранить' },
  { key: 'Esc',    label: 'Отмена' },
];
</script>

<style scoped>
.hk-bar {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem 1rem;
  padding: .5rem .75rem;
  background: var(--color-surface-offset, #f3f0ec);
  border-radius: 8px;
  font-size: .78rem;
  color: var(--color-text-muted, #7a7974);
}
.hk-item {
  display: flex;
  align-items: center;
  gap: .3rem;
}
kbd {
  display: inline-flex;
  align-items: center;
  padding: .1rem .4rem;
  background: var(--color-surface-2, #fbfbf9);
  border: 1px solid var(--color-border, #d4d1ca);
  border-radius: 4px;
  font-size: .78rem;
  font-family: 'Consolas', monospace;
  color: var(--color-text, #28251d);
  box-shadow: 0 1px 0 var(--color-border, #d4d1ca);
}
</style>
