// Композабл: безопасная инициализация ECharts в WebView2.
//
// WebView2 (сандбокс Chromium) имеет нюанс: размеры хостового элемента могут быть
// недоступны в момент onMounted (flex-контейнер ещё не вычислен). Поэтому:
//  - scheduleInit отлагает init через requestAnimationFrame;
//  - если после первого RAF offsetWidth всё ещё 0 — делаем второй RAF (доп. тайминг WebView2);
//  - ResizeObserver обеспечивает адаптивный ресайз без window.resize;
//  - RAF-дебаунс resize позволяет слабым ноутбукам избежать лагов renderer.
import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import * as echarts from 'echarts/core';
import type { ECharts, EChartsOption } from 'echarts';

type Theme = 'light' | 'dark';

export function useEChart(
  containerRef: Ref<HTMLElement | null>,
  theme: Ref<Theme>,
) {
  const chart = ref<ECharts | null>(null);
  let rafId: number | null = null;
  let ro: ResizeObserver | null = null;

  function initChart() {
    if (!containerRef.value) return;
    if (chart.value) {
      chart.value.dispose();
      chart.value = null;
    }
    const el = containerRef.value;
    if (el.offsetWidth === 0) return;
    chart.value = echarts.init(el, theme.value, {
      renderer: 'canvas',
      useDirtyRect: true,
    });
  }

  function setOption(option: EChartsOption) {
    if (!chart.value) return;
    chart.value.setOption(option, { notMerge: true });
  }

  function scheduleInit(option: EChartsOption) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      const el = containerRef.value;
      if (!el) return;

      // WebView2 fix: после первого RAF flex-layout может ещё не быть готов.
      // Если offsetWidth === 0 — делаем ещё один RAF и повторную попытку.
      if (el.offsetWidth === 0) {
        rafId = requestAnimationFrame(() => {
          initChart();
          if (chart.value) chart.value.setOption(option, { notMerge: true });
        });
        return;
      }

      initChart();
      if (chart.value) chart.value.setOption(option, { notMerge: true });
    });
  }

  onMounted(() => {
    const el = containerRef.value;
    if (!el) return;
    ro = new ResizeObserver(() => {
      if (!chart.value) return;
      // RAF-дебаунс resize для слабых машин
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => chart.value?.resize());
    });
    ro.observe(el);
  });

  onUnmounted(() => {
    if (rafId) cancelAnimationFrame(rafId);
    ro?.disconnect();
    chart.value?.dispose();
    chart.value = null;
  });

  return { chart, initChart, setOption, scheduleInit };
}
