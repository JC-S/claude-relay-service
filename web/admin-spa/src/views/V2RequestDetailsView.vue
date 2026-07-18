<template>
  <div class="request-details-container">
    <div class="card p-4 sm:p-6">
      <div class="mb-4 flex flex-col gap-4 sm:mb-6">
        <div>
          <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100 sm:text-xl">请求明细</h3>
          <p class="mt-1 text-sm text-gray-600 dark:text-gray-400 sm:text-base">
            只读查看当前账号名下子 API 的请求、Token 与倍率后费用。
          </p>
        </div>

        <RequestDetailsSummary :summary="summary" />
        <RequestDetailsToolbar
          api-key-placeholder="所有子 API"
          :api-keys="available.apiKeys"
          :endpoints="available.endpoints"
          :exporting="exporting"
          :filters="filters"
          keyword-placeholder="搜索 Request ID / API Key / 模型 / 接口"
          :loading="loading"
          :models="available.models"
          @export="exportCsv"
          @refresh="refreshRecords"
          @reset="resetFilters"
          @update-filter="updateFilter"
        />
      </div>

      <RequestDetailsRecords
        empty-hint="这里只显示当前账号子 API 在保留期内的记录。"
        :loading="loading"
        :pagination="pagination"
        :records="records"
        @open-detail="openDetail"
        @page-change="changePage"
        @size-change="changePageSize"
      />

      <V2RequestDetailModal
        :request-id="activeRequestId"
        :show="detailVisible"
        @close="closeDetail"
      />
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, reactive, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { debounce } from 'lodash-es'
import RequestDetailsRecords from '@/components/request-details/RequestDetailsRecords.vue'
import RequestDetailsSummary from '@/components/request-details/RequestDetailsSummary.vue'
import RequestDetailsToolbar from '@/components/request-details/RequestDetailsToolbar.vue'
import V2RequestDetailModal from '@/components/v2/V2RequestDetailModal.vue'
import { getV2RequestDetailsApi } from '@/utils/http_apis'
import {
  formatRequestDetailDate,
  formatRequestDetailDurationValue
} from '@/utils/requestDetailFormatters.mjs'
import { showToast } from '@/utils/tools'
import {
  buildV2RequestDetailsCsv,
  collectV2RequestDetailPages
} from '@/utils/v2RequestDetailsCsv.mjs'

let fetchVersion = 0
let suppressDateWatch = false
const loading = ref(false)
const exporting = ref(false)
const activeSnapshotId = ref(null)
const records = ref([])
const detailVisible = ref(false)
const activeRequestId = ref('')
const pagination = reactive({ currentPage: 1, pageSize: 50, totalRecords: 0 })
const summary = reactive({
  totalRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  totalCost: 0,
  avgDurationMs: 0,
  cacheHitRate: 0,
  cacheHitNumerator: 0,
  cacheHitDenominator: 0
})
const available = reactive({ apiKeys: [], models: [], endpoints: [] })
const filters = reactive({
  dateRange: null,
  keyword: '',
  apiKeyId: '',
  model: '',
  endpoint: '',
  sortOrder: 'desc'
})

const buildParams = (page, snapshotId = activeSnapshotId.value, pageSize = pagination.pageSize) => {
  const params = { page, pageSize, sortOrder: filters.sortOrder }
  if (filters.keyword) params.keyword = filters.keyword
  if (filters.apiKeyId) params.apiKeyId = filters.apiKeyId
  if (filters.model) params.model = filters.model
  if (filters.endpoint) params.endpoint = filters.endpoint
  if (filters.dateRange?.length === 2) {
    params.startDate = dayjs(filters.dateRange[0]).toISOString()
    params.endDate = dayjs(filters.dateRange[1]).toISOString()
  }
  if (snapshotId) params.snapshotId = snapshotId
  return params
}

const syncData = (data = {}) => {
  activeSnapshotId.value = data.snapshotId || null
  records.value = data.records || []
  Object.assign(pagination, {
    currentPage: data.pagination?.currentPage || 1,
    pageSize: data.pagination?.pageSize || pagination.pageSize,
    totalRecords: data.pagination?.totalRecords || 0
  })
  Object.assign(summary, data.summary || {})
  available.apiKeys = data.availableFilters?.apiKeys || []
  available.models = data.availableFilters?.models || []
  available.endpoints = data.availableFilters?.endpoints || []
}

