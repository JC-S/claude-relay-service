<template>
  <el-dialog
    :append-to-body="true"
    class="record-detail-modal"
    :close-on-click-modal="false"
    :destroy-on-close="true"
    :model-value="show"
    :show-close="false"
    top="10vh"
    width="720px"
    @close="emitClose"
  >
    <template #header>
      <div class="flex items-center justify-between">
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            请求详情
          </p>
          <p class="text-lg font-bold text-gray-900 dark:text-gray-100">
            {{ record?.model || '未知模型' }}
          </p>
        </div>
        <button
          aria-label="关闭"
          class="rounded-full p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          @click="emitClose"
        >
          <i class="fas fa-times" />
        </button>
      </div>
    </template>

    <div class="space-y-4">
      <div class="grid gap-3 md:grid-cols-2">
        <div
          class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900"
        >
          <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">基本信息</h4>
          <ul class="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">时间</span>
              <span class="font-medium">{{ formattedTime }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">模型</span>
              <span class="font-medium">{{ record?.model || '未知模型' }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">账户</span>
              <span class="font-medium">{{ record?.accountName || '未知账户' }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">渠道</span>
              <span class="font-medium">{{ record?.accountTypeName || '未知渠道' }}</span>
            </li>
          </ul>
        </div>

        <div
          class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900"
        >
          <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">Token 使用</h4>
          <ul class="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">输入 Token</span>
              <span class="font-semibold text-blue-600 dark:text-blue-400">
                {{ formatNumber(record?.inputTokens) }}
              </span>
            </li>
            <li
              v-if="hasImageUsage"
              class="ml-4 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400"
            >
              <span>文本输入</span>
              <span>{{ formatNumber(record?.textInputTokens) }}</span>
            </li>
            <li
              v-if="hasImageUsage"
              class="ml-4 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400"
            >
              <span>
                图片输入
                <span v-if="record?.imageUsageBreakdownEstimated" class="opacity-70">（估算）</span>
              </span>
              <span>{{ formatNumber(record?.imageInputTokens) }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">输出 Token</span>
              <span class="font-semibold text-green-600 dark:text-green-400">
                {{ formatNumber(record?.outputTokens) }}
              </span>
            </li>
            <li
              v-if="hasImageUsage"
              class="ml-4 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400"
            >
              <span>图片输出</span>
              <span>{{ formatNumber(record?.imageOutputTokens) }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">缓存创建</span>
              <span class="font-semibold text-purple-600 dark:text-purple-400">
                {{ formatNumber(record?.cacheCreateTokens) }}
              </span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">缓存读取</span>
              <span class="font-semibold text-orange-600 dark:text-orange-400">
                {{ formatNumber(record?.cacheReadTokens) }}
              </span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">总计</span>
              <span class="font-semibold text-gray-900 dark:text-gray-100">
                {{ formatNumber(record?.totalTokens) }}
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div
        v-if="hasGrokRelayMetadata"
        class="rounded-lg border border-cyan-200 bg-slate-50 p-4 dark:border-cyan-900/60 dark:bg-slate-900/40"
      >
        <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">Grok 转发详情</h4>
        <dl class="grid gap-3 text-sm sm:grid-cols-2">
          <div v-if="hasValue(record?.downstreamHttpStatus)" class="detail-row">
            <dt>下游 HTTP 状态</dt>
            <dd>{{ record.downstreamHttpStatus }}</dd>
          </div>
          <div v-if="hasValue(record?.upstreamHttpStatus)" class="detail-row">
            <dt>上游 HTTP 状态</dt>
            <dd>{{ record.upstreamHttpStatus }}</dd>
          </div>
          <div v-if="hasValue(record?.upstreamSemanticStatus)" class="detail-row">
            <dt>上游语义状态</dt>
            <dd>{{ record.upstreamSemanticStatus }}</dd>
          </div>
          <div v-if="record?.terminalType" class="detail-row">
            <dt>终态事件</dt>
            <dd>{{ record.terminalType }}</dd>
          </div>
          <div v-if="record?.errorType" class="detail-row">
            <dt>错误类型</dt>
            <dd>{{ record.errorType }}</dd>
          </div>
          <div v-if="record?.errorCode" class="detail-row">
            <dt>错误代码</dt>
            <dd>{{ record.errorCode }}</dd>
          </div>
          <div v-if="record?.upstreamRequestId" class="detail-row sm:col-span-2">
            <dt>上游请求 ID</dt>
            <dd class="break-all">{{ record.upstreamRequestId }}</dd>
          </div>
          <div v-if="record?.clientIp" class="detail-row sm:col-span-2">
            <dt>客户端 IP</dt>
            <dd class="break-all">{{ record.clientIp }}</dd>
          </div>
          <div v-if="hasValue(record?.firstTokenLatencyMs)" class="detail-row">
            <dt>首 Token 延迟</dt>
            <dd>{{ record.firstTokenLatencyMs }} ms</dd>
          </div>
          <div v-if="record?.requestedModel" class="detail-row">
            <dt>请求模型</dt>
            <dd>{{ record.requestedModel }}</dd>
          </div>
          <div v-if="record?.mappedModel" class="detail-row">
            <dt>映射模型</dt>
            <dd>{{ record.mappedModel }}</dd>
          </div>
          <div v-if="record?.actualModel" class="detail-row">
            <dt>上游实际模型</dt>
            <dd>{{ record.actualModel }}</dd>
          </div>
          <div v-if="record?.billingModel" class="detail-row">
            <dt>计费模型</dt>
            <dd>{{ record.billingModel }}</dd>
          </div>
        </dl>
      </div>

      <div
        class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
      >
        <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">费用详情</h4>
        <div class="grid gap-3 sm:grid-cols-2">
          <div
            class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
          >
            <span class="text-sm text-gray-500 dark:text-gray-400">输入费用</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ formattedCosts.input }}
            </span>
          </div>
          <div
            class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
          >
            <span class="text-sm text-gray-500 dark:text-gray-400">输出费用</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ formattedCosts.output }}
            </span>
          </div>
          <div
            class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
          >
            <span class="text-sm text-gray-500 dark:text-gray-400">缓存创建</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ formattedCosts.cacheCreate }}
            </span>
          </div>
          <div
            class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
          >
            <span class="text-sm text-gray-500 dark:text-gray-400">缓存读取</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ formattedCosts.cacheRead }}
            </span>
          </div>
        </div>
        <div
          class="mt-4 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-800"
        >
          <span class="text-sm font-semibold text-gray-700 dark:text-gray-200">总费用</span>
          <div class="text-base font-bold text-yellow-600 dark:text-yellow-400">
            {{ record?.costFormatted || formattedCosts.total }}
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end">
        <el-button type="primary" @click="emitClose">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed } from 'vue'
