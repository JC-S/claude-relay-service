<template>
  <div class="v2-request-details">
    <section class="page-shell">
      <header class="page-header">
        <div>
          <p class="eyebrow">V2 ACCOUNT LEDGER</p>
          <h1>请求明细</h1>
          <p>只读查看当前账号名下子 API 的请求、Token 与倍率后费用。</p>
        </div>
        <div class="header-actions">
          <button class="action-button" :disabled="loading" @click="refreshRecords">
            <i :class="['fas', loading ? 'fa-spinner fa-spin' : 'fa-sync-alt']" />
            刷新
          </button>
          <button class="action-button primary" :disabled="exporting" @click="exportCsv">
            <i :class="['fas', exporting ? 'fa-spinner fa-spin' : 'fa-file-export']" />
            导出 CSV
          </button>
        </div>
      </header>

      <div class="summary-grid">
        <article class="summary-card">
          <span>总请求</span>
          <strong>{{ fmt(summary.totalRequests) }}</strong>
        </article>
        <article class="summary-card">
          <span>输入 / 输出</span>
          <strong>{{ fmt(summary.inputTokens) }}</strong>
          <small>输出 {{ fmt(summary.outputTokens) }}</small>
        </article>
        <article class="summary-card">
          <span>缓存命中率</span>
          <strong class="text-cyan-600 dark:text-cyan-400">{{
            percent(summary.cacheHitRate)
          }}</strong>
          <small
            >{{ fmt(summary.cacheHitNumerator) }} / {{ fmt(summary.cacheHitDenominator) }}</small
          >
        </article>
        <article class="summary-card">
          <span>总费用</span>
          <strong class="text-amber-600 dark:text-amber-400">{{ cost(summary.totalCost) }}</strong>
        </article>
        <article class="summary-card">
          <span>平均耗时</span>
          <strong>{{ duration(summary.avgDurationMs) }}</strong>
        </article>
      </div>

      <div class="filter-panel">
        <div class="filter-grid">
          <el-date-picker
            v-model="filters.dateRange"
            clearable
            end-placeholder="结束时间"
            format="YYYY-MM-DD HH:mm:ss"
            start-placeholder="开始时间"
            type="datetimerange"
            unlink-panels
          />
          <el-input
            v-model="filters.keyword"
            clearable
            placeholder="搜索 Request ID / API Key / 模型 / 接口"
          >
            <template #prefix><i class="fas fa-search text-cyan-500" /></template>
          </el-input>
          <el-select v-model="filters.apiKeyId" clearable filterable placeholder="所有子 API">
            <el-option
              v-for="item in available.apiKeys"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
          </el-select>
          <el-select v-model="filters.model" clearable filterable placeholder="所有模型">
            <el-option v-for="item in available.models" :key="item" :label="item" :value="item" />
          </el-select>
          <el-select v-model="filters.endpoint" clearable filterable placeholder="所有接口">
            <el-option
              v-for="item in available.endpoints"
              :key="item"
              :label="item"
              :value="item"
            />
          </el-select>
          <el-select v-model="filters.sortOrder" placeholder="时间排序">
            <el-option label="时间降序" value="desc" />
            <el-option label="时间升序" value="asc" />
          </el-select>
        </div>
        <button class="reset-button" @click="resetFilters">
          <i class="fas fa-undo" />重置筛选
        </button>
      </div>

      <div class="records-panel">
        <div v-if="loading" class="state-panel"><i class="fas fa-spinner fa-spin" />加载中...</div>
        <div v-else-if="records.length === 0" class="state-panel">
          <i class="fas fa-inbox text-2xl text-cyan-500" />
          <b>暂无请求明细</b>
          <span>这里只显示当前账号子 API 在保留期内的记录。</span>
        </div>
        <template v-else>
          <div class="hidden overflow-x-auto xl:block">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>API Key</th>
                  <th>模型</th>
                  <th>接口</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存读 / 建</th>
                  <th>命中率</th>
                  <th>费用</th>
                  <th>耗时</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="record in records" :key="record.requestId">
                  <td>{{ date(record.timestamp) }}</td>
                  <td>
                    <b>{{ record.apiKeyName || record.apiKeyId || '-' }}</b>
                    <small>{{ record.apiKeyId }}</small>
                  </td>
                  <td>
                    <b>{{ record.model }}</b>
                    <small>{{ record.reasoningDisplay || '无推理标记' }}</small>
                  </td>
                  <td>
                    <span>{{ record.endpoint || '-' }}</span>
                    <small>{{ record.method || '-' }} · {{ record.statusCode || '-' }}</small>
                  </td>
                  <td>{{ fmt(record.inputTokens) }}</td>
                  <td>{{ fmt(record.outputTokens) }}</td>
                  <td>
                    {{ fmt(record.cacheReadTokens) }} /
                    {{ record.cacheCreateNotApplicable ? '-' : fmt(record.cacheCreateTokens) }}
                  </td>
                  <td>{{ percent(record.cacheHitRate) }}</td>
                  <td class="cost-cell">{{ cost(record.cost) }}</td>
                  <td>{{ duration(record.durationMs) }}</td>
                  <td>
                    <button class="detail-button" @click="openDetail(record.requestId)">
                      详情
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="grid gap-3 xl:hidden">
            <article v-for="record in records" :key="record.requestId" class="record-card">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <b>{{ record.model }}</b>
                  <p>{{ date(record.timestamp) }}</p>
                  <p>{{ record.apiKeyName || record.apiKeyId }}</p>
                </div>
                <button class="detail-button" @click="openDetail(record.requestId)">详情</button>
              </div>
              <div class="record-metrics">
                <span
                  >输入 <b>{{ fmt(record.inputTokens) }}</b></span
                >
                <span
                  >输出 <b>{{ fmt(record.outputTokens) }}</b></span
                >
                <span
                  >缓存读 <b>{{ fmt(record.cacheReadTokens) }}</b></span
                >
                <span
                  >命中 <b>{{ percent(record.cacheHitRate) }}</b></span
                >
                <span
                  >耗时 <b>{{ duration(record.durationMs) }}</b></span
                >
                <span
                  >费用 <b class="cost-cell">{{ cost(record.cost) }}</b></span
                >
              </div>
            </article>
          </div>

          <footer class="pagination-bar">
            <span>共 {{ pagination.totalRecords }} 条记录</span>
            <el-pagination
              background
              :current-page="pagination.currentPage"
              layout="prev, pager, next, sizes"
              :page-size="pagination.pageSize"
              :page-sizes="[20, 50, 100, 200]"
              :total="pagination.totalRecords"
              @current-change="changePage"
              @size-change="changePageSize"
            />
          </footer>
        </template>
      </div>
    </section>

    <V2RequestDetailModal
      :request-id="activeRequestId"
      :show="detailVisible"
      @close="closeDetail"
    />
  </div>
