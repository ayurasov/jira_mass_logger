// Композабл: безопасная инициализация ECharts в WebView2.
//
// WebView2 (Chromium-сандбокс) имеет нюанс: размеры хостового элемента могут быть
// недоступны в момент onMounted (flex-контейнер ещё не вычислен). Поэтому:
//  - инициализация отложена через requestAnimationFrame (RAF) для синхронизации
//    с layout-pass-ом браузера;
//  - ResizeObserver обеспечивает адаптивный ресайз без window.resize;
//  - requestAnimationFrame + RAF-дебаунс resize позволяет слабым
//    корпоративным ноутбукам избежать лагов renderer при всплесках;
//  - диспозер корректно дестроит ECharts-экземпляр и отписывается от ResizeObserver.
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
    // проверяем, что размеры уже есть (WebView2 WebView layout fix)
    if (el.offsetWidth === 0) return;
    chart.value = echarts.init(el, theme.value, {
      renderer: 'canvas',  // canvas лучше для производительности на слабых машинах
      useDirtyRect: true,  // перерисовывает только изменівшиеся области
    });
  }

  function setOption(option: EChartsOption) {
    if (!chart.value) return;
    chart.value.setOption(option, { notMerge: true });
  }

  function scheduleInit(option: EChartsOption) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
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
