<template>
  <div class="table-wrapper">
    <div
      v-if="loading"
      class="flex items-center justify-center p-12 text-gray-500 dark:text-gray-400"
    >
      <i class="fas fa-spinner fa-spin mr-2" />加载中...
    </div>
    <div
      v-else-if="records.length === 0"
      class="flex flex-col items-center gap-3 p-12 text-center text-gray-500 dark:text-gray-400"
    >
      <i class="fas fa-inbox text-3xl text-cyan-500" />
      <p class="text-base font-semibold text-gray-700 dark:text-gray-200">暂无请求明细</p>
      <p class="max-w-xl text-sm">{{ emptyHint }}</p>
    </div>
    <div v-else class="space-y-4">
      <div class="table-container hidden xl:block">
        <table class="request-table w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead
            class="sticky top-0 z-10 bg-gradient-to-b from-gray-50 to-gray-100/90 backdrop-blur-sm dark:from-gray-700 dark:to-gray-800/90"
          >
            <tr>
              <th class="table-heading min-w-[170px]">统计时间</th>
              <th class="table-heading min-w-[170px]">API Key</th>
              <th v-if="admin" class="table-heading min-w-[170px]">使用账户</th>
              <th class="table-heading min-w-[140px]">模型</th>
              <th class="table-heading min-w-[110px]">推理</th>
              <th class="table-heading min-w-[180px]">接口</th>
              <th class="table-heading min-w-[96px]">输入</th>
              <th class="table-heading min-w-[96px]">输出</th>
              <th class="table-heading min-w-[110px]">缓存读取</th>
              <th class="table-heading min-w-[110px]">缓存创建</th>
              <th class="table-heading min-w-[110px]">缓存命中率</th>
              <th class="table-heading min-w-[100px]">费用</th>
              <th class="table-heading min-w-[100px]">耗时</th>
              <th class="table-heading min-w-[96px] text-right">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
            <tr
              v-for="record in records"
              :key="record.requestId"
              class="request-row hover:bg-gray-50/90 dark:hover:bg-gray-800/70"
            >
              <td class="table-cell">
                <div class="font-medium">{{ formatRequestDetailDate(record.timestamp) }}</div>
                <div class="subline">{{ record.requestId }}</div>
              </td>
              <td class="table-cell">
                <div class="font-semibold">{{ record.apiKeyName || record.apiKeyId || '-' }}</div>
                <div class="subline">{{ record.apiKeyId || '-' }}</div>
              </td>
              <td v-if="admin" class="table-cell">
                <div class="font-semibold">{{ record.accountName || record.accountId || '-' }}</div>
                <div class="subline">{{ record.accountTypeName || record.accountType || '-' }}</div>
              </td>
              <td class="table-cell">{{ record.model }}</td>
              <td class="table-cell">
                {{ formatRequestDetailReasoning(record.reasoningDisplay) }}
              </td>
              <td class="table-cell">
                <div>{{ record.endpoint || '-' }}</div>
                <div class="subline">{{ record.method || 'POST' }}</div>
              </td>
              <td class="table-cell text-blue-600 dark:text-blue-400">
                {{ formatRequestDetailNumber(record.inputTokens) }}
              </td>
              <td class="table-cell text-green-600 dark:text-green-400">
                {{ formatRequestDetailNumber(record.outputTokens) }}
              </td>
              <td class="table-cell text-cyan-600 dark:text-cyan-400">
                {{ formatRequestDetailNumber(record.cacheReadTokens) }}
              </td>
              <td class="table-cell text-purple-600 dark:text-purple-400">
                {{
                  formatRequestDetailCacheCreate(
                    record.cacheCreateTokens,
                    record.cacheCreateNotApplicable
                  )
                }}
              </td>
              <td class="table-cell">{{ formatRequestDetailPercent(record.cacheHitRate) }}</td>
              <td class="table-cell text-amber-600 dark:text-amber-400">
                {{ formatRequestDetailCost(record.cost) }}
              </td>
              <td class="table-cell">{{ formatRequestDetailDuration(record.durationMs) }}</td>
              <td class="table-cell text-right">
                <DetailButton @click="$emit('open-detail', record.requestId)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="space-y-3 xl:hidden">
        <div
          v-for="record in records"
          :key="record.requestId"
          class="card p-4 transition-shadow hover:shadow-lg"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="break-words text-sm font-bold text-gray-900 dark:text-gray-100">
                {{ record.model }}
              </p>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {{ formatRequestDetailDate(record.timestamp) }}
              </p>
              <p class="break-all text-xs text-gray-500 dark:text-gray-400">
                {{ record.endpoint || '-' }}
              </p>
            </div>
            <DetailButton @click="$emit('open-detail', record.requestId)" />
          </div>
          <div class="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-700 dark:text-gray-300">
            <div>API Key：{{ record.apiKeyName || '-' }}</div>
            <div v-if="admin">账户：{{ record.accountName || '-' }}</div>
            <div>推理：{{ formatRequestDetailReasoning(record.reasoningDisplay) }}</div>
            <div>接口：{{ record.method || 'POST' }}</div>
            <div class="text-blue-600 dark:text-blue-400">
              输入：{{ formatRequestDetailNumber(record.inputTokens) }}
            </div>
            <div class="text-green-600 dark:text-green-400">
              输出：{{ formatRequestDetailNumber(record.outputTokens) }}
            </div>
            <div class="text-cyan-600 dark:text-cyan-400">
              缓存读：{{ formatRequestDetailNumber(record.cacheReadTokens) }}
            </div>
            <div class="text-purple-600 dark:text-purple-400">
              缓存建：{{
                formatRequestDetailCacheCreate(
                  record.cacheCreateTokens,
                  record.cacheCreateNotApplicable
                )
              }}
            </div>
            <div>命中率：{{ formatRequestDetailPercent(record.cacheHitRate) }}</div>
            <div>耗时：{{ formatRequestDetailDuration(record.durationMs) }}</div>
            <div class="text-amber-600 dark:text-amber-400">
              费用：{{ formatRequestDetailCost(record.cost) }}
            </div>
            <div class="break-all text-xs text-gray-500 dark:text-gray-400">
              {{ record.requestId }}
            </div>
          </div>
        </div>
      </div>

      <div
        class="flex flex-col gap-3 border-t border-gray-200 px-4 pb-4 pt-4 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="text-sm text-gray-500 dark:text-gray-400">
          共 {{ pagination.totalRecords }} 条记录
        </div>
        <el-pagination
          background
          :current-page="pagination.currentPage"
          layout="prev, pager, next, sizes"
          :page-size="pagination.pageSize"
          :page-sizes="[20, 50, 100, 200]"
          :total="pagination.totalRecords"
          @current-change="$emit('page-change', $event)"
          @size-change="$emit('size-change', $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { defineComponent, h } from 'vue'
