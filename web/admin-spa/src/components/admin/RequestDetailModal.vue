<template>
  <RequestDetailModalShell
    :body-preview-enabled="bodyPreviewEnabled"
    :detail="detail"
    :formatted-snapshot="formattedSnapshot"
    :loading="loading"
    mode="admin"
    :request-id="requestId"
    :show="show"
    @close="$emit('close')"
    @copy-snapshot="copySnapshot"
  />
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import RequestDetailModalShell from '@/components/request-details/RequestDetailModalShell.vue'
import { getRequestDetailApi } from '@/utils/http_apis'
import { showToast } from '@/utils/tools'

const props = defineProps({
  show: { type: Boolean, default: false },
  requestId: { type: String, default: '' }
})
defineEmits(['close'])

const loading = ref(false)
const detail = ref(null)
const bodyPreviewEnabled = ref(false)
const previewSuffixPattern = /\.\.\.\[\d+ chars\]$/

const tryFormatJsonString = (value) => {
  if (typeof value !== 'string') return null
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch (error) {
    return null
  }
}

const formatJsonLikeText = (value) => {
  if (typeof value !== 'string') return ''
  const suffix = value.match(previewSuffixPattern)?.[0] || ''
  const source = suffix ? value.slice(0, -suffix.length) : value
  let formatted = ''
  let indent = 0
  let inString = false
  let escaping = false
  const appendIndent = () => {
    formatted += '  '.repeat(Math.max(0, indent))
  }

  for (const char of source) {
    if (escaping) {
      formatted += char
      escaping = false
      continue
    }
    if (char === '\\') {
      formatted += char
      escaping = inString
      continue
    }
    if (char === '"') {
      inString = !inString
      formatted += char
      continue
    }
    if (inString) {
      formatted += char
      continue
    }
    if (char === '{' || char === '[') {
      formatted += `${char}\n`
      indent += 1
      appendIndent()
      continue
    }
    if (char === '}' || char === ']') {
      formatted = formatted.replace(/[ \t]+$/g, '').replace(/\n?$/, '\n')
      indent = Math.max(0, indent - 1)
      appendIndent()
      formatted += char
      continue
    }
    if (char === ',') {
      formatted += ',\n'
      appendIndent()
      continue
    }
    if (char === ':') {
      formatted += ': '
      continue
    }
    formatted += char
  }
  const trimmed = formatted.trim()
  return suffix ? `${trimmed}\n${suffix}` : trimmed
}

const formattedSnapshot = computed(() => {
  const snapshot = detail.value?.requestBodySnapshot
  if (!snapshot) return ''
  const source =
    typeof snapshot === 'object' && !Array.isArray(snapshot) && typeof snapshot.preview === 'string'
      ? snapshot.preview
      : snapshot
  if (typeof source === 'string') return tryFormatJsonString(source) || formatJsonLikeText(source)
  return JSON.stringify(source, null, 2)
})

const fetchDetail = async () => {
  if (!props.show || !props.requestId) return
  const target = props.requestId
  loading.value = true
  detail.value = null
  try {
    const response = await getRequestDetailApi(target)
    if (!props.show || props.requestId !== target) return
    if (response?.success === false) {
      showToast(response.message || '加载请求详情失败', 'error')
      return
    }
    bodyPreviewEnabled.value = response.data?.bodyPreviewEnabled === true
    detail.value = response.data?.record || null
  } catch (error) {
    if (!props.show || props.requestId !== target) return
    bodyPreviewEnabled.value = false
    showToast(`加载请求详情失败：${error.message || '未知错误'}`, 'error')
  } finally {
    if (props.requestId === target) loading.value = false
  }
}

const copySnapshot = async () => {
  if (!formattedSnapshot.value) return showToast('没有可复制的快照', 'info')
  try {
    await navigator.clipboard.writeText(formattedSnapshot.value)
    showToast('已复制请求快照', 'success')
  } catch (error) {
    showToast('复制失败，请手动复制', 'error')
  }
}

watch(
  () => [props.show, props.requestId],
  () => {
    if (!props.show) {
      detail.value = null
      bodyPreviewEnabled.value = false
      loading.value = false
      return
    }
    fetchDetail()
  },
  { immediate: true }
)
</script>
