<script setup lang="ts">
import { onMounted } from 'vue';
import { useSettingsStore } from './store/settings';

const settings = useSettingsStore();
onMounted(() => settings.loadTheme());
</script>

<template>
  <div :class="['app', settings.theme]">
    <router-view />
  </div>
</template>
