<template>
  <div class="dash-card">
    <div class="dash-card-header">
      <span class="dash-card-title">Часы по дням</span>
      <div class="dash-tab-group">
        <button :class="['dash-tab', week === 'current' && 'active']" @click="week = 'current'">Текущая</button>
        <button :class="['dash-tab', week === 'prev' && 'active']" @click="week = 'prev'">Прошлая</button>
      </div>
    </div>
    <div ref="chartEl" class="dash-chart-area"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, toRef } from 'vue';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsOption } from 'echarts';
import { CanvasRenderer } from 'echarts/renderers';
import { useEChart } from '../../composables/useEChart';
import { useAnalyticsStore } from '../../store/analytics';
import { useSettingsStore } from '../../store/settings';

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const store = useAnalyticsStore();
const settings = useSettingsStore();
const week = ref<'current' | 'prev'>('current');
const chartEl = ref<HTMLElement | null>(null);
const { scheduleInit } = useEChart(chartEl, toRef(settings, 'theme'));

const bars = computed(() => week.value === 'current' ? store.currentWeekBars : store.prevWeekBars);

function buildOption(): EChartsOption {
  const isDark = settings.theme === 'dark';
  const textColor  = isDark ? '#c9cdd4' : '#333';
  const gridColor  = isDark ? '#2e3240' : '#e8e8e8';
  const planColor  = isDark ? '#3d4966' : '#d4e0ff';
  const factColor  = isDark ? '#5a8ff7' : '#2a62ff';
  const overColor  = isDark ? '#45c27a' : '#1c8c4e';
  const b = bars.value;

  return {
    animation: true,
    animationDuration: 400,
    animationEasing: 'cubicOut',
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: isDark ? '#1e2535' : '#fff',
      borderColor: isDark ? '#2e3a50' : '#d8deea',
      textStyle: { color: textColor },
      formatter: (params: any) => {
        const d = b[params[0].dataIndex];
        return `<b>${d.label} (${d.date})</b><br/>` +
          `План: ${d.plan} ч<br/>Факт: ${d.fact} ч`;
      },
    },
    legend: {
      data: ['План', 'Факт'],
      textStyle: { color: textColor },
      itemHeight: 10,
      right: 0,
    },
    grid: { left: 36, right: 12, top: 36, bottom: 28, containLabel: false },
    xAxis: {
      type: 'category',
      data: b.map(d => d.label),
      axisLine: { lineStyle: { color: gridColor } },
      axisLabel: { color: textColor },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: gridColor } },
      axisLabel: { color: textColor, formatter: '{value} ч' },
    },
    series: [
      {
        name: 'План',
        type: 'bar',
        data: b.map(d => d.plan),
        barGap: '-100%',
        barCategoryGap: '35%',
        itemStyle: { color: planColor, borderRadius: [4, 4, 0, 0] },
        z: 1,
      },
      {
        name: 'Факт',
        type: 'bar',
        data: b.map(d => ({
          value: d.fact,
          itemStyle: { color: d.fact >= d.plan && d.plan > 0 ? overColor : factColor, borderRadius: [4, 4, 0, 0] },
        })),
        barCategoryGap: '35%',
        z: 2,
      },
    ],
  };
}

watch([bars, () => settings.theme], () => scheduleInit(buildOption()), { immediate: true });
</script>