const fetchRecords = async (page = pagination.currentPage) => {
  debouncedFetch.cancel()
  const version = ++fetchVersion
  loading.value = true
  try {
    const response = await getV2RequestDetailsApi(buildParams(page))
    if (version !== fetchVersion) return
    if (response?.success === false) {
      showToast(
        response.code === 'V2_REQUEST_DETAILS_BUSY'
          ? '请求明细查询繁忙，请稍后重试'
          : response.message || '加载请求明细失败',
        'error'
      )
      return
    }
    syncData(response.data)
  } catch (error) {
    if (version === fetchVersion)
      showToast(`加载请求明细失败：${error.message || '未知错误'}`, 'error')
  } finally {
    if (version === fetchVersion) loading.value = false
  }
}

const invalidateSnapshot = () => {
  activeSnapshotId.value = null
}
const refreshRecords = () => {
  invalidateSnapshot()
  fetchRecords(pagination.currentPage)
}
const changePage = (page) => {
  pagination.currentPage = page
  fetchRecords(page)
}
const changePageSize = (size) => {
  pagination.pageSize = size
  pagination.currentPage = 1
  invalidateSnapshot()
  fetchRecords(1)
}
const updateFilter = ({ field, value }) => {
  filters[field] = value
}
const resetFilters = () => {
  suppressDateWatch = true
  Object.assign(filters, {
    dateRange: null,
    keyword: '',
    apiKeyId: '',
    model: '',
    endpoint: '',
    sortOrder: 'desc'
  })
  pagination.currentPage = 1
  invalidateSnapshot()
  fetchRecords(1)
  nextTick(() => {
    suppressDateWatch = false
    debouncedFetch.cancel()
  })
}

const downloadCsv = (csv, filename) => {
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

const exportCsv = async () => {
  if (exporting.value) return
  exporting.value = true
  try {
    const result = await collectV2RequestDetailPages({
      initialSnapshotId: activeSnapshotId.value,
      fetchPage: ({ page, pageSize, snapshotId }) =>
        getV2RequestDetailsApi(buildParams(page, snapshotId, pageSize))
    })
    if (result.records.length === 0)
      return showToast(result.complete ? '没有可导出的记录' : '导出中断，未取得可用记录', 'info')
    let filename = 'request-details.csv'
    if (!result.complete) {
      const messages = {
        no_snapshot: '无法建立一致性快照，请缩小筛选范围或稍后重试。',
        busy: '查询持续繁忙，导出已中断。',
        snapshot_changed: '查询快照发生变化，导出已中断。',
        page_limit: '数据超过 100 页导出上限。',
        request_failed: result.message || '请求失败，导出已中断。'
      }
      if (
        !window.confirm(
          `${messages[result.reason] || '导出未完整完成'}\n\n是否下载已取得的部分记录？`
        )
      )
        return
      filename = 'request-details-partial.csv'
    }
    downloadCsv(
      buildV2RequestDetailsCsv(result.records, {
        formatDate: formatRequestDetailDate,
        formatDuration: formatRequestDetailDurationValue
      }),
      filename
    )
    showToast(
      result.complete ? '导出 CSV 成功' : '已下载部分记录，导出未完整完成',
      result.complete ? 'success' : 'warning'
    )
  } catch (error) {
    showToast(`导出失败：${error.message || '未知错误'}`, 'error')
  } finally {
    exporting.value = false
  }
}

const openDetail = (requestId) => {
  activeRequestId.value = requestId
  detailVisible.value = true
}
const closeDetail = () => {
  detailVisible.value = false
  activeRequestId.value = ''
}
const debouncedFetch = debounce(() => {
  pagination.currentPage = 1
  invalidateSnapshot()
  fetchRecords(1)
}, 300)
watch(() => filters.keyword, debouncedFetch)
watch(() => [filters.apiKeyId, filters.model, filters.endpoint, filters.sortOrder], debouncedFetch)
watch(
  () => filters.dateRange,
  () => {
    if (!suppressDateWatch) debouncedFetch()
  }
)
onMounted(() => fetchRecords(1))
</script>

<style scoped>
.request-details-container {
  min-height: calc(100vh - 300px);
}
</style>
