<template>
  <el-dialog
    :append-to-body="true"
    class="request-detail-modal"
    :close-on-click-modal="false"
    :destroy-on-close="true"
    :fullscreen="isMobileViewport"
    :model-value="show"
    :show-close="false"
    top="6vh"
    width="960px"
    @close="$emit('close')"
  >
    <template #header>
      <div class="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap sm:items-center">
        <div class="min-w-0 flex-1">
          <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">
            {{ detail?.model || '加载中...' }}
          </h3>
          <p class="mt-1 break-all text-xs text-gray-500 dark:text-gray-400 sm:text-sm">
            Request ID: {{ requestId || '未知' }}
          </p>
        </div>
        <div class="flex items-center gap-2 self-start sm:self-center">
          <el-tag v-if="detail" effect="dark" :type="statusTagType(detail.statusCode)">{{
            detail.statusCode || 200
          }}</el-tag>
          <button
            aria-label="关闭"
            class="modal-close-button"
            type="button"
            @click="$emit('close')"
          >
            <i class="fas fa-times" />
          </button>
        </div>
      </div>
    </template>

    <div v-loading="loading" class="space-y-4">
      <div
        v-if="!loading && !detail"
        class="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
      >
        未找到该请求详情
      </div>
      <template v-else-if="detail">
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div class="info-card">
            <p class="info-label">接口</p>
            <p class="info-value">{{ detail.endpoint || '-' }}</p>
            <p class="info-sub">{{ detail.method || 'POST' }}</p>
          </div>
          <div class="info-card">
            <p class="info-label">耗时</p>
            <p class="info-value">{{ formatRequestDetailDuration(detail.durationMs) }}</p>
            <p class="info-sub">{{ detail.stream ? '流式请求' : '非流式请求' }}</p>
          </div>
          <div class="info-card">
            <p class="info-label">费用</p>
            <p class="info-value text-amber-600 dark:text-amber-400">
              {{ formatRequestDetailCost(detail.cost) }}
            </p>
            <p v-if="admin" class="info-sub">
              {{ detail.costRecomputed ? '估算成本' : '真实成本' }}
              {{ formatRequestDetailCost(detail.realCost) }}
              <span v-if="detail.usedFallbackPricing">unknown fallback</span>
            </p>
            <p v-else class="info-sub">倍率后计费成本</p>
          </div>
          <div class="info-card">
            <p class="info-label">缓存命中率</p>
            <p class="info-value text-cyan-600 dark:text-cyan-400">
              {{ formatRequestDetailPercent(detail.cacheHitRate) }}
            </p>
            <p class="info-sub">读 / (输入 + 读 + 建)</p>
          </div>
        </div>

        <div class="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
          <section class="detail-panel">
            <h4 class="section-title">基础信息</h4>
            <div class="grid gap-3 md:grid-cols-2">
              <div>
                <p class="field-label">时间</p>
                <p class="field-value">{{ formatRequestDetailDate(detail.timestamp) }}</p>
              </div>
              <div>
                <p class="field-label">API Key</p>
                <p class="field-value">{{ detail.apiKeyName || detail.apiKeyId || '-' }}</p>
                <p class="field-sub">{{ detail.apiKeyId || '-' }}</p>
              </div>
              <div v-if="admin">
                <p class="field-label">使用账户</p>
                <p class="field-value">{{ detail.accountName || detail.accountId || '-' }}</p>
                <p class="field-sub">{{ detail.accountTypeName || detail.accountType || '-' }}</p>
              </div>
              <div>
                <p class="field-label">模型</p>
                <p class="field-value">{{ detail.model || '-' }}</p>
                <p class="field-sub">
                  {{ detail.isLongContextRequest ? '长上下文请求' : '标准上下文' }}
                </p>
              </div>
              <div>
                <p class="field-label">推理</p>
                <p class="field-value">
                  {{ formatRequestDetailReasoning(detail.reasoningDisplay) }}
                </p>
                <p v-if="admin" class="field-sub">
                  {{ detail.reasoningSource ? `来源：${detail.reasoningSource}` : '未指定' }}
                </p>
              </div>
              <div
                v-if="admin && (detail.usageType || detail.responsesLite || detail.webSearchCalls)"
              >
                <p class="field-label">请求类型</p>
                <p class="field-value">{{ detail.usageType || 'OpenAI Responses' }}</p>
                <p class="field-sub">
                  <span v-if="detail.responsesLite">Responses Lite</span
                  ><span v-else-if="detail.webSearchCalls"
                    >Web Search {{ detail.webSearchCalls }} 次</span
                  ><span v-else>标准请求</span>
                </p>
              </div>
              <div v-if="admin">
                <p class="field-label">出口本地 IP</p>
                <p class="field-value">{{ detail.upstreamNicIp || '—' }}</p>
                <p class="field-sub">{{ detail.upstreamNicIp ? '多网卡轮询' : '默认出口' }}</p>
              </div>
            </div>
          </section>

          <section class="detail-panel">
            <h4 class="section-title">Token 明细</h4>
            <div class="space-y-2 text-sm">
              <div class="metric-row">
                <span>输入</span
                ><span class="font-semibold text-blue-600 dark:text-blue-400">{{
                  formatRequestDetailNumber(detail.inputTokens)
                }}</span>
              </div>
              <div
                v-if="hasImageUsage"
                class="metric-row ml-4 text-xs text-gray-500 dark:text-gray-400"
              >
                <span>文本输入</span
                ><span>{{ formatRequestDetailNumber(detail.textInputTokens) }}</span>
              </div>
              <div
                v-if="hasImageUsage"
                class="metric-row ml-4 text-xs text-gray-500 dark:text-gray-400"
              >
                <span
                  >图片输入<span v-if="detail.imageUsageBreakdownEstimated" class="opacity-70"
                    >（估算）</span
                  ></span
                ><span>{{ formatRequestDetailNumber(detail.imageInputTokens) }}</span>
              </div>
              <div class="metric-row">
                <span>输出</span
                ><span class="font-semibold text-green-600 dark:text-green-400">{{
                  formatRequestDetailNumber(detail.outputTokens)
                }}</span>
              </div>
              <div
                v-if="hasImageUsage"
                class="metric-row ml-4 text-xs text-gray-500 dark:text-gray-400"
              >
                <span>图片输出</span
                ><span>{{ formatRequestDetailNumber(detail.imageOutputTokens) }}</span>
              </div>
              <div class="metric-row">
                <span>缓存读取</span
                ><span class="font-semibold text-cyan-600 dark:text-cyan-400">{{
                  formatRequestDetailNumber(detail.cacheReadTokens)
                }}</span>
              </div>
              <div class="metric-row">
                <span>缓存创建</span
                ><span class="font-semibold text-purple-600 dark:text-purple-400">{{
                  formatRequestDetailCacheCreate(
                    detail.cacheCreateTokens,
                    detail.cacheCreateNotApplicable
                  )
                }}</span>
              </div>
              <div
                class="metric-row border-t border-dashed border-gray-200 pt-2 dark:border-gray-700"
              >
                <span>总 Token</span
                ><span class="font-semibold text-gray-900 dark:text-gray-100">{{
                  formatRequestDetailNumber(detail.totalTokens)
                }}</span>
              </div>
            </div>
          </section>
        </div>

        <section
          v-if="admin && hasGrokRelayMetadata"
          class="rounded-xl border border-cyan-200 bg-slate-50 p-4 shadow-sm dark:border-cyan-900/60 dark:bg-slate-900/40"
        >
          <h4 class="section-title">Grok 转发详情</h4>
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div v-for="field in visibleGrokFields" :key="field.key">
              <p class="field-label">{{ field.label }}</p>
              <p class="field-value break-all">
                {{ field.duration ? formatRequestDetailDuration(field.value) : field.value }}
              </p>
            </div>
          </div>
        </section>

        <section class="detail-panel">
          <h4 class="section-title">费用拆分</h4>
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div class="cost-chip">
              <span>输入</span><strong>{{ formatRequestDetailCost(costBreakdown.input) }}</strong>
            </div>
            <div class="cost-chip">
              <span>输出</span><strong>{{ formatRequestDetailCost(costBreakdown.output) }}</strong>
            </div>
            <div class="cost-chip">
              <span>缓存创建</span
              ><strong>{{
                formatRequestDetailCacheCreateCost(
                  costBreakdown.cacheCreate,
                  detail.cacheCreateNotApplicable
                )
              }}</strong>
            </div>
            <div class="cost-chip">
              <span>缓存读取</span
              ><strong>{{ formatRequestDetailCost(costBreakdown.cacheRead) }}</strong>
            </div>
            <div class="cost-chip">
              <span>总计</span
              ><strong>{{ formatRequestDetailCost(costBreakdown.total || detail.cost) }}</strong>
            </div>
          </div>
        </section>

        <section v-if="admin" class="detail-panel">
          <div class="mb-3 flex items-center justify-between gap-3">
            <h4 class="section-title mb-0">Request Body 快照</h4>
            <el-button v-if="formattedSnapshot" size="small" @click="$emit('copy-snapshot')"
              >复制 JSON</el-button
            >
          </div>
          <div v-if="formattedSnapshot" class="snapshot-panel">
            <pre>{{ formattedSnapshot }}</pre>
          </div>
          <div
            v-else-if="!bodyPreviewEnabled"
            class="rounded-lg border border-dashed border-amber-300 bg-amber-50/70 px-4 py-6 text-sm text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
          >
            请求体预览已关闭，当前仅保留请求摘要字段，不展示请求体快照。
          </div>
          <div
            v-else
            class="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
          >
            未保存请求体快照
          </div>
        </section>
      </template>
    </div>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  formatRequestDetailCacheCreate,
  formatRequestDetailCacheCreateCost,
  formatRequestDetailCost,
  formatRequestDetailDate,
  formatRequestDetailDuration,
  formatRequestDetailNumber,
  formatRequestDetailPercent,
  formatRequestDetailReasoning
} from '@/utils/requestDetailFormatters.mjs'