import dayjs from 'dayjs'
import { formatNumber } from '@/utils/tools'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  record: {
    type: Object,
    default: () => ({})
  }
})

const emit = defineEmits(['close'])
const emitClose = () => emit('close')

const hasImageUsage = computed(
  () =>
    props.record?.textInputTokens !== undefined ||
    props.record?.imageInputTokens !== undefined ||
    props.record?.imageOutputTokens !== undefined
)

const hasValue = (value) => value !== null && value !== undefined && value !== ''
const grokMetadataFields = [
  'downstreamHttpStatus',
  'upstreamHttpStatus',
  'upstreamSemanticStatus',
  'terminalType',
  'errorType',
  'errorCode',
  'upstreamRequestId',
  'clientIp',
  'firstTokenLatencyMs',
  'requestedModel',
  'mappedModel',
  'actualModel',
  'billingModel'
]
const hasGrokRelayMetadata = computed(
  () =>
    props.record?.accountType === 'grok' &&
    grokMetadataFields.some((field) => hasValue(props.record?.[field]))
)

const formattedTime = computed(() => {
  if (!props.record?.timestamp) return '未知时间'
  return dayjs(props.record.timestamp).format('YYYY-MM-DD HH:mm:ss')
})

const formattedCosts = computed(() => {
  const breakdown = props.record?.realCostBreakdown || props.record?.costBreakdown || {}
  const formatValue = (value) => {
    const num = typeof value === 'number' ? value : 0
    if (num >= 1) return `$${num.toFixed(2)}`
    if (num >= 0.001) return `$${num.toFixed(4)}`
    return `$${num.toFixed(6)}`
  }

  return {
    input: formatValue(breakdown.input),
    output: formatValue(breakdown.output),
    cacheCreate: formatValue(breakdown.cacheCreate),
    cacheRead: formatValue(breakdown.cacheRead),
    total: formatValue(breakdown.total)
  }
})
</script>

<style scoped>
.record-detail-modal :deep(.el-dialog__header) {
  margin: 0;
  padding: 16px 16px 0;
}

.record-detail-modal :deep(.el-dialog__body) {
  padding: 12px 16px 4px;
}

.record-detail-modal :deep(.el-dialog__footer) {
  padding: 8px 16px 16px;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.detail-row dt {
  color: rgb(107 114 128);
}

.detail-row dd {
  color: rgb(31 41 55);
  font-weight: 600;
  text-align: right;
}

:global(.dark) .detail-row dt {
  color: rgb(156 163 175);
}

:global(.dark) .detail-row dd {
  color: rgb(229 231 235);
}
</style>
