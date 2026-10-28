<template>
  <div class="dash-card whc">
    <div class="dash-card-header">
      <span class="dash-card-title">Часы по дням</span>
      <div class="dash-tab-group">
        <button :class="['dash-tab', week === 'current' && 'active']" @click="week = 'current'">Текущая</button>
        <button :class="['dash-tab', week === 'prev' && 'active']" @click="week = 'prev'">Прошлая</button>
      </div>
    </div>

    <div class="whc__summary">
      <span class="whc__total">{{ fmtH(total) }} <small>из {{ fmtH(plan) }} ч</small></span>
      <span v-if="deficit > 0.01" class="whc__chip whc__chip--warn">не хватает {{ fmtH(deficit) }} ч</span>
      <span v-else-if="plan > 0" class="whc__chip whc__chip--ok"><ActionIcon name="check-circle" :size="12" /> норма выполнена</span>
    </div>

    <!-- Столбцы: факт (основной цвет) + недостающее до нормы (штриховка) + линия нормы -->
    <div class="whc__plot" @mouseleave="hover = null">
      <div class="whc__grid">
        <span v-for="t in ticks" :key="t" class="whc__gridline" :style="{ bottom: pct(t) + '%' }"><i>{{ t }}</i></span>
        <span v-if="norm > 0" class="whc__norm" :style="{ bottom: pct(norm) + '%' }" :title="`Норма ${fmtH(norm)} ч`"><i>норма</i></span>
      </div>
      <div class="whc__cols">
        <div
          v-for="(b, i) in bars" :key="b.date" class="whc__col"
          :class="{ 'is-off': b.plan === 0, 'is-today': b.date === today, 'is-future': b.date > today }"
          @mouseenter="hover = i"
        >
          <div class="whc__stack">
            <span v-if="b.fact > 0" class="whc__value" :style="{ bottom: `calc(${pct(b.fact)}% + 4px)` }">{{ fmtH(b.fact) }}</span>
            <span
              v-if="b.plan > b.fact && b.date <= today" class="whc__deficit"
              :style="{ bottom: pct(b.fact) + '%', height: pct(b.plan - b.fact) + '%' }"
            ></span>
            <span class="whc__bar" :class="{ 'is-full': b.plan > 0 && b.fact >= b.plan - 0.01 }" :style="{ height: pct(b.fact) + '%' }"></span>
          </div>
          <span class="whc__label">{{ b.label }}<small>{{ b.date.slice(8, 10) }}</small></span>
        </div>
      </div>
      <div v-if="hover !== null && bars[hover]" class="whc__tip" :style="{ left: ((hover + 0.5) / bars.length) * 100 + '%' }">
        <b>{{ tipTitle(bars[hover].date) }}</b>
        <span>Факт: {{ fmtH(bars[hover].fact) }} ч</span>
        <span v-if="bars[hover].plan">Норма: {{ fmtH(bars[hover].plan) }} ч</span>
        <span v-else>Нерабочий день</span>
      </div>
    </div>

    <div class="whc__legend">
      <span><i class="lg-fact"></i>Факт</span>
      <span><i class="lg-full"></i>По норме</span>
      <span><i class="lg-deficit"></i>Не хватает</span>
      <span><i class="lg-norm"></i>Норма</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import ActionIcon from '../ActionIcon.vue';
import { useAnalyticsStore } from '../../store/analytics';
import { localIsoDate, parseIsoDate } from '../../utils/time';

const store = useAnalyticsStore();
const week = ref<'current' | 'prev'>('current');
const hover = ref<number | null>(null);
const today = localIsoDate();

