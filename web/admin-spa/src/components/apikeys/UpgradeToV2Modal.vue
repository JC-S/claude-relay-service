<template>
  <div class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
    <div class="modal-content mx-auto w-full max-w-md p-4 sm:p-6">
      <div class="mb-6 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div
            class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-purple-600"
          >
            <i class="fas fa-arrow-up text-white" />
          </div>
          <h3 class="text-xl font-bold text-gray-900 dark:text-gray-100">升级为 v2 账号</h3>
        </div>
        <button
          class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          @click="$emit('close')"
        >
          <i class="fas fa-times text-xl" />
        </button>
      </div>

      <div
        class="mb-4 rounded-lg border border-amber-300/50 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-400"
      >
        <i class="fas fa-exclamation-triangle mr-2" />
        升级为单向操作。升级后 API Key「{{ apiKey?.name }}」的原密钥将<strong
          >立即不可用于 API 调用</strong
        >，请改用其子 key。
      </div>

      <form class="space-y-4" @submit.prevent="submit">
        <div>
          <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >登录邮箱 *</label
          >
          <input
            v-model="form.email"
            class="form-input w-full"
            placeholder="v2 账号登录邮箱"
            required
            type="email"
          />
        </div>
        <div>
          <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >登录密码 *</label
          >
          <input
            v-model="form.password"
            class="form-input w-full"
            placeholder="至少 8 位"
            required
            type="password"
          />
        </div>
        <div>
          <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >确认密码 *</label
          >
          <input
            v-model="form.confirmPassword"
            class="form-input w-full"
            placeholder="再次输入密码"
            required
            type="password"
          />
        </div>
        <div>
          <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >总账额度（美元，0 表示不限额）</label
          >
          <input
            v-model.number="form.totalBudget"
            class="form-input w-full"
            min="0"
            step="0.01"
            type="number"
          />
        </div>
        <div class="flex gap-3 pt-2">
          <button
            class="flex-1 rounded-xl bg-gray-100 px-4 py-2.5 font-semibold text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            type="button"
            @click="$emit('close')"
          >
            取消
          </button>
          <button
            class="btn btn-primary flex-1 px-4 py-2.5 font-semibold"
            :disabled="loading"
            type="submit"
          >
            <div v-if="loading" class="loading-spinner mr-2" />
            确认升级
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { showToast } from '@/utils/tools'
import { upgradeApiKeyToV2Api } from '@/utils/http_apis'

const props = defineProps({
  apiKey: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['close', 'success'])

const loading = ref(false)
const form = reactive({ email: '', password: '', confirmPassword: '', totalBudget: 0 })

const submit = async () => {
  if (form.password !== form.confirmPassword) {
    showToast('两次输入的密码不一致', 'error')
    return
  }
  if (form.password.length < 8) {
    showToast('密码长度至少 8 位', 'error')
    return
  }
  loading.value = true
  try {
    const res = await upgradeApiKeyToV2Api(props.apiKey.id, {
      email: form.email.trim(),
      password: form.password,
      totalBudget: form.totalBudget || 0
    })
    if (res.success) {
      showToast('升级成功', 'success')
      emit('success')
      emit('close')
    } else {
      showToast(res.message || '升级失败', 'error')
    }
  } catch (error) {
    showToast(error.message || '升级失败', 'error')
  } finally {
    loading.value = false
  }
}
</script>
