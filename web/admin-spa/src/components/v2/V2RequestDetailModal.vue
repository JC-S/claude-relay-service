<template>
  <RequestDetailModalShell
    :detail="detail"
    :loading="loading"
    :request-id="requestId"
    :show="show"
    @close="$emit('close')"
  />
</template>

<script setup>
import { ref, watch } from 'vue'
import RequestDetailModalShell from '@/components/request-details/RequestDetailModalShell.vue'
import { getV2RequestDetailApi } from '@/utils/http_apis'
import { showToast } from '@/utils/tools'

const props = defineProps({
  show: { type: Boolean, default: false },
  requestId: { type: String, default: '' }
})
defineEmits(['close'])

const loading = ref(false)
const detail = ref(null)

const fetchDetail = async () => {
  if (!props.show || !props.requestId) return
  const target = props.requestId
  loading.value = true
  detail.value = null
  try {
    const response = await getV2RequestDetailApi(target)
    if (!props.show || props.requestId !== target) return
    if (response?.success === false) {
      showToast(response.message || '加载请求详情失败', 'error')
      return
    }
    detail.value = response?.data?.record || null
  } catch (error) {
    if (!props.show || props.requestId !== target) return
    showToast(`加载请求详情失败：${error.message || '未知错误'}`, 'error')
  } finally {
    if (props.requestId === target) loading.value = false
  }
}

watch(
  () => [props.show, props.requestId],
  () => {
    if (!props.show) {
      detail.value = null
      loading.value = false
      return
    }
    fetchDetail()
  },
  { immediate: true }
)
</script>
