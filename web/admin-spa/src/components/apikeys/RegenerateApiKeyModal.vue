<template>
  <Teleport to="body">
    <div
      class="modal fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4"
      @click.self="handleClose"
    >
      <div class="modal-content mx-auto w-full max-w-lg p-5 sm:p-6">
        <div class="mb-5 flex items-start justify-between gap-4">
          <div class="flex items-center gap-3">
            <div
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600"
            >
              <i class="fas fa-arrows-rotate text-white" />
            </div>
            <div>
              <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">重新生成 API Key</h3>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {{ apiKey?.name || '当前 API Key' }}
              </p>
            </div>
          </div>
          <button
            class="p-1 text-gray-400 transition-colors hover:text-gray-600 disabled:opacity-50 dark:hover:text-gray-300"
            :disabled="submitting"
            type="button"
            @click="handleClose"
          >
            <i class="fas fa-times text-lg" />
          </button>
        </div>

        <template v-if="!resultApiKey">
          <div
            class="mb-5 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
          >
            <i class="fas fa-triangle-exclamation mr-1.5" />
            确认后旧 Key 将立即失效，使用旧 Key 的客户端需要更新配置。历史用量和计费不会清除。
          </div>

          <div class="space-y-3">
            <label
              class="flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors"
              :class="
                mode === 'system'
                  ? 'border-blue-400 bg-blue-50/70 dark:border-blue-500 dark:bg-blue-950/20'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
              "
            >
              <input
                v-model="mode"
                class="mt-1"
                :disabled="submitting"
                type="radio"
                value="system"
              />
              <span>
                <span class="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                  系统生成（推荐）
                </span>
                <span class="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  按当前规则生成带系统前缀的随机 Key。
                </span>
              </span>
            </label>

            <label
              class="flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors"
              :class="
                mode === 'custom'
                  ? 'border-blue-400 bg-blue-50/70 dark:border-blue-500 dark:bg-blue-950/20'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
              "
            >
              <input
                v-model="mode"
                class="mt-1"
                :disabled="submitting"
                type="radio"
                value="custom"
              />
              <span>
                <span class="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                  自定义 Key
                </span>
                <span class="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  可使用任意可打印 ASCII 字符，最长 512 个字符。
                </span>
              </span>
            </label>
          </div>

          <div v-if="mode === 'custom'" class="mt-4">
            <div class="relative">
              <input
                v-model="customApiKey"
                autocomplete="new-password"
                class="form-input w-full pr-11 font-mono text-sm"
                :disabled="submitting"
                maxlength="512"
                placeholder="输入新的 API Key"
                :type="showCustomApiKey ? 'text' : 'password'"
              />
              <button
                class="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                :disabled="submitting"
                type="button"
                @click="showCustomApiKey = !showCustomApiKey"
              >
                <i :class="showCustomApiKey ? 'fas fa-eye-slash' : 'fas fa-eye'" />
              </button>
            </div>
            <div class="mt-1.5 flex items-start justify-between gap-3 text-xs">
              <span :class="customValidationError ? 'text-red-500' : 'text-gray-400'">
                {{ customValidationError || shortKeyWarning }}
              </span>
              <span class="shrink-0 text-gray-400">{{ customApiKey.length }} / 512</span>
            </div>
          </div>

          <p v-if="submitError" class="mt-4 text-sm text-red-600 dark:text-red-400">
            {{ submitError }}
          </p>

          <div class="mt-6 flex gap-3">
            <button
              class="flex-1 rounded-xl bg-gray-100 px-4 py-2.5 font-semibold text-gray-700 transition hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              :disabled="submitting"
              type="button"
              @click="handleClose"
            >
              取消
            </button>
            <button
              class="btn btn-primary flex-1 px-4 py-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="!canSubmit"
              type="button"
              @click="submit"
            >
              <i v-if="submitting" class="fas fa-spinner fa-spin mr-2" />
              {{ submitting ? '处理中...' : '确认重新生成' }}
            </button>
          </div>
        </template>

        <template v-else>
          <div
            class="mb-4 rounded-xl border border-green-200 bg-green-50/80 p-3 text-sm text-green-800 dark:border-green-700/60 dark:bg-green-950/30 dark:text-green-200"
          >
            <i class="fas fa-check-circle mr-1.5" />
            新 API Key 已生效，旧 Key 已失效。
          </div>
          <div
            class="rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/60"
          >
            <div class="mb-2 flex items-center justify-between">
              <span class="text-xs font-semibold text-gray-700 dark:text-gray-300">新 API Key</span>
              <div class="flex items-center gap-1">
                <button
                  class="rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                  type="button"
                  @click="showResultApiKey = !showResultApiKey"
                >
                  <i :class="showResultApiKey ? 'fas fa-eye-slash mr-1' : 'fas fa-eye mr-1'" />
                  {{ showResultApiKey ? '隐藏' : '显示' }}
                </button>
                <button
                  class="rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-900/30"
                  type="button"
                  @click="copyResult"
                >
                  <i class="fas fa-copy mr-1" />复制
                </button>
              </div>
            </div>
            <code
              class="block break-all rounded-lg bg-white p-3 font-mono text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100"
            >
              {{ showResultApiKey ? resultApiKey : maskedResultApiKey }}
            </code>
          </div>
          <button
            class="btn btn-primary mt-5 w-full px-4 py-2.5 font-semibold"
            @click="handleClose"
          >
            完成
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, ref } from 'vue'
import { copyText, showToast } from '@/utils/tools'
import { regenerateApiKeySecretApi, regenerateV2ApiKeySecretApi } from '@/utils/http_apis'