const props = defineProps({
  show: { type: Boolean, default: false },
  requestId: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  detail: { type: Object, default: null },
  mode: { type: String, default: 'v2' },
  bodyPreviewEnabled: { type: Boolean, default: false },
  formattedSnapshot: { type: String, default: '' }
})
defineEmits(['close', 'copy-snapshot'])

const admin = computed(() => props.mode === 'admin')
const isMobileViewport = ref(false)
const hasImageUsage = computed(
  () =>
    props.detail?.textInputTokens !== undefined ||
    props.detail?.imageInputTokens !== undefined ||
    props.detail?.imageOutputTokens !== undefined
)
const costBreakdown = computed(() => {
  const source = admin.value
    ? props.detail?.realCostBreakdown || props.detail?.costBreakdown || {}
    : props.detail?.costBreakdown || {}
  return {
    input: source.input || 0,
    output: source.output || 0,
    cacheCreate: source.cacheCreate || source.cacheWrite || 0,
    cacheRead: source.cacheRead || 0,
    total: source.total || (admin.value ? props.detail?.realCost : props.detail?.cost) || 0
  }
})
const grokFields = [
  ['downstreamHttpStatus', '下游 HTTP 状态'],
  ['upstreamHttpStatus', '上游 HTTP 状态'],
  ['upstreamSemanticStatus', '上游语义状态'],
  ['terminalType', '终态事件'],
  ['errorType', '错误类型'],
  ['errorCode', '错误代码'],
  ['upstreamRequestId', '上游请求 ID'],
  ['clientIp', '客户端 IP'],
  ['firstTokenLatencyMs', '首 Token 延迟', true],
  ['requestedModel', '请求模型'],
  ['mappedModel', '映射模型'],
  ['actualModel', '上游实际模型'],
  ['billingModel', '计费模型']
]
const visibleGrokFields = computed(() =>
  grokFields
    .filter(
      ([key]) =>
        props.detail?.[key] !== null &&
        props.detail?.[key] !== undefined &&
        props.detail?.[key] !== ''
    )
    .map(([key, label, duration]) => ({ key, label, duration, value: props.detail[key] }))
)
const hasGrokRelayMetadata = computed(
  () => props.detail?.accountType === 'grok' && visibleGrokFields.value.length > 0
)
const statusTagType = (statusCode) =>
  statusCode >= 500 ? 'danger' : statusCode >= 400 ? 'warning' : 'success'