</template>

<script setup>
import { nextTick, onMounted, reactive, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { debounce } from 'lodash-es'
import { getV2RequestDetailsApi } from '@/utils/http_apis'
import { formatNumber, showToast } from '@/utils/tools'
import V2RequestDetailModal from '@/components/v2/V2RequestDetailModal.vue'
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
  const response = await getV2RequestDetailsApi(buildParams(page))
  if (version === fetchVersion) {
    if (response?.success === false) {
      showToast(
        response.code === 'V2_REQUEST_DETAILS_BUSY'
          ? '请求明细查询繁忙，请稍后重试'
          : response.message || '加载请求明细失败',
        'error'
      )
    } else {
      syncData(response.data)
    }
    loading.value = false
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
const resetFilters = () => {
  suppressDateWatch = true
  filters.dateRange = null
  filters.keyword = ''
  filters.apiKeyId = ''
  filters.model = ''
  filters.endpoint = ''
  filters.sortOrder = 'desc'
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
    if (result.records.length === 0) {
      showToast(result.complete ? '没有可导出的记录' : '导出中断，未取得可用记录', 'info')
      return
    }

    let filename = 'request-details.csv'
    if (!result.complete) {
      const messages = {
        no_snapshot: '无法建立一致性快照，请缩小筛选范围或稍后重试。',
        busy: '查询持续繁忙，导出已中断。',
        snapshot_changed: '查询快照发生变化，导出已中断。',
        page_limit: '数据超过 100 页导出上限。',
        request_failed: result.message || '请求失败，导出已中断。'
      }
      const confirmed = window.confirm(
        `${messages[result.reason] || '导出未完整完成'}\n\n是否下载已取得的部分记录？`
      )
      if (!confirmed) return
      filename = 'request-details-partial.csv'
    }

    downloadCsv(
      buildV2RequestDetailsCsv(result.records, {
        formatDate: date,
        formatDuration: (value) => (Number(value || 0) / 1000).toFixed(2)
      }),
      filename
    )
    showToast(
      result.complete ? '导出 CSV 成功' : '已下载部分记录，导出未完整完成',
      result.complete ? 'success' : 'warning'
    )
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

const fmt = (value) => formatNumber(Number(value) || 0)
const date = (value) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-')
const duration = (value) => `${(Number(value || 0) / 1000).toFixed(2)}s`
const percent = (value) => `${Number(value || 0).toFixed(2)}%`
const cost = (value) => {
  const amount = Number(value || 0)
  if (amount >= 1) return `$${amount.toFixed(2)}`
  if (amount >= 0.001) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(6)}`
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
.page-shell {
  overflow: hidden;
  border: 1px solid rgba(14, 116, 144, 0.16);
  border-radius: 24px;
  background:
    radial-gradient(circle at 92% 0%, rgba(34, 211, 238, 0.13), transparent 30%),
    linear-gradient(150deg, rgba(255, 255, 255, 0.98), rgba(240, 249, 255, 0.92));
  padding: 20px;
}
.dark .page-shell {
  border-color: rgba(34, 211, 238, 0.15);
  background:
    radial-gradient(circle at 92% 0%, rgba(8, 145, 178, 0.16), transparent 30%),
    linear-gradient(150deg, rgba(15, 23, 42, 0.98), rgba(17, 24, 39, 0.95));
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.eyebrow {
  color: rgb(8 145 178);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
}
.page-header h1 {
  margin-top: 4px;
  font-size: 26px;
  font-weight: 800;
  color: rgb(15 23 42);
}
.dark .page-header h1 {
  color: rgb(241 245 249);
}
.page-header p:not(.eyebrow) {
  margin-top: 5px;
  color: rgb(100 116 139);
  font-size: 14px;
}
.header-actions {
  display: flex;
  gap: 8px;
}
.action-button,
.reset-button,
.detail-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.86);
  padding: 9px 13px;
  color: rgb(51 65 85);
  font-size: 13px;
  font-weight: 650;
}
.action-button.primary {
  border-color: rgb(8 145 178);
  background: rgb(8 145 178);
  color: white;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-top: 20px;
}
.summary-card,
.filter-panel,
.records-panel {
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(10px);
}
.dark .summary-card,
.dark .filter-panel,
.dark .records-panel {
  background: rgba(15, 23, 42, 0.58);
}
.summary-card {
  border-radius: 15px;
  padding: 14px;
}
.summary-card span,
.summary-card small {
  display: block;
  color: rgb(100 116 139);
  font-size: 12px;
}
.summary-card strong {
  display: block;
  margin-top: 5px;
  font-size: 20px;
}
.filter-panel {
  margin-top: 12px;
  border-radius: 17px;
  padding: 14px;
}
.filter-grid {
  display: grid;
  grid-template-columns: 1.35fr 1.35fr repeat(4, minmax(130px, 1fr));
  gap: 10px;
}
.reset-button {
  margin-top: 10px;
}
.records-panel {
  margin-top: 12px;
  border-radius: 17px;
  overflow: hidden;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th {
  background: rgba(226, 232, 240, 0.55);
  color: rgb(71 85 105);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-align: left;
  text-transform: uppercase;
}
th,
td {
  padding: 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  white-space: nowrap;
  font-size: 13px;
}
td small {
  display: block;
  margin-top: 3px;
  color: rgb(100 116 139);
}
.cost-cell {
  color: rgb(217 119 6);
  font-weight: 700;
}
.detail-button {
  padding: 6px 10px;
}
.state-panel {
  display: flex;
  min-height: 220px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: rgb(100 116 139);
}
.record-card {
  margin: 12px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 14px;
  padding: 14px;
}
.record-card p {
  color: rgb(100 116 139);
  font-size: 12px;
}
.record-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
  font-size: 13px;
}
.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px;
  color: rgb(100 116 139);
  font-size: 13px;
}
@media (max-width: 1100px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .page-shell {
    padding: 14px;
  }
  .page-header,
  .pagination-bar {
    align-items: stretch;
    flex-direction: column;
  }
  .header-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .filter-grid,
  .summary-grid {
    grid-template-columns: 1fr;
  }
  .pagination-bar {
    overflow-x: auto;
  }
}
</style>
