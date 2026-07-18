<template>
  <div
    class="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 dark:border-gray-700 dark:bg-gray-800/40"
  >
    <div class="request-toolbar">
      <div class="request-filters">
        <div class="request-filter-row request-filter-row-primary">
          <ToolbarControl gradient="from-blue-500 to-purple-500">
            <el-date-picker
              class="toolbar-element w-full"
              clearable
              end-placeholder="结束时间"
              format="YYYY-MM-DD HH:mm:ss"
              :model-value="filters.dateRange"
              start-placeholder="开始时间"
              type="datetimerange"
              unlink-panels
              @update:model-value="updateFilter('dateRange', $event)"
            />
          </ToolbarControl>
          <ToolbarControl gradient="from-cyan-500 to-teal-500">
            <el-input
              class="toolbar-element w-full"
              clearable
              :model-value="filters.keyword"
              :placeholder="keywordPlaceholder"
              @update:model-value="updateFilter('keyword', $event)"
            >
              <template #prefix><i class="fas fa-search text-cyan-500" /></template>
            </el-input>
          </ToolbarControl>
        </div>

        <div class="request-filter-row request-filter-row-secondary">
          <ToolbarControl gradient="from-indigo-500 to-blue-500">
            <el-select
              class="toolbar-element w-full"
              clearable
              filterable
              :model-value="filters.apiKeyId"
              :placeholder="apiKeyPlaceholder"
              @update:model-value="updateFilter('apiKeyId', $event)"
            >
              <el-option
                v-for="item in apiKeys"
                :key="item.id"
                :label="item.name"
                :value="item.id"
              />
            </el-select>
          </ToolbarControl>
          <ToolbarControl v-if="admin" gradient="from-purple-500 to-pink-500">
            <el-select
              class="toolbar-element w-full"
              clearable
              filterable
              :model-value="filters.accountId"
              placeholder="所有账户"
              @update:model-value="updateFilter('accountId', $event)"
            >
              <el-option
                v-for="item in accounts"
                :key="item.id"
                :label="`${item.name}（${item.accountTypeName}）`"
                :value="item.id"
              />
            </el-select>
          </ToolbarControl>
          <ToolbarControl gradient="from-emerald-500 to-green-500">
            <el-select
              class="toolbar-element w-full"
              clearable
              filterable
              :model-value="filters.model"
              placeholder="所有模型"
              @update:model-value="updateFilter('model', $event)"
            >
              <el-option v-for="item in models" :key="item" :label="item" :value="item" />
            </el-select>
          </ToolbarControl>
          <ToolbarControl gradient="from-orange-500 to-amber-500">
            <el-select
              class="toolbar-element w-full"
              clearable
              filterable
              :model-value="filters.endpoint"
              placeholder="所有接口"
              @update:model-value="updateFilter('endpoint', $event)"
            >
              <el-option v-for="item in endpoints" :key="item" :label="item" :value="item" />
            </el-select>
          </ToolbarControl>
          <ToolbarControl gradient="from-slate-500 to-gray-500">
            <el-select
              class="toolbar-element w-full"
              :model-value="filters.sortOrder"
              placeholder="时间排序"
              @update:model-value="updateFilter('sortOrder', $event)"
            >
              <el-option label="时间降序" value="desc" />
              <el-option label="时间升序" value="asc" />
            </el-select>
          </ToolbarControl>
        </div>
      </div>

      <div class="request-toolbar-actions">
        <ActionButton color="green" icon="fa-sync-alt" :loading="loading" @click="$emit('refresh')"
          >刷新</ActionButton
        >
        <ActionButton color="gray" icon="fa-undo" @click="$emit('reset')">重置筛选</ActionButton>
        <ActionButton
          color="blue"
          icon="fa-file-export"
          :loading="exporting"
          @click="$emit('export')"
          >导出 CSV</ActionButton
        >
        <el-tooltip v-if="admin" placement="top">
          <template #content
            ><div class="max-w-xs text-xs leading-relaxed">
              清理所有已保存的历史请求体预览数据；仅影响历史预览，不影响当前请求体预览开关设置
            </div></template
          >
          <ActionButton color="red" icon="fa-trash-alt" :loading="purging" @click="$emit('purge')"
            >清理历史预览</ActionButton
          >
        </el-tooltip>
      </div>
    </div>
  </div>
</template>

<script setup>
/* eslint-disable vue/one-component-per-file */
import { defineComponent, h } from 'vue'

