<template>
  <div class="dash-card">
    <div class="dash-card-header">
      <span class="dash-card-title">Разбивка часов</span>
      <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap">
        <div class="dash-tab-group">
          <button :class="['dash-tab', mode==='project' && 'active']" @click="setMode('project')">Project</button>
          <button :class="['dash-tab', mode==='issue' && 'active']" @click="setMode('issue')">Issue</button>
        </div>
        <div class="dash-tab-group">
          <button :class="['dash-tab', chartType==='donut' && 'active']" @click="chartType='donut'">Donut</button>
          <button :class="['dash-tab', chartType==='bar' && 'active']" @click="chartType='bar'">Bar</button>
        </div>
        <input type="date" class="dash-date-input" v-model="from" />
        <span style="font-size:0.8rem;opacity:.6">—</span>
        <input type="date" class="dash-date-input" v-model="to" />
      </div>
    </div>
    <div ref="chartEl" class="dash-chart-area"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, toRef } from 'vue';
import { PieChart, BarChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEChart } from '../../composables/useEChart';
import { useAnalyticsStore } from '../../store/analytics';
import { useSettingsStore } from '../../store/settings';

echarts.use([PieChart, BarChart, TooltipComponent, LegendComponent, GridComponent, CanvasRenderer]);

const store = useAnalyticsStore();
const settings = useSettingsStore();
const chartEl = ref<HTMLElement | null>(null);
const { scheduleInit } = useEChart(chartEl, toRef(settings, 'theme'));

const mode = ref<'project' | 'issue'>('project');
const chartType = ref<'donut' | 'bar'>('donut');

// период по умолчанию: последние 30 дней
const now = new Date();
const defaultFrom = new Date(now); defaultFrom.setDate(now.getDate() - 30);
const from = ref(defaultFrom.toISOString().slice(0, 10));
const to   = ref(now.toISOString().slice(0, 10));

function setMode(m: 'project' | 'issue') {
  mode.value = m;
  store.setBreakdownMode(m);
}

const PALETTE = [
  '#2a62ff', '#1fc3a0', '#ffbc4d', '#ff6b6b', '#a855f7',
  '#f97316', '#06b6d4', '#84cc16', '#ec4899', '#8b5cf6',
];

const slices = computed(() => store.breakdownSlices);

function buildOption() {
  const isDark = settings.theme === 'dark';
  const textColor = isDark ? '#c9cdd4' : '#333';
  const gridColor = isDark ? '#2e3240' : '#e8e8e8';
  const data = slices.value.slice(0, 15);

  if (chartType.value === 'donut') {
    return {
      animation: true,
      animationDuration: 500,
      animationEasing: 'cubicOut',
      backgroundColor: 'transparent',
      color: PALETTE,
      tooltip: {
        trigger: 'item',
        backgroundColor: isDark ? '#1e2535' : '#fff',
        borderColor: isDark ? '#2e3a50' : '#d8deea',
        textStyle: { color: textColor },
        formatter: (p: any) => `${p.name}: <b>${p.value} ч</b> (${p.percent}%)`,
      },
      legend: {
        type: 'scroll',
        orient: 'vertical',
        right: 0,
        top: 'center',
        textStyle: { color: textColor, fontSize: 11 },
        formatter: (name: string) => name.length > 18 ? name.slice(0, 18) + '…' : name,
      },
      series: [{
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['38%', '50%'],
        data: data.map((s, i) => ({ value: Math.round(s.hours * 100) / 100, name: s.label, itemStyle: { color: PALETTE[i % PALETTE.length] } })),
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.2)' } },
      }],
    };
  }

  // stacked bar (horizontal)
  return {
    animation: true,
    animationDuration: 400,
    backgroundColor: 'transparent',
    color: PALETTE,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: isDark ? '#1e2535' : '#fff',
      borderColor: isDark ? '#2e3a50' : '#d8deea',
      textStyle: { color: textColor },
    },
    grid: { left: 100, right: 20, top: 12, bottom: 28 },
    xAxis: { type: 'value', axisLabel: { color: textColor, formatter: '{value} ч' }, splitLine: { lineStyle: { color: gridColor } } },
    yAxis: { type: 'category', data: data.map(s => s.label.length > 14 ? s.label.slice(0, 14) + '…' : s.label), axisLabel: { color: textColor, fontSize: 11 } },
    series: data.map((s, i) => ({
      name: s.label,
      type: 'bar',
      stack: 'total',
      data: data.map((_, j) => j === i ? s.hours : 0),
      itemStyle: { color: PALETTE[i % PALETTE.length], borderRadius: i === data.length - 1 ? [0, 4, 4, 0] : 0 },
    })),
  };
}

watch([from, to], () => store.setBreakdownPeriod(from.value, to.value), { immediate: true });
watch([slices, chartType, () => settings.theme], () => scheduleInit(buildOption()), { immediate: true, deep: true });
</script>
