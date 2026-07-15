<template>
  <div class="tutorial-section space-y-6">
    <div>
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white dark:bg-cyan-700 sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >1</span
        >
        配置 Grok Build
      </h4>
      <p class="mb-3 text-sm text-gray-700 dark:text-gray-300 sm:text-base">
        将配置保存到
        <code class="rounded bg-gray-100 px-1 dark:bg-gray-800">{{ configPath }}</code>
        。合并前请备份已有配置，并将示例 API Key 替换为后台创建的 Key。
      </p>

      <div
        class="rounded-lg border border-cyan-200 bg-slate-50 p-3 dark:border-cyan-800 dark:bg-slate-900/40 sm:p-4"
      >
        <div class="overflow-x-auto rounded bg-gray-950 p-3 font-mono text-xs sm:p-4 sm:text-sm">
          <div
            v-for="(line, index) in configLines"
            :key="`${index}-${line}`"
            class="whitespace-pre text-gray-300"
          >
            {{ line || '&nbsp;' }}
          </div>
        </div>
        <p class="mt-3 text-xs text-slate-600 dark:text-slate-300 sm:text-sm">
          Base URL 推荐使用 <code>{{ grokBaseUrl }}</code
          >；<code>{{ grokBaseUrl }}/v1</code>
          也可作为兼容地址。不要填写 xAI 内部 OAuth 上游地址。
        </p>
      </div>
    </div>

    <div>
      <h4
        class="mb-3 flex items-center text-lg font-semibold text-gray-800 dark:text-gray-300 sm:text-xl"
      >
        <span
          class="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-cyan-700 text-xs font-bold text-white sm:mr-3 sm:h-8 sm:w-8 sm:text-sm"
          >2</span
        >
        验证配置
      </h4>
      <div class="overflow-x-auto rounded bg-gray-950 p-3 font-mono text-xs sm:p-4 sm:text-sm">
        <div class="whitespace-nowrap text-gray-300">grok inspect</div>
        <div class="whitespace-nowrap text-gray-300">
          grok -p "Reply with crs-grok-ok" -m crs-grok
        </div>
      </div>
      <p class="mt-3 text-xs text-gray-500 dark:text-gray-400 sm:text-sm">
        API Key 必须同时拥有 Grok 权限并启用 Grok Responses 入口。
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useTutorialUrls } from '@/utils/useTutorialUrls'

const props = defineProps({
  platform: {
    type: String,
    required: true,
    validator: (value) => ['windows', 'macos', 'linux'].includes(value)
  }
})

const { grokBaseUrl } = useTutorialUrls()

const configPath = computed(() =>
  props.platform === 'windows' ? '%USERPROFILE%\\.grok\\config.toml' : '~/.grok/config.toml'
)

const configLines = computed(() => [
  '[models]',
  'default = "crs-grok"',
  'web_search = "crs-grok"',
  '',
  '[model."crs-grok"]',
  'model = "grok-4.5"',
  `base_url = "${grokBaseUrl.value}"`,
  'name = "Grok 4.5 via CRS"',
  'description = "Grok 4.5 through CRS"',
  'api_key = "你的API密钥"',
  'api_backend = "responses"',
  'context_window = 1000000',
  'supports_backend_search = true'
])
</script>
