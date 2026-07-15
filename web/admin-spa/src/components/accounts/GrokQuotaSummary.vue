<template>
  <div class="min-w-[200px] space-y-2">
    <div v-if="billing" class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold text-slate-800 dark:text-slate-100">
          {{ billing.plan || account.subscriptionTier || 'Grok 订阅' }}
        </span>
        <span
          v-if="billing.partial"
          class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
          >部分数据</span
        >
      </div>

      <div v-if="hasPercent(billing.usagePercent)" class="space-y-1">
        <div class="flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
          <span>{{ billing.periodType === 'monthly' ? '当前周期' : '本周' }}</span>
          <span>{{ formatPercent(billing.usagePercent) }} 已用</span>
        </div>
        <div class="h-1.5 rounded-full bg-gray-200 dark:bg-gray-700">
          <div
            class="h-1.5 rounded-full"
            :class="barClass(billing.usagePercent)"
            :style="{ width: `${clampPercent(billing.usagePercent)}%` }"
          />
        </div>
        <div v-if="billing.periodEnd" class="text-[11px] text-gray-400">
          重置 {{ formatDate(billing.periodEnd) }}
        </div>
      </div>

      <div
        v-if="hasPercent(billing.usedPercent)"
        class="flex items-center justify-between rounded-md bg-gray-50 px-2 py-1 text-[11px] dark:bg-gray-800"
      >
        <span class="text-gray-500 dark:text-gray-400">月度</span>
        <span class="font-medium text-gray-700 dark:text-gray-200">
          {{ formatPercent(billing.usedPercent) }} 已用
        </span>
      </div>
    </div>

    <div v-else-if="rateLimit" class="space-y-1.5">
      <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">
        {{ rateLimit.subscriptionTier || account.subscriptionTier || '被动额度' }}
      </div>
      <div
        v-if="rateLimit.requests"
        class="flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400"
      >
        <span>Requests</span>
        <span>{{ formatRemaining(rateLimit.requests) }}</span>
      </div>
      <div
        v-if="rateLimit.tokens"
        class="flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400"
      >
        <span>Tokens</span>
        <span>{{ formatRemaining(rateLimit.tokens) }}</span>
      </div>
    </div>

    <div v-else class="text-xs text-gray-400 dark:text-gray-500">额度未知</div>

    <button
      v-if="account.authType === 'oauth'"
      class="text-[11px] text-cyan-600 hover:underline disabled:opacity-50 dark:text-cyan-300"
      :disabled="loading"
      type="button"
      @click="refresh"
    >
      <i class="fas fa-sync-alt mr-1" :class="{ 'fa-spin': loading }" />刷新上游额度
    </button>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { queryGrokAccountQuotaApi } from '@/utils/http_apis'
import { showToast } from '@/utils/tools'

const props = defineProps({ account: { type: Object, required: true } })
const emit = defineEmits(['refreshed'])

const snapshot = ref({
  billing: props.account.billingSnapshot || null,
  rateLimit: props.account.rateLimitSnapshot || null
})
const loading = ref(false)

watch(
  () => [props.account.billingSnapshot, props.account.rateLimitSnapshot],
  ([billingSnapshot, rateLimitSnapshot]) => {
    snapshot.value = { billing: billingSnapshot || null, rateLimit: rateLimitSnapshot || null }
  }
)

const billing = computed(() => snapshot.value.billing)
const rateLimit = computed(() => snapshot.value.rateLimit)
const hasPercent = (value) => Number.isFinite(Number(value))
const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0))
const formatPercent = (value) => `${clampPercent(value).toFixed(1)}%`
const barClass = (value) => {
  const percent = clampPercent(value)
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 70) return 'bg-amber-500'
  return 'bg-cyan-600'
}
const formatDate = (value) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '未知'
}
const formatRemaining = (window) => {
  const remaining = Number(window?.remaining)
  const limit = Number(window?.limit)
  if (!Number.isFinite(remaining)) return '未知'
  return Number.isFinite(limit)
    ? `${remaining.toLocaleString()} / ${limit.toLocaleString()}`
    : remaining.toLocaleString()
}

const refresh = async () => {
  loading.value = true
  try {
    const response = await queryGrokAccountQuotaApi(props.account.id)
    if (!response.success) {
      showToast(response.message || '刷新 Grok 额度失败', 'error')
      return
    }
    snapshot.value = {
      billing: response.data?.billing || snapshot.value.billing,
      rateLimit: response.data?.rateLimit || snapshot.value.rateLimit
    }
    emit('refreshed', snapshot.value)
    showToast('Grok 额度已刷新', 'success')
  } catch (error) {
    showToast(error.message || '刷新 Grok 额度失败', 'error')
  } finally {
    loading.value = false
  }
}
</script>
