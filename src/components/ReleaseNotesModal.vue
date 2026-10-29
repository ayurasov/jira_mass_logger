<script setup lang="ts">
// «Что нового»: история версий простым языком (docs/versions.md), как в todo-planner.
// Открывается щелчком по номеру версии внизу бокового меню; последняя версия раскрыта.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import versionsMarkdown from '../../docs/versions.md?raw';
import ActionIcon from './ActionIcon.vue';
import { parseVersions } from '../utils/releaseNotes';

const emit = defineEmits<{ close: [] }>();

const releases = parseVersions(versionsMarkdown);
const expanded = ref(new Set<string>(releases.length ? [releases[0].version] : []));

function toggle(version: string) {
  const next = new Set(expanded.value);
  if (next.has(version)) next.delete(version);
  else next.add(version);
  expanded.value = next;
}

const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') emit('close'); };
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="rn-overlay" @click.self="emit('close')">
      <section class="rn-modal" role="dialog" aria-modal="true" aria-labelledby="rn-title">
        <header class="rn-header">
          <div>
            <span class="rn-eyebrow">История версий</span>
            <h2 id="rn-title">Что нового в JiraTime</h2>
            <p>Изменения по версиям — простым языком.</p>
          </div>
          <button class="rn-close" type="button" aria-label="Закрыть" title="Закрыть" @click="emit('close')">
            <ActionIcon name="close" :size="18" />
          </button>
        </header>

        <div class="rn-list">
          <article
            v-for="(r, i) in releases" :key="r.version" class="rn-item"
            :class="{ 'is-open': expanded.has(r.version), 'is-latest': i === 0 }"
          >
            <button class="rn-toggle" type="button" :aria-expanded="expanded.has(r.version)" @click="toggle(r.version)">
              <span class="rn-mark">{{ i === 0 ? 'NEW' : 'v' }}</span>
              <span class="rn-toggle__text">
                <strong>Версия {{ r.version }}<small v-if="r.date"> · {{ r.date }}</small></strong>
                <span v-if="r.title">{{ r.title }}</span>
              </span>
              <ActionIcon class="rn-chevron" name="chevron-right" :size="16" />
            </button>
            <div v-if="expanded.has(r.version)" class="rn-content">
              <section v-for="s in r.sections" :key="s.title" class="rn-section">
                <h3>{{ s.title }}</h3>
                <p v-for="p in s.paragraphs" :key="p">{{ p }}</p>
                <ul v-if="s.items.length">
                  <li v-for="it in s.items" :key="it">{{ it }}</li>
                </ul>
              </section>
            </div>
          </article>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.rn-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 1.5rem; background: rgba(15, 20, 30, 0.45); backdrop-filter: blur(2px); }
.rn-modal { width: min(44rem, 100%); max-height: min(47rem, calc(100vh - 3rem)); display: flex; flex-direction: column; overflow: hidden; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: var(--radius, 0.75rem); box-shadow: 0 1.5rem 4rem rgba(15, 20, 40, 0.25); }
.rn-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.25rem; padding: 1.4rem 1.6rem 1.2rem; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, color-mix(in srgb, var(--primary) 9%, var(--card)), var(--card) 68%); }
.rn-eyebrow { color: var(--primary-strong); font-size: 0.6875rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
.rn-header h2 { margin: 0.35rem 0 0.3rem; font-size: 1.3rem; letter-spacing: -0.02em; }
.rn-header p { margin: 0; color: var(--muted); font-size: 0.8125rem; }
.rn-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border: none; border-radius: 0.5rem; background: transparent; color: var(--muted); cursor: pointer; }
.rn-close:hover { background: var(--chip); color: var(--fg); }

.rn-list { overflow-y: auto; padding: 0.875rem 1rem 1.1rem; display: flex; flex-direction: column; gap: 0.55rem; }
.rn-item { border: 1px solid var(--border); border-radius: 0.75rem; overflow: hidden; background: var(--card); transition: border-color 160ms ease, box-shadow 160ms ease; }
.rn-item.is-latest { border-color: color-mix(in srgb, var(--primary) 35%, var(--border)); }
.rn-item.is-open { box-shadow: var(--shadow); }
.rn-toggle { width: 100%; display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.875rem 0.95rem; border: none; background: transparent; color: var(--fg); text-align: left; cursor: pointer; }
.rn-toggle:hover { background: var(--chip); }
.rn-mark { flex: none; width: 2.15rem; height: 1.5rem; display: inline-flex; align-items: center; justify-content: center; border-radius: 0.45rem; background: var(--primary-soft); color: var(--primary-strong); font-size: 0.5625rem; font-weight: 800; letter-spacing: 0.04em; }
.rn-item.is-latest .rn-mark { background: var(--primary); color: #fff; }
.rn-toggle__text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.rn-toggle__text strong { font-size: 0.875rem; line-height: 1.35; }
.rn-toggle__text strong small { font-weight: 500; color: var(--muted); }
.rn-toggle__text > span { color: var(--muted); font-size: 0.75rem; line-height: 1.45; }
.rn-chevron { flex: none; margin-top: 0.15rem; color: var(--primary); transition: transform 160ms ease; }
.rn-item.is-open .rn-chevron { transform: rotate(90deg); }
.rn-content { padding: 0 1.1rem 1.05rem 3.85rem; border-top: 1px solid var(--border); }
.rn-section { padding-top: 0.875rem; }
.rn-section h3 { margin: 0 0 0.4rem; font-size: 0.8125rem; }
.rn-section p, .rn-section li { margin: 0 0 0.45rem; color: var(--muted); font-size: 0.8125rem; line-height: 1.55; }
.rn-section ul { margin: 0; padding-left: 1.1rem; }
@media (max-width: 560px) {
  .rn-overlay { padding: 0.6rem; }
  .rn-content { padding-left: 1.1rem; }
}
</style>
