<template>
  <div class="dash-card">
    <div class="dash-card-header">
      <span class="dash-card-title">Заполненность worklog &mdash; 3 месяца</span>
      <div class="heatmap-legend">
        <span class="legend-label">меньше</span>
        <span v-for="l in [0,1,2,3,4]" :key="l" class="legend-cell" :data-level="l"></span>
        <span class="legend-label">больше</span>
      </div>
    </div>
    <div class="heatmap-scroll-wrap">
      <div class="heatmap-grid">
        <!-- заголовки дней недели -->
        <div class="heatmap-weekdays">
          <span v-for="d in weekdayLabels" :key="d">{{ d }}</span>
        </div>
        <!-- колонки по неделям -->
        <div class="heatmap-weeks">
          <div v-for="(week, wi) in weeks" :key="wi" class="heatmap-week">
            <div
              v-for="cell in week"
              :key="cell ? cell.date : wi + '-empty'"
              class="heatmap-cell"
              :data-level="cell ? cell.level : -1"
              :title="cell ? `${cell.date}: ${cell.hours} ч` : ''"
            ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAnalyticsStore, type HeatmapCell } from '../../store/analytics';

const store = useAnalyticsStore();

const weekdayLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Группируем ячейки по неделям (вертикальные колонки), как в GitHub contribution graph
// Неделя начинается с понедельника (индекс 0 = Пн)
const weeks = computed(() => {
  const cells = store.heatmapCells;
  if (!cells.length) return [];

  // находим день недели первой ячейки (индекс 1 = Пн в getDay())
  const firstDate = new Date(cells[0].date);
  const startDow = firstDate.getDay(); // 0=Вс, 1=Пн ...
  // преобразуем: 0=Пн..6=Вс
  const offset = startDow === 0 ? 6 : startDow - 1;

  // заполняем пустыми в начале
  const flat: (HeatmapCell | null)[] = [
    ...Array(offset).fill(null),
    ...cells,
  ];

  // бьём по 7 элементов в колонку
  const result: (HeatmapCell | null)[][] = [];
  for (let i = 0; i < flat.length; i += 7) {
    const col = flat.slice(i, i + 7);
    while (col.length < 7) col.push(null);
    result.push(col);
  }
  return result;
});
</script>

<style scoped>
.heatmap-scroll-wrap {
  overflow-x: auto;
  padding-bottom: 0.25rem;
}
.heatmap-grid {
  display: flex;
  gap: 0.375rem;
  min-width: max-content;
}
.heatmap-weekdays {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 2px;
}
.heatmap-weekdays span {
  font-size: 0.7rem;
  color: var(--muted);
  width: 1.5rem;
  height: 14px;
  line-height: 14px;
  text-align: right;
}
.heatmap-weeks {
  display: flex;
  gap: 3px;
}
.heatmap-week {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.heatmap-cell {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  background: var(--heatmap-0);
  transition: background 0.15s;
  cursor: default;
}
.heatmap-cell[data-level="-1"] { background: transparent; }
.heatmap-cell[data-level="0"]  { background: var(--heatmap-0); }
.heatmap-cell[data-level="1"]  { background: var(--heatmap-1); }
.heatmap-cell[data-level="2"]  { background: var(--heatmap-2); }
.heatmap-cell[data-level="3"]  { background: var(--heatmap-3); }
.heatmap-cell[data-level="4"]  { background: var(--heatmap-4); }
.heatmap-cell:hover { opacity: 0.75; }

.heatmap-legend {
  display: flex;
  align-items: center;
  gap: 3px;
}
.legend-label {
  font-size: 0.7rem;
  color: var(--muted);
  padding: 0 0.25rem;
}
.legend-cell {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 2px;
}
.legend-cell[data-level="0"] { background: var(--heatmap-0); }
.legend-cell[data-level="1"] { background: var(--heatmap-1); }
.legend-cell[data-level="2"] { background: var(--heatmap-2); }
.legend-cell[data-level="3"] { background: var(--heatmap-3); }
.legend-cell[data-level="4"] { background: var(--heatmap-4); }
</style>