defineProps({
  filters: { type: Object, required: true },
  apiKeys: { type: Array, default: () => [] },
  accounts: { type: Array, default: () => [] },
  models: { type: Array, default: () => [] },
  endpoints: { type: Array, default: () => [] },
  admin: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  exporting: { type: Boolean, default: false },
  purging: { type: Boolean, default: false },
  keywordPlaceholder: { type: String, required: true },
  apiKeyPlaceholder: { type: String, default: '所有 API Key' }
})
const emit = defineEmits(['update-filter', 'refresh', 'reset', 'export', 'purge'])
const updateFilter = (field, value) => emit('update-filter', { field, value })

const ToolbarControl = defineComponent({
  props: { gradient: { type: String, required: true } },
  setup(componentProps, { slots }) {
    return () =>
      h('div', { class: 'toolbar-control group' }, [
        h('div', { class: `toolbar-control-glow bg-gradient-to-r ${componentProps.gradient}` }),
        slots.default?.()
      ])
  }
})

const ActionButton = defineComponent({
  props: {
    icon: { type: String, required: true },
    color: { type: String, required: true },
    loading: { type: Boolean, default: false }
  },
  emits: ['click'],
  setup(componentProps, { slots, emit: componentEmit }) {
    const gradients = {
      green: 'from-green-500 to-teal-500',
      gray: 'from-gray-400 to-gray-500',
      blue: 'from-blue-500 to-indigo-500',
      red: 'from-red-500 to-orange-500'
    }
    const textColors = {
      green: 'text-green-500',
      gray: 'text-gray-500',
      blue: 'text-blue-500',
      red: 'text-red-500'
    }
    return () =>
      h(
        'button',
        {
          class:
            'toolbar-action-button group relative flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-all duration-200 hover:border-gray-300 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500',
          disabled: componentProps.loading,
          onClick: () => componentEmit('click')
        },
        [
          h('span', {
            class: `absolute -inset-0.5 rounded-lg bg-gradient-to-r ${gradients[componentProps.color]} opacity-0 blur transition duration-300 group-hover:opacity-20`
          }),
          h('i', {
            class: `fas relative ${textColors[componentProps.color]} ${componentProps.loading ? 'fa-spinner fa-spin' : componentProps.icon}`
          }),
          h('span', { class: 'relative' }, slots.default?.())
        ]
      )
  }
})
</script>

<style scoped>
.request-toolbar,
.request-filters {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
}
.request-filter-row {
  display: grid;
  min-width: 0;
  gap: 12px;
  grid-template-columns: minmax(0, 1fr);
}
.toolbar-control {
  position: relative;
  min-width: 0;
}
.toolbar-control-glow {
  position: absolute;
  inset: -2px;
  border-radius: 12px;
  opacity: 0;
  filter: blur(10px);
  transition: opacity 0.3s ease;
}
.toolbar-control:hover .toolbar-control-glow {
  opacity: 0.16;
}
.toolbar-control :deep(.el-input__wrapper),
.toolbar-control :deep(.el-select__wrapper) {
  min-height: 40px;
  border: 1px solid rgb(229 231 235);
  border-radius: 10px;
  background: white;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}
.toolbar-control :deep(.el-input__wrapper:hover),
.toolbar-control :deep(.el-select__wrapper:hover) {
  border-color: rgb(209 213 219);
}
.toolbar-control :deep(.el-input__wrapper.is-focus),
.toolbar-control :deep(.el-select__wrapper.is-focused) {
  border-color: rgb(6 182 212);
  box-shadow: 0 0 0 1px rgba(6, 182, 212, 0.15);
}
:global(.dark) .toolbar-control :deep(.el-input__wrapper),
:global(.dark) .toolbar-control :deep(.el-select__wrapper) {
  border-color: rgb(75 85 99);
  background: rgb(31 41 55);
}
.toolbar-control :deep(.el-date-editor) {
  width: 100%;
}
.request-toolbar-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.toolbar-action-button {
  min-width: 112px;
  white-space: nowrap;
}
@media (min-width: 768px) {
  .request-filter-row-primary {
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
  }
  .request-filter-row-secondary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .request-toolbar-actions {
    flex-flow: row wrap;
  }
}
@media (min-width: 1280px) {
  .request-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 16px;
  }
  .request-filter-row-secondary {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
  .request-toolbar-actions {
    align-self: stretch;
    justify-content: flex-end;
    flex-wrap: nowrap;
  }
}
</style>
