<template>
  <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
    <div class="summary-card">
      <p class="summary-label">总请求</p>
      <p class="summary-value">{{ formatRequestDetailNumber(summary.totalRequests) }}</p>
    </div>
    <div class="summary-card">
      <p class="summary-label">输入 / 输出</p>
      <p class="summary-value">{{ formatRequestDetailNumber(summary.inputTokens) }}</p>
      <p class="summary-sub">输出 {{ formatRequestDetailNumber(summary.outputTokens) }}</p>
    </div>
    <div class="summary-card">
      <p class="summary-label">缓存命中率</p>
      <p class="summary-value text-cyan-600 dark:text-cyan-400">
        {{ formatRequestDetailPercent(summary.cacheHitRate) }}
      </p>
      <p class="summary-sub">
        读 / (输入 + 读 + 建)：{{ formatRequestDetailNumber(summary.cacheHitNumerator) }} /
        {{ formatRequestDetailNumber(summary.cacheHitDenominator) }}
      </p>
    </div>
    <div class="summary-card">
      <p class="summary-label">总费用</p>
      <p class="summary-value text-amber-600 dark:text-amber-400">
        {{ formatRequestDetailCost(summary.totalCost) }}
      </p>
    </div>
    <div class="summary-card">
      <p class="summary-label">平均耗时</p>
      <p class="summary-value">{{ formatRequestDetailDuration(summary.avgDurationMs) }}</p>
    </div>
  </div>
</template>

<script setup>
import {
  formatRequestDetailCost,
  formatRequestDetailDuration,
  formatRequestDetailNumber,
  formatRequestDetailPercent
} from '@/utils/requestDetailFormatters.mjs'

defineProps({
  summary: { type: Object, required: true }
})
</script>

<style scoped>
.summary-card {
  border: 1px solid rgba(226, 232, 240, 0.95);
  border-radius: 16px;
  padding: 18px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.96));
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.04);
}
:global(.dark) .summary-card {
  background: linear-gradient(135deg, rgba(31, 41, 55, 0.96), rgba(17, 24, 39, 0.94));
  border-color: rgba(75, 85, 99, 0.55);
}
.summary-label {
  font-size: 13px;
  font-weight: 600;
  color: rgb(107 114 128);
}
.summary-value {
  margin-top: 8px;
  font-size: 24px;
  font-weight: 800;
  color: rgb(15 23 42);
}
:global(.dark) .summary-value {
  color: rgb(241 245 249);
}
.summary-sub {
  margin-top: 6px;
  font-size: 12px;
  color: rgb(100 116 139);
}
</style>
