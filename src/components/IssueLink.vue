<script setup lang="ts">
// Ключ задачи-ссылка: открывает задачу в Jira в системном браузере.
import { computed } from 'vue';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useJiraProfilesStore } from '../store/jiraProfiles';

const props = defineProps<{ issueKey: string }>();
const jp = useJiraProfilesStore();
const href = computed(() => {
  const base = jp.activeProfile?.baseUrl?.replace(/\/+$/, '');
  return base ? `${base}/browse/${encodeURIComponent(props.issueKey)}` : '';
});
function open() {
  if (href.value) openUrl(href.value).catch(() => {});
}
</script>

<template>
  <a v-if="href" class="issue-link" :href="href" :title="`Открыть ${issueKey} в Jira`" @click.prevent="open">{{ issueKey }}</a>
  <b v-else>{{ issueKey }}</b>
</template>

<style scoped>
.issue-link { font-weight: 700; color: var(--primary-strong); text-decoration: none; border-bottom: 1px dashed transparent; }
.issue-link:hover { border-bottom-color: currentColor; }
</style>