const bars = computed(() => (week.value === 'current' ? store.currentWeekBars : store.prevWeekBars));
const norm = computed(() => Math.max(0, ...bars.value.map((b) => b.plan)));
const total = computed(() => bars.value.reduce((s, b) => s + b.fact, 0));
const plan = computed(() => bars.value.reduce((s, b) => s + b.plan, 0));
// Недобор — только по прошедшим дням: будущие ещё не «пропущены».
const deficit = computed(() => bars.value.filter((b) => b.date <= today).reduce((s, b) => s + Math.max(0, b.plan - b.fact), 0));
// Шкала: с запасом над нормой и над максимумом, кратно 2 ч.
const scaleMax = computed(() => Math.max(2, Math.ceil(Math.max(norm.value * 1.25, ...bars.value.map((b) => b.fact * 1.1)) / 2) * 2));
const ticks = computed(() => {
  const step = scaleMax.value > 12 ? 4 : 2;
  const out: number[] = [];
  for (let t = step; t <= scaleMax.value; t += step) out.push(t);
  return out;
});
const pct = (h: number) => Math.min(100, (Math.max(0, h) / scaleMax.value) * 100);
const fmtH = (h: number) => (Math.round(h * 10) / 10).toLocaleString('ru-RU');
const tipTitle = (iso: string) => parseIsoDate(iso).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
</script>

<style scoped>
.whc__summary { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
.whc__total { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.whc__total small { font-size: 0.875rem; font-weight: 500; color: var(--muted); }
.whc__chip { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.75rem; font-weight: 600; padding: 0.15rem 0.55rem; border-radius: 999px; }
.whc__chip--warn { background: var(--amber-bg); color: var(--amber-fg); }
.whc__chip--ok { background: var(--color-success-bg); color: var(--success); }

.whc__plot { position: relative; height: 13rem; margin: 0.25rem 0 0 1.5rem; }
.whc__grid { position: absolute; inset: 0 0 1.75rem 0; pointer-events: none; }
.whc__gridline { position: absolute; left: 0; right: 0; border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.whc__gridline i { position: absolute; left: -1.5rem; top: -0.5rem; width: 1.25rem; text-align: right; font-style: normal; font-size: 0.6875rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.whc__norm { position: absolute; left: 0; right: 0; border-top: 2px dashed var(--fg); opacity: 0.55; z-index: 2; }
.whc__norm i { position: absolute; right: 0; top: -1.1rem; font-style: normal; font-size: 0.6875rem; color: var(--muted); }
.whc__cols { position: absolute; inset: 0; display: flex; gap: 2px; }
.whc__col { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; border-radius: 0.375rem; }
.whc__col:hover { background: color-mix(in srgb, var(--chip) 60%, transparent); }
.whc__stack { position: relative; flex: 1; width: 100%; display: flex; justify-content: center; }
.whc__bar, .whc__deficit { position: absolute; bottom: 0; width: 46%; max-width: 2.75rem; }
.whc__bar { background: var(--primary); border-radius: 4px 4px 0 0; min-height: 0; transition: height 220ms ease; }
.whc__bar.is-full { background: var(--success); }
.whc__deficit {
  border: 1px dashed color-mix(in srgb, var(--warning) 70%, transparent); border-bottom: none; border-radius: 4px 4px 0 0;
  background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--warning) 22%, transparent) 0 4px, transparent 4px 8px);
}
.whc__value { position: absolute; font-size: 0.75rem; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--fg); }
.whc__label { height: 1.75rem; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 0.75rem; color: var(--fg); line-height: 1.05; }
.whc__label small { font-size: 0.625rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.whc__col.is-off .whc__label { color: var(--muted); }
.whc__col.is-today .whc__label { color: var(--primary); font-weight: 700; }
.whc__col.is-future .whc__bar { opacity: 0.6; }
.whc__tip {
  position: absolute; top: 0; transform: translateX(-50%); z-index: 5; pointer-events: none;
  display: flex; flex-direction: column; gap: 0.1rem; padding: 0.45rem 0.6rem; border-radius: 0.5rem;
  background: var(--card); border: 1px solid var(--border); box-shadow: var(--shadow); font-size: 0.75rem; white-space: nowrap;
}
.whc__tip b { display: block; }
.whc__tip b::first-letter { text-transform: uppercase; }
.whc__legend { display: flex; gap: 1rem; font-size: 0.75rem; color: var(--muted); }
.whc__legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
.whc__legend i { display: inline-block; width: 0.75rem; height: 0.75rem; border-radius: 2px; }
.lg-fact { background: var(--primary); }
.lg-full { background: var(--success); }
.lg-deficit { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--warning) 40%, transparent) 0 3px, transparent 3px 6px); border: 1px dashed var(--warning); }
.lg-norm { height: 0 !important; border-top: 2px dashed var(--fg); opacity: 0.55; border-radius: 0 !important; }
</style>
