<template>
  <div class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
    <div class="modal-content mx-auto w-full max-w-md p-4 sm:p-6">
      <div class="mb-6 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div
            class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600"
          >
            <i class="fas fa-user-cog text-white" />
          </div>
          <h3 class="text-xl font-bold text-gray-900 dark:text-gray-100">v2 账号管理</h3>
        </div>
        <button
          class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          @click="$emit('close')"
        >
          <i class="fas fa-times text-xl" />
        </button>
      </div>

      <form class="space-y-4" @submit.prevent="submit">
        <div>
          <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >登录邮箱</label
          >
          <input v-model="form.newEmail" class="form-input w-full" type="email" />
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
        <div>
          <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
            >重置密码（留空表示不修改）</label
          >
          <input
            v-model="form.newPassword"
            class="form-input w-full"
            placeholder="至少 8 位"
            type="password"
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
            保存
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { showToast } from '@/utils/tools'
import { updateV2ConfigApi } from '@/utils/http_apis'

const props = defineProps({
  apiKey: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['close', 'success'])

const loading = ref(false)
const form = reactive({
  newEmail: props.apiKey?.v2Email || '',
  totalBudget: props.apiKey?.v2TotalBudget || 0,
  newPassword: ''
})

const submit = async () => {
  if (form.newPassword && form.newPassword.length < 8) {
    showToast('密码长度至少 8 位', 'error')
    return
  }
  const payload = { totalBudget: form.totalBudget || 0 }
  if (form.newEmail && form.newEmail.trim().toLowerCase() !== (props.apiKey?.v2Email || '')) {
    payload.newEmail = form.newEmail.trim()
  }
  if (form.newPassword) {
    payload.newPassword = form.newPassword
  }
  loading.value = true
  try {
    const res = await updateV2ConfigApi(props.apiKey.id, payload)
    if (res.success) {
      showToast('保存成功', 'success')
      emit('success')
      emit('close')
    } else {
      showToast(res.message || '保存失败', 'error')
    }
  } catch (error) {
    showToast(error.message || '保存失败', 'error')
  } finally {
    loading.value = false
  }
}
</script>