const props = defineProps({
  apiKey: { type: Object, required: true },
  scope: { type: String, default: 'admin' }
})

const emit = defineEmits(['close', 'regenerated'])

const mode = ref('system')
const customApiKey = ref('')
const showCustomApiKey = ref(false)
const submitting = ref(false)
const submitError = ref('')
const resultApiKey = ref('')
const showResultApiKey = ref(false)

const customValidationError = computed(() => {
  const value = customApiKey.value
  if (!value) return '请输入自定义 Key。'
  if (value.length > 512) return 'Key 不能超过 512 个字符。'
  if (!/^[\x20-\x7E]+$/.test(value)) return '仅支持可打印 ASCII 字符。'
  if (value.trim() !== value) return 'Key 首尾不能包含空白字符。'
  if (/^Bearer\s/i.test(value)) return 'Key 不能以 Bearer 开头。'
  return ''
})

const shortKeyWarning = computed(() =>
  customApiKey.value.length > 0 && customApiKey.value.length < 16
    ? 'Key 较短，存在被猜测风险。'
    : ''
)

const canSubmit = computed(
  () =>
    !submitting.value &&
    (mode.value === 'system' || (mode.value === 'custom' && customValidationError.value === ''))
)

const maskedResultApiKey = computed(() => {
  if (!resultApiKey.value) return ''
  return '•'.repeat(Math.min(Math.max(resultApiKey.value.length, 8), 24))
})

const clearPlaintext = () => {
  customApiKey.value = ''
  resultApiKey.value = ''
  showCustomApiKey.value = false
  showResultApiKey.value = false
}

const handleClose = () => {
  if (submitting.value) return
  clearPlaintext()
  emit('close')
}

const submit = async () => {
  if (!canSubmit.value) return
  submitting.value = true
  submitError.value = ''
  const payload =
    mode.value === 'custom' ? { mode: 'custom', apiKey: customApiKey.value } : { mode: 'system' }
  try {
    const request = props.scope === 'v2' ? regenerateV2ApiKeySecretApi : regenerateApiKeySecretApi
    const response = await request(props.apiKey.id, payload)
    if (!response.success || !response.data?.apiKey) {
      submitError.value = response.message || '重新生成失败，请稍后重试。'
      return
    }
    resultApiKey.value = response.data.apiKey
    showResultApiKey.value = false
    customApiKey.value = ''
    emit('regenerated', {
      id: response.data.id,
      updatedAt: response.data.updatedAt,
      generationMode: response.data.generationMode
    })
  } catch (error) {
    submitError.value = error?.message || '重新生成失败，请稍后重试。'
  } finally {
    submitting.value = false
  }
}

const copyResult = async () => {
  await copyText(resultApiKey.value)
  showToast('已复制', 'success')
}
</script>