const syncViewportState = () => {
  if (typeof window !== 'undefined') isMobileViewport.value = window.innerWidth < 768
}
onMounted(() => {
  syncViewportState()
  window.addEventListener('resize', syncViewportState)
})
onBeforeUnmount(() => window.removeEventListener('resize', syncViewportState))
</script>

<style scoped>
.request-detail-modal :deep(.el-dialog) {
  width: min(960px, calc(100vw - 32px));
  max-width: calc(100vw - 32px);
  margin: 0 auto;
  overflow: hidden;
  border-radius: 24px;
}
.request-detail-modal :deep(.el-dialog__header) {
  position: sticky;
  top: 0;
  z-index: 3;
  margin: 0;
  padding: 18px 20px 0;
  background: rgba(255, 255, 255, 0.98);
  backdrop-filter: blur(10px);
}
:global(.dark) .request-detail-modal :deep(.el-dialog__header) {
  background: rgba(17, 24, 39, 0.98);
}
.request-detail-modal :deep(.el-dialog__body) {
  max-height: min(78vh, 920px);
  overflow-y: auto;
  padding: 12px 20px 20px;
}
.request-detail-modal :deep(.el-dialog.is-fullscreen) {
  width: 100vw !important;
  max-width: none;
  height: 100vh;
  margin: 0;
  border-radius: 0;
}
.request-detail-modal :deep(.el-dialog.is-fullscreen .el-dialog__body) {
  height: calc(100vh - 76px);
  max-height: none;
}
.modal-close-button {
  display: inline-flex;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  color: rgb(100 116 139);
  transition: all 0.2s ease;
}
.modal-close-button:hover {
  background: rgba(148, 163, 184, 0.14);
  color: rgb(51 65 85);
}
.info-card,
.detail-panel {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.96));
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
:global(.dark) .info-card,
:global(.dark) .detail-panel {
  border-color: rgba(71, 85, 105, 0.35);
  background: linear-gradient(135deg, rgba(17, 24, 39, 0.94), rgba(15, 23, 42, 0.92));
}
.info-card {
  padding: 16px;
}
.detail-panel {
  padding: 16px;
}
.info-label,
.field-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(100 116 139);
}
.info-value,
.field-value {
  margin-top: 6px;
  font-size: 18px;
  font-weight: 700;
  color: rgb(15 23 42);
}
:global(.dark) .info-value,
:global(.dark) .field-value {
  color: rgb(241 245 249);
}
.info-sub,
.field-sub {
  margin-top: 4px;
  font-size: 12px;
  color: rgb(100 116 139);
}
.section-title {
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 700;
  color: rgb(30 41 59);
}
:global(.dark) .section-title {
  color: rgb(226 232 240);
}
.metric-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.cost-chip {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-radius: 14px;
  background: rgb(248 250 252);
  padding: 12px 14px;
  font-size: 13px;
}
:global(.dark) .cost-chip {
  background: rgba(30, 41, 59, 0.75);
}
.snapshot-panel {
  max-height: 380px;
  overflow: auto;
  border-radius: 14px;
  background: rgb(15 23 42);
  padding: 16px;
}
.snapshot-panel pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: rgb(226 232 240);
  font-size: 12px;
  line-height: 1.55;
}
@media (max-width: 767px) {
  .request-detail-modal :deep(.el-dialog__header) {
    padding: 14px 16px 0;
  }
  .request-detail-modal :deep(.el-dialog__body) {
    max-height: calc(100vh - 88px);
    padding: 12px 16px 20px;
  }
  .info-value,
  .field-value {
    font-size: 16px;
  }
}
</style>