import {
  formatRequestDetailCacheCreate,
  formatRequestDetailCost,
  formatRequestDetailDate,
  formatRequestDetailDuration,
  formatRequestDetailNumber,
  formatRequestDetailPercent,
  formatRequestDetailReasoning
} from '@/utils/requestDetailFormatters.mjs'

defineProps({
  records: { type: Array, default: () => [] },
  pagination: { type: Object, required: true },
  loading: { type: Boolean, default: false },
  admin: { type: Boolean, default: false },
  emptyHint: { type: String, required: true }
})
defineEmits(['open-detail', 'page-change', 'size-change'])

const DetailButton = defineComponent({
  emits: ['click'],
  setup(_, { emit }) {
    return () =>
      h(
        'button',
        {
          class:
            'inline-flex shrink-0 items-center rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition-all duration-200 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-700',
          onClick: () => emit('click')
        },
        '详情'
      )
  }
})
</script>

<style scoped>
.table-wrapper {
  position: relative;
  width: 100%;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.05);
  border-radius: 12px;
}
:global(.dark) .table-wrapper {
  border-color: rgba(255, 255, 255, 0.1);
}
.table-container {
  position: relative;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
}
.table-container table {
  min-width: 1390px;
  border-collapse: collapse;
  table-layout: auto;
}
.request-table {
  width: max(100%, 1390px);
}
.table-heading {
  padding: 16px 12px;
  text-align: left;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: rgb(55 65 81);
}
:global(.dark) .table-heading {
  color: rgb(209 213 219);
}
.table-cell {
  padding: 14px 16px;
  vertical-align: top;
  font-size: 13px;
  color: rgb(31 41 55);
}
:global(.dark) .table-cell {
  color: rgb(226 232 240);
}
.subline {
  font-size: 12px;
  color: rgb(107 114 128);
}
.request-table tbody tr:nth-child(even) {
  background: rgba(249, 250, 251, 0.65);
}
:global(.dark) .request-table tbody tr:nth-child(even) {
  background: rgba(31, 41, 55, 0.55);
}
.table-container::-webkit-scrollbar {
  height: 8px;
}
.table-container::-webkit-scrollbar-track {
  border-radius: 4px;
  background: #f3f4f6;
}
.table-container::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: #d1d5db;
}
:global(.dark) .table-container::-webkit-scrollbar-track {
  background: rgba(31, 41, 55, 0.9);
}
:global(.dark) .table-container::-webkit-scrollbar-thumb {
  background: rgba(107, 114, 128, 0.9);
}
</style>
