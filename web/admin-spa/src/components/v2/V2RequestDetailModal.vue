<template>
  <el-dialog
    :append-to-body="true"
    class="v2-request-detail-modal"
    :close-on-click-modal="false"
    :destroy-on-close="true"
    :model-value="show"
    :show-close="false"
    top="7vh"
    width="820px"
    @close="$emit('close')"
  >
    <template #header>
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h3 class="text-lg font-bold text-slate-900 dark:text-slate-100">
            {{ detail?.model || '请求详情' }}
          </h3>
          <p class="mt-1 break-all text-xs text-slate-500">{{ requestId }}</p>
        </div>
        <button class="modal-close" type="button" @click="$emit('close')">
          <i class="fas fa-times" />
        </button>
      </div>
    </template>

    <div v-loading="loading">
      <div v-if="!loading && !detail" class="empty-state">未找到该请求详情</div>
      <div v-else-if="detail" class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="metric-card">
            <span>状态</span>
            <strong :class="statusClass(detail.statusCode)">{{ detail.statusCode || '-' }}</strong>
          </div>
          <div class="metric-card">
            <span>费用</span>
            <strong class="text-amber-600 dark:text-amber-400">{{
              formatCost(detail.cost)
            }}</strong>
          </div>
          <div class="metric-card">
            <span>耗时</span>
            <strong>{{ formatDuration(detail.durationMs) }}</strong>
          </div>
          <div class="metric-card">
            <span>缓存命中率</span>
            <strong class="text-cyan-600 dark:text-cyan-400">{{
              formatPercent(detail.cacheHitRate)
            }}</strong>
          </div>
        </div>

        <section class="detail-panel">
          <h4>基础信息</h4>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <span class="field-label">时间</span>
              <p>{{ formatDate(detail.timestamp) }}</p>
            </div>
            <div>
              <span class="field-label">API Key</span>
              <p>{{ detail.apiKeyName || detail.apiKeyId || '-' }}</p>
              <small>{{ detail.apiKeyId || '-' }}</small>
            </div>
            <div>
              <span class="field-label">接口</span>
              <p>{{ detail.endpoint || '-' }}</p>
              <small>{{ detail.method || '-' }} · {{ detail.stream ? '流式' : '非流式' }}</small>
            </div>
            <div>
              <span class="field-label">推理</span>
              <p>{{ detail.reasoningDisplay || '-' }}</p>
              <small>{{ detail.isLongContextRequest ? '长上下文请求' : '标准上下文' }}</small>
            </div>
          </div>
        </section>

        <div class="grid gap-4 lg:grid-cols-2">
          <section class="detail-panel">
            <h4>Token 明细</h4>
            <div class="space-y-2">
              <div class="detail-row">
                <span>输入</span><b>{{ fmt(detail.inputTokens) }}</b>
              </div>
              <div class="detail-row">
                <span>输出</span><b>{{ fmt(detail.outputTokens) }}</b>
              </div>
              <div class="detail-row">
                <span>缓存读取</span><b>{{ fmt(detail.cacheReadTokens) }}</b>
              </div>
              <div class="detail-row">
                <span>缓存创建</span>
                <b>{{ detail.cacheCreateNotApplicable ? '-' : fmt(detail.cacheCreateTokens) }}</b>
              </div>
              <div class="detail-row total-row">
                <span>总 Token</span><b>{{ fmt(detail.totalTokens) }}</b>
              </div>
            </div>
          </section>

          <section class="detail-panel">
            <h4>费用拆分</h4>
            <div class="space-y-2">
              <div class="detail-row">
                <span>输入</span><b>{{ formatCost(costBreakdown.input) }}</b>
              </div>
              <div class="detail-row">
                <span>输出</span><b>{{ formatCost(costBreakdown.output) }}</b>
              </div>
              <div class="detail-row">
                <span>缓存创建</span><b>{{ formatCost(costBreakdown.cacheCreate) }}</b>
              </div>
              <div class="detail-row">
                <span>缓存读取</span><b>{{ formatCost(costBreakdown.cacheRead) }}</b>
              </div>
              <div class="detail-row total-row">
                <span>总计</span><b>{{ formatCost(costBreakdown.total || detail.cost) }}</b>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { getV2RequestDetailApi } from '@/utils/http_apis'
import { formatNumber, showToast } from '@/utils/tools'

const props = defineProps({
  show: { type: Boolean, default: false },
  requestId: { type: String, default: '' }
})
defineEmits(['close'])

const loading = ref(false)
const detail = ref(null)
const costBreakdown = computed(() => detail.value?.costBreakdown || {})
const fmt = (value) => formatNumber(Number(value) || 0)
const formatDate = (value) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-')
const formatDuration = (value) => `${(Number(value || 0) / 1000).toFixed(2)}s`
const formatPercent = (value) => `${Number(value || 0).toFixed(2)}%`
const formatCost = (value) => {
  const amount = Number(value || 0)
  if (amount >= 1) return `$${amount.toFixed(2)}`
  if (amount >= 0.001) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(6)}`
}
const statusClass = (status) =>
  Number(status) >= 400 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600'

const fetchDetail = async () => {
  if (!props.show || !props.requestId) return
  const target = props.requestId
  loading.value = true
  detail.value = null
  const response = await getV2RequestDetailApi(target)
  if (props.show && props.requestId === target) {
    if (response?.success === false) {
      showToast(response.message || '加载请求详情失败', 'error')
    } else {
      detail.value = response?.data?.record || null
    }
    loading.value = false
  }
}

watch(() => [props.show, props.requestId], fetchDetail, { immediate: true })
</script>

<style scoped>
.v2-request-detail-modal :deep(.el-dialog) {
  width: min(820px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  border-radius: 22px;
  overflow: hidden;
}
.v2-request-detail-modal :deep(.el-dialog__body) {
  max-height: 76vh;
  overflow-y: auto;
  padding: 12px 20px 22px;
}
.modal-close {
  width: 38px;
  height: 38px;
  border-radius: 9999px;
  color: rgb(100 116 139);
}
.modal-close:hover {
  background: rgb(241 245 249);
}
.metric-card,
.detail-panel {
  border: 1px solid rgba(148, 163, 184, 0.24);
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.98), rgba(240, 249, 255, 0.75));
  border-radius: 16px;
}
.dark .metric-card,
.dark .detail-panel {
  background: linear-gradient(145deg, rgba(15, 23, 42, 0.92), rgba(17, 24, 39, 0.88));
}
.metric-card {
  padding: 14px;
}
.metric-card span,
.field-label {
  display: block;
  color: rgb(100 116 139);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.metric-card strong {
  display: block;
  margin-top: 5px;
  font-size: 18px;
}
.detail-panel {
  padding: 16px;
}
.detail-panel h4 {
  margin-bottom: 14px;
  font-weight: 700;
}
.detail-panel p {
  margin-top: 4px;
  font-weight: 600;
  color: rgb(30 41 59);
}
.dark .detail-panel p {
  color: rgb(226 232 240);
}
.detail-panel small {
  color: rgb(100 116 139);
}
.detail-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 14px;
}
.total-row {
  border-top: 1px dashed rgba(148, 163, 184, 0.35);
  padding-top: 9px;
}
.empty-state {
  padding: 36px;
  text-align: center;
  color: rgb(100 116 139);
}
</style>
