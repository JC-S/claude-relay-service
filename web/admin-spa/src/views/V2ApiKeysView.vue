<template>
  <div>
    <!-- 总账卡片 -->
    <div
      class="glass-strong mb-4 rounded-2xl border border-gray-200/50 p-4 dark:border-gray-700/50 sm:mb-6 sm:p-6"
    >
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-xs text-gray-500 dark:text-gray-400">当前账号</p>
          <p class="text-lg font-bold text-gray-900 dark:text-gray-100">
            {{ account.v2Email || '—' }}
          </p>
        </div>
        <div class="grid grid-cols-3 gap-4 text-center">
          <div>
            <p class="text-xs text-gray-500 dark:text-gray-400">总额度</p>
            <p class="text-base font-semibold text-gray-900 dark:text-gray-100">
              {{ account.unlimited ? '不限额' : fmtCost(account.v2TotalBudget) }}
            </p>
          </div>
          <div>
            <p class="text-xs text-gray-500 dark:text-gray-400">已用</p>
            <p class="text-base font-semibold text-blue-600 dark:text-blue-400">
              {{ fmtCost(account.used) }}
            </p>
          </div>
          <div>
            <p class="text-xs text-gray-500 dark:text-gray-400">剩余</p>
            <p class="text-base font-semibold text-green-600 dark:text-green-400">
              {{ account.unlimited ? '不限额' : fmtCost(account.remaining) }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 操作栏 -->
    <div class="mb-4 flex items-center justify-between">
      <h2 class="text-lg font-bold text-gray-900 dark:text-gray-100">我的 API Keys</h2>
      <button class="btn btn-primary px-4 py-2 text-sm font-semibold" @click="openCreateModal">
        <i class="fas fa-plus mr-2" />新建 API Key
      </button>
    </div>

    <!-- 列表 -->
    <div v-if="loading" class="py-12 text-center text-gray-500 dark:text-gray-400">
      <div class="loading-spinner mx-auto mb-3" />
      加载中...
    </div>
    <div v-else-if="keys.length === 0" class="py-12 text-center text-gray-500 dark:text-gray-400">
      <i class="fas fa-key mb-3 text-3xl opacity-40" />
      <p>还没有 API Key，点击右上角新建</p>
    </div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead>
          <tr
            class="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
          >
            <th class="px-3 py-2">名称</th>
            <th class="px-3 py-2">Key</th>
            <th class="px-3 py-2">状态</th>
            <th class="px-3 py-2">今日费用</th>
            <th class="px-3 py-2">总费用</th>
            <th class="px-3 py-2">最后使用</th>
            <th class="px-3 py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="key in keys"
            :key="key.id"
            class="border-b border-gray-100 text-gray-700 dark:border-gray-800 dark:text-gray-200"
          >
            <td class="px-3 py-3">
              <div class="font-semibold">{{ key.name }}</div>
              <div v-if="key.description" class="text-xs text-gray-400">
                {{ key.description }}
              </div>
            </td>
            <td class="px-3 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
              {{ key.maskedKey || '—' }}
            </td>
            <td class="px-3 py-3">
              <span
                :class="[
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  key.isActive
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                ]"
              >
                {{ key.isActive ? '启用' : '禁用' }}
              </span>
            </td>
            <td class="px-3 py-3">
              {{ fmtCost(key.dailyCost) }}
              <span v-if="key.dailyCostLimit > 0" class="text-xs text-gray-400">
                / {{ fmtCost(key.dailyCostLimit) }}
              </span>
            </td>
            <td class="px-3 py-3">
              {{ fmtCost(key.totalCost) }}
              <span v-if="key.totalCostLimit > 0" class="text-xs text-gray-400">
                / {{ fmtCost(key.totalCostLimit) }}
              </span>
            </td>
            <td class="px-3 py-3 text-xs text-gray-500 dark:text-gray-400">
              {{ key.lastUsedAt ? formatDate(key.lastUsedAt) : '从未使用' }}
            </td>
            <td class="px-3 py-3">
              <div class="flex items-center justify-end gap-2">
                <button
                  class="text-blue-500 hover:text-blue-700"
                  title="编辑"
                  @click="openEditModal(key)"
                >
                  <i class="fas fa-edit" />
                </button>
                <button
                  :class="key.isActive ? 'text-orange-500' : 'text-green-500'"
                  :title="key.isActive ? '禁用' : '启用'"
                  @click="toggleKey(key)"
                >
                  <i :class="key.isActive ? 'fas fa-ban' : 'fas fa-check-circle'" />
                </button>
                <button
                  class="text-red-500 hover:text-red-700"
                  title="删除"
                  @click="removeKey(key)"
                >
                  <i class="fas fa-trash" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 创建/编辑弹窗 -->
    <div
      v-if="showFormModal"
      class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
    >
      <div class="modal-content mx-auto w-full max-w-md p-4 sm:p-6">
        <div class="mb-6 flex items-center justify-between">
          <h3 class="text-xl font-bold text-gray-900 dark:text-gray-100">
            {{ editingId ? '编辑 API Key' : '新建 API Key' }}
          </h3>
          <button
            class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            @click="showFormModal = false"
          >
            <i class="fas fa-times text-xl" />
          </button>
        </div>
        <form class="space-y-4" @submit.prevent="submitForm">
          <div>
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >名称 *</label
            >
            <input
              v-model="form.name"
              class="form-input w-full"
              placeholder="API Key 名称"
              required
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >描述</label
            >
            <input v-model="form.description" class="form-input w-full" placeholder="可选描述" />
          </div>
          <div>
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >每日费用限额（美元，0 表示不限）</label
            >
            <input
              v-model.number="form.dailyCostLimit"
              class="form-input w-full"
              min="0"
              step="0.01"
              type="number"
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >总费用限额（美元，0 表示不限）</label
            >
            <input
              v-model.number="form.totalCostLimit"
              class="form-input w-full"
              min="0"
              step="0.01"
              type="number"
            />
          </div>
          <div v-if="editingId" class="flex items-center gap-2">
            <input id="v2-key-active" v-model="form.isActive" type="checkbox" />
            <label class="text-sm text-gray-700 dark:text-gray-300" for="v2-key-active">启用</label>
          </div>
          <div class="flex gap-3 pt-2">
            <button
              class="flex-1 rounded-xl bg-gray-100 px-4 py-2.5 font-semibold text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              type="button"
              @click="showFormModal = false"
            >
              取消
            </button>
            <button
              class="btn btn-primary flex-1 px-4 py-2.5 font-semibold"
              :disabled="formLoading"
              type="submit"
            >
              <div v-if="formLoading" class="loading-spinner mr-2" />
              {{ editingId ? '保存' : '创建' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 新建成功展示完整 key（仅此一次） -->
    <div
      v-if="showSecretModal"
      class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
    >
      <div class="modal-content mx-auto w-full max-w-md p-4 sm:p-6">
        <div class="mb-4 flex items-center gap-3">
          <div
            class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-green-500 to-green-600"
          >
            <i class="fas fa-check text-white" />
          </div>
          <h3 class="text-xl font-bold text-gray-900 dark:text-gray-100">API Key 创建成功</h3>
        </div>
        <p class="mb-3 text-sm text-gray-500 dark:text-gray-400">
          请立即复制并妥善保存，此密钥只显示这一次。
        </p>
        <div class="mb-4 flex items-center gap-2 rounded-lg bg-gray-100 p-3 dark:bg-gray-700">
          <code class="flex-1 break-all font-mono text-xs text-gray-800 dark:text-gray-200">{{
            newSecret
          }}</code>
          <button class="text-blue-500 hover:text-blue-700" @click="copySecret">
            <i class="fas fa-copy" />
          </button>
        </div>
        <button
          class="btn btn-primary w-full px-4 py-2.5 font-semibold"
          @click="showSecretModal = false"
        >
          我已保存
        </button>
      </div>
    </div>

    <ConfirmModal
      :cancel-text="confirmConfig.cancelText"
      :confirm-text="confirmConfig.confirmText"
      :message="confirmConfig.message"
      :show="showConfirmModal"
      :title="confirmConfig.title"
      :type="confirmConfig.type"
      @cancel="handleCancelConfirm"
      @confirm="handleConfirmConfirm"
    />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { showToast, copyText, formatDate } from '@/utils/tools'
import {
  getV2AccountApi,
  getV2ApiKeysApi,
  createV2ApiKeyApi,
  updateV2ApiKeyApi,
  deleteV2ApiKeyApi
} from '@/utils/http_apis'
import ConfirmModal from '@/components/common/ConfirmModal.vue'

const loading = ref(true)
const account = ref({ v2Email: '', v2TotalBudget: 0, used: 0, remaining: 0, unlimited: true })
const keys = ref([])

const showFormModal = ref(false)
const formLoading = ref(false)
const editingId = ref(null)
const form = reactive({
  name: '',
  description: '',
  dailyCostLimit: 0,
  totalCostLimit: 0,
  isActive: true
})

const showSecretModal = ref(false)
const newSecret = ref('')

// ConfirmModal
const showConfirmModal = ref(false)
const confirmConfig = ref({
  title: '',
  message: '',
  type: 'primary',
  confirmText: '确认',
  cancelText: '取消'
})
const confirmResolve = ref(null)
const showConfirm = (title, message, confirmText = '确认', cancelText = '取消', type = 'primary') =>
  new Promise((resolve) => {
    confirmConfig.value = { title, message, confirmText, cancelText, type }
    confirmResolve.value = resolve
    showConfirmModal.value = true
  })
const handleConfirmConfirm = () => {
  showConfirmModal.value = false
  confirmResolve.value?.(true)
}
const handleCancelConfirm = () => {
  showConfirmModal.value = false
  confirmResolve.value?.(false)
}

const fmtCost = (n) => `$${Number(n || 0).toFixed(4)}`

const loadAccount = async () => {
  try {
    const res = await getV2AccountApi()
    if (res.success && res.data) {
      account.value = res.data
    }
  } catch (error) {
    showToast('加载账号信息失败', 'error')
  }
}

const loadKeys = async () => {
  loading.value = true
  try {
    const res = await getV2ApiKeysApi()
    keys.value = res.success && Array.isArray(res.data) ? res.data : []
  } catch (error) {
    showToast('加载 API Key 列表失败', 'error')
  } finally {
    loading.value = false
  }
}

const refresh = async () => {
  await Promise.all([loadAccount(), loadKeys()])
}

const openCreateModal = () => {
  editingId.value = null
  form.name = ''
  form.description = ''
  form.dailyCostLimit = 0
  form.totalCostLimit = 0
  form.isActive = true
  showFormModal.value = true
}

const openEditModal = (key) => {
  editingId.value = key.id
  form.name = key.name || ''
  form.description = key.description || ''
  form.dailyCostLimit = key.dailyCostLimit || 0
  form.totalCostLimit = key.totalCostLimit || 0
  form.isActive = key.isActive !== false
  showFormModal.value = true
}

const submitForm = async () => {
  if (!form.name || !form.name.trim()) {
    showToast('请填写名称', 'error')
    return
  }
  formLoading.value = true
  try {
    if (editingId.value) {
      const res = await updateV2ApiKeyApi(editingId.value, {
        name: form.name.trim(),
        description: form.description?.trim() || '',
        dailyCostLimit: form.dailyCostLimit || 0,
        totalCostLimit: form.totalCostLimit || 0,
        isActive: form.isActive
      })
      if (res.success) {
        showToast('保存成功', 'success')
        showFormModal.value = false
        await refresh()
      } else {
        showToast(res.message || '保存失败', 'error')
      }
    } else {
      const res = await createV2ApiKeyApi({
        name: form.name.trim(),
        description: form.description?.trim() || '',
        dailyCostLimit: form.dailyCostLimit || 0,
        totalCostLimit: form.totalCostLimit || 0
      })
      if (res.success && res.data) {
        showFormModal.value = false
        newSecret.value = res.data.apiKey
        showSecretModal.value = true
        await refresh()
      } else {
        showToast(res.message || '创建失败', 'error')
      }
    }
  } catch (error) {
    showToast(error.message || '操作失败', 'error')
  } finally {
    formLoading.value = false
  }
}

const toggleKey = async (key) => {
  try {
    const res = await updateV2ApiKeyApi(key.id, { isActive: !key.isActive })
    if (res.success) {
      showToast(`已${key.isActive ? '禁用' : '启用'}`, 'success')
      await refresh()
    } else {
      showToast(res.message || '操作失败', 'error')
    }
  } catch (error) {
    showToast('操作失败', 'error')
  }
}

const removeKey = async (key) => {
  const confirmed = await showConfirm(
    '删除 API Key',
    `确定要删除 "${key.name}" 吗？删除后该 Key 将无法继续使用。`,
    '确定删除',
    '取消',
    'danger'
  )
  if (!confirmed) {
    return
  }
  try {
    const res = await deleteV2ApiKeyApi(key.id)
    if (res.success) {
      showToast('已删除', 'success')
      await refresh()
    } else {
      showToast(res.message || '删除失败', 'error')
    }
  } catch (error) {
    showToast('删除失败', 'error')
  }
}

const copySecret = async () => {
  await copyText(newSecret.value)
  showToast('已复制', 'success')
}

onMounted(refresh)
</script>
