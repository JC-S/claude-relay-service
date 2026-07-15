<template>
  <section
    class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/40"
  >
    <div class="mb-4 flex items-start justify-between gap-3">
      <div>
        <h5 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Grok 模型策略</h5>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          白名单为空时允许全部本站 Grok 模型；映射用于兼容客户端模型别名。
        </p>
      </div>
      <div class="flex rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
        <button
          v-for="option in modeOptions"
          :key="option.value"
          class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          :class="
            mode === option.value
              ? 'bg-slate-800 text-white shadow-sm dark:bg-cyan-700'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
          "
          type="button"
          @click="$emit('update:mode', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <div v-if="mode === 'whitelist'" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label
        v-for="model in models"
        :key="model.value"
        class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
        :class="
          allowedModels.includes(model.value)
            ? 'border-cyan-500 bg-cyan-50 text-cyan-900 dark:border-cyan-600 dark:bg-cyan-950/40 dark:text-cyan-100'
            : 'border-slate-200 text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300'
        "
      >
        <input
          :checked="allowedModels.includes(model.value)"
          class="rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
          type="checkbox"
          @change="toggleModel(model.value)"
        />
        <span>{{ model.label }}</span>
      </label>
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="(mapping, index) in mappings"
        :key="index"
        class="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2"
      >
        <input
          class="form-input min-w-0 border-gray-300 font-mono text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          placeholder="客户端模型"
          :value="mapping.from"
          @input="updateMapping(index, 'from', $event.target.value)"
        />
        <i class="fas fa-arrow-right text-xs text-slate-400" />
        <input
          class="form-input min-w-0 border-gray-300 font-mono text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          placeholder="上游 Grok 模型"
          :value="mapping.to"
          @input="updateMapping(index, 'to', $event.target.value)"
        />
        <button
          class="rounded-md p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
          title="删除映射"
          type="button"
          @click="removeMapping(index)"
        >
          <i class="fas fa-trash" />
        </button>
      </div>
      <button
        class="w-full rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-cyan-500 hover:text-cyan-700 dark:border-slate-700 dark:text-slate-300"
        type="button"
        @click="addMapping"
      >
        <i class="fas fa-plus mr-1" />添加模型映射
      </button>
    </div>
  </section>
</template>

<script setup>
const props = defineProps({
  mode: { type: String, default: 'whitelist' },
  allowedModels: { type: Array, default: () => [] },
  mappings: { type: Array, default: () => [] },
  models: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:mode', 'update:allowedModels', 'update:mappings'])

const modeOptions = [
  { value: 'whitelist', label: '白名单' },
  { value: 'mapping', label: '模型映射' }
]

const toggleModel = (model) => {
  const next = new Set(props.allowedModels)
  if (next.has(model)) next.delete(model)
  else next.add(model)
  emit('update:allowedModels', Array.from(next))
}

const addMapping = () => emit('update:mappings', [...props.mappings, { from: '', to: '' }])

const removeMapping = (index) =>
  emit(
    'update:mappings',
    props.mappings.filter((_, mappingIndex) => mappingIndex !== index)
  )

const updateMapping = (index, field, value) => {
  const next = props.mappings.map((mapping, mappingIndex) =>
    mappingIndex === index ? { ...mapping, [field]: value } : { ...mapping }
  )
  emit('update:mappings', next)
}
</script>
