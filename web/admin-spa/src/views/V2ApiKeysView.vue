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
      <div class="flex items-center gap-2">
        <button
          class="rounded-xl bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          @click="openAccountIpWhitelistModal"
        >
          <i class="fas fa-shield-alt mr-2" />IP 白名单
        </button>
        <button class="btn btn-primary px-4 py-2 text-sm font-semibold" @click="openCreateModal">
          <i class="fas fa-plus mr-2" />新建 API Key
        </button>
      </div>
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
              <div class="flex items-center justify-end gap-1">
                <button
                  class="rounded px-2 py-1 text-xs font-medium text-purple-600 transition-colors hover:bg-purple-50 hover:text-purple-900 dark:text-purple-400 dark:hover:bg-purple-900/20"
                  title="详情"
                  @click="openDetailModal(key)"
                >
                  <i class="fas fa-chart-line" />
                  <span class="ml-1">详情</span>
                </button>
                <button
                  class="rounded px-2 py-1 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-900 dark:text-blue-400 dark:hover:bg-blue-900/20"
                  title="编辑"
                  @click="openEditModal(key)"
                >
                  <i class="fas fa-edit" />
                  <span class="ml-1">编辑</span>
                </button>
                <button
                  :class="[
                    'rounded px-2 py-1 text-xs font-medium transition-colors',
                    key.isActive
                      ? 'text-orange-600 hover:bg-orange-50 hover:text-orange-900 dark:text-orange-400 dark:hover:bg-orange-900/20'
                      : 'text-green-600 hover:bg-green-50 hover:text-green-900 dark:text-green-400 dark:hover:bg-green-900/20'
                  ]"
                  :title="key.isActive ? '禁用' : '启用'"
                  @click="toggleKey(key)"
                >
                  <i :class="key.isActive ? 'fas fa-ban' : 'fas fa-check-circle'" />
                  <span class="ml-1">{{ key.isActive ? '禁用' : '启用' }}</span>
                </button>
                <button
                  class="rounded px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
                  title="删除"
                  @click="removeKey(key)"
                >
                  <i class="fas fa-trash" />
                  <span class="ml-1">删除</span>
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
          <div v-if="editingId">
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300"
              >IP 白名单</label
            >
            <div class="space-y-2">
              <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input v-model="form.ipWhitelistMode" type="radio" value="inherit" />
                跟随账号默认
              </label>
              <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input v-model="form.ipWhitelistMode" type="radio" value="custom" />
                自定义白名单
              </label>
              <textarea
                v-if="form.ipWhitelistMode === 'custom'"
                v-model="form.ipWhitelistInput"
                class="form-input w-full font-mono text-xs"
                placeholder="每行一个 IP 或 CIDR，例如：&#10;203.0.113.10&#10;198.51.100.0/24"
                rows="4"
              />
              <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input v-model="form.ipWhitelistMode" type="radio" value="disabled" />
                不启用白名单
              </label>
            </div>
            <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
              「不启用白名单」表示该 Key 不受账号级白名单限制；仅限制 API 调用，不影响后台登录。
            </p>
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

    <!-- 详情弹窗（摘要 + 请求时间线；时间线含 token 与计费，逐条可看详情，均不含账户信息） -->
    <div
      v-if="showDetailModal"
      class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
    >
      <div class="modal-content mx-auto flex max-h-[85vh] w-full max-w-4xl flex-col p-4 sm:p-6">
        <div class="mb-4 flex items-center justify-between">
          <h3 class="text-xl font-bold text-gray-900 dark:text-gray-100">API Key 详情</h3>
          <button
            class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            @click="closeDetailModal"
          >
            <i class="fas fa-times text-xl" />
          </button>
        </div>

        <div v-if="detailKey" class="flex-1 overflow-y-auto">
          <!-- 摘要区：仅展示该子 key 自身字段，不含任何上游账户信息 -->
          <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            <div class="col-span-full">
              <dt class="text-xs text-gray-500 dark:text-gray-400">名称</dt>
              <dd class="font-semibold text-gray-900 dark:text-gray-100">{{ detailKey.name }}</dd>
            </div>
            <div v-if="detailKey.description" class="col-span-full">
              <dt class="text-xs text-gray-500 dark:text-gray-400">描述</dt>
              <dd class="text-gray-700 dark:text-gray-200">{{ detailKey.description }}</dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 dark:text-gray-400">状态</dt>
              <dd class="mt-0.5">
                <span
                  :class="[
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    detailKey.isActive
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                  ]"
                >
                  {{ detailKey.isActive ? '启用' : '禁用' }}
                </span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 dark:text-gray-400">请求数</dt>
              <dd class="text-gray-700 dark:text-gray-200">
                {{ detailKey.usage?.total?.requests ?? '—' }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 dark:text-gray-400">今日费用</dt>
              <dd class="text-gray-700 dark:text-gray-200">
                {{ fmtCost(detailKey.dailyCost) }}
                <span v-if="detailKey.dailyCostLimit > 0" class="text-xs text-gray-400">
                  / {{ fmtCost(detailKey.dailyCostLimit) }}
                </span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 dark:text-gray-400">总费用</dt>
              <dd class="text-gray-700 dark:text-gray-200">
                {{ fmtCost(detailKey.totalCost) }}
                <span v-if="detailKey.totalCostLimit > 0" class="text-xs text-gray-400">
                  / {{ fmtCost(detailKey.totalCostLimit) }}
                </span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 dark:text-gray-400">Token 数</dt>
              <dd class="text-gray-700 dark:text-gray-200">
                {{ detailKey.usage?.total?.tokens ?? '—' }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 dark:text-gray-400">创建时间</dt>
              <dd class="text-gray-700 dark:text-gray-200">
                {{ detailKey.createdAt ? formatDate(detailKey.createdAt) : '—' }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 dark:text-gray-400">最后使用</dt>
              <dd class="text-gray-700 dark:text-gray-200">
                {{ detailKey.lastUsedAt ? formatDate(detailKey.lastUsedAt) : '从未使用' }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 dark:text-gray-400">IP 白名单</dt>
              <dd class="text-gray-700 dark:text-gray-200">
                {{ ipWhitelistSummary(detailKey) }}
              </dd>
            </div>
          </dl>

          <!-- 请求时间线（最新在前，含 token 与计费；逐条可看详情，不含账户信息） -->
          <div class="mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
            <div class="mb-3 flex items-center justify-between">
              <h4 class="text-sm font-semibold text-gray-900 dark:text-gray-100">请求时间线</h4>
              <button
                v-if="!timelineLoaded"
                class="btn btn-primary px-3 py-1.5 text-xs font-semibold"
                :disabled="timelineLoading"
                @click="loadTimeline"
              >
                <div v-if="timelineLoading" class="loading-spinner mr-2" />
                查看请求时间线
              </button>
            </div>

            <div v-if="timelineLoading" class="py-6 text-center text-gray-500 dark:text-gray-400">
              <div class="loading-spinner mx-auto mb-2" />
              加载中...
            </div>
            <div
              v-else-if="timelineLoaded && timeline.length === 0"
              class="py-6 text-center text-sm text-gray-500 dark:text-gray-400"
            >
              暂无请求记录
            </div>
            <div v-else-if="timelineLoaded" class="overflow-x-auto">
              <table class="w-full text-left text-sm">
                <thead>
                  <tr
                    class="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
                  >
                    <th class="whitespace-nowrap px-3 py-2">时间</th>
                    <th class="whitespace-nowrap px-3 py-2">模型</th>
                    <th class="whitespace-nowrap px-3 py-2 text-right">输入</th>
                    <th class="whitespace-nowrap px-3 py-2 text-right">输出</th>
                    <th class="whitespace-nowrap px-3 py-2 text-right">缓存(创/读)</th>
                    <th class="whitespace-nowrap px-3 py-2 text-right">总 Token</th>
                    <th class="whitespace-nowrap px-3 py-2 text-right">费用</th>
                    <th class="whitespace-nowrap px-3 py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(record, idx) in timeline"
                    :key="idx"
                    class="border-b border-gray-100 text-gray-700 dark:border-gray-800 dark:text-gray-200"
                  >
                    <td class="whitespace-nowrap px-3 py-2 text-xs">
                      {{ record.timestamp ? formatDate(record.timestamp) : '—' }}
                    </td>
                    <td class="whitespace-nowrap px-3 py-2 font-mono text-xs">
                      {{ record.model || 'unknown' }}
                    </td>
                    <td
                      class="whitespace-nowrap px-3 py-2 text-right text-xs text-blue-600 dark:text-blue-400"
                    >
                      {{ formatNumber(record.inputTokens || 0) }}
                    </td>
                    <td
                      class="whitespace-nowrap px-3 py-2 text-right text-xs text-green-600 dark:text-green-400"
                    >
                      {{ formatNumber(record.outputTokens || 0) }}
                    </td>
                    <td
                      class="whitespace-nowrap px-3 py-2 text-right text-xs text-purple-600 dark:text-purple-400"
                    >
                      {{ formatNumber(record.cacheCreateTokens || 0) }} /
                      {{ formatNumber(record.cacheReadTokens || 0) }}
                    </td>
                    <td class="whitespace-nowrap px-3 py-2 text-right text-xs">
                      {{ formatNumber(record.totalTokens || 0) }}
                    </td>
                    <td
                      class="whitespace-nowrap px-3 py-2 text-right text-xs text-yellow-600 dark:text-yellow-400"
                    >
                      {{ formatCost(record.cost) }}
                    </td>
                    <td class="whitespace-nowrap px-3 py-2 text-right">
                      <button
                        class="rounded px-2 py-1 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-900 dark:text-blue-400 dark:hover:bg-blue-900/20"
                        @click="openRecordDetail(record)"
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="py-2 text-xs text-gray-400 dark:text-gray-500">
              点击上方按钮加载该 Key 的最近请求记录（含 token 与计费信息）。
            </p>
          </div>
        </div>

        <div class="mt-5 flex justify-end">
          <button
            class="rounded-xl bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            @click="closeDetailModal"
          >
            关闭
          </button>
        </div>
      </div>
    </div>

    <!-- 单条请求详情（叠加在详情弹窗之上；仅时间、模型、token、计费分解，不含账户/渠道） -->
    <div
      v-if="showRecordModal"
      class="modal fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4"
    >
      <div class="modal-content mx-auto flex max-h-[85vh] w-full max-w-2xl flex-col p-4 sm:p-6">
        <div class="mb-4 flex items-center justify-between">
          <div>
            <p class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">请求详情</p>
            <p class="text-lg font-bold text-gray-900 dark:text-gray-100">
              {{ activeRecord?.model || '未知模型' }}
            </p>
          </div>
          <button
            class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            @click="closeRecordDetail"
          >
            <i class="fas fa-times text-xl" />
          </button>
        </div>

        <div v-if="activeRecord" class="flex-1 space-y-4 overflow-y-auto">
          <div class="grid gap-3 md:grid-cols-2">
            <!-- 基本信息（不含账户/渠道） -->
            <div
              class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50"
            >
              <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">基本信息</h4>
              <ul class="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                <li class="flex items-center justify-between">
                  <span class="text-gray-500 dark:text-gray-400">时间</span>
                  <span class="font-medium">
                    {{ activeRecord.timestamp ? formatDate(activeRecord.timestamp) : '—' }}
                  </span>
                </li>
                <li class="flex items-center justify-between">
                  <span class="text-gray-500 dark:text-gray-400">模型</span>
                  <span class="font-medium">{{ activeRecord.model || '未知模型' }}</span>
                </li>
              </ul>
            </div>

            <!-- Token 使用 -->
            <div
              class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50"
            >
              <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">
                Token 使用
              </h4>
              <ul class="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                <li class="flex items-center justify-between">
                  <span class="text-gray-500 dark:text-gray-400">输入 Token</span>
                  <span class="font-semibold text-blue-600 dark:text-blue-400">
                    {{ formatNumber(activeRecord.inputTokens || 0) }}
                  </span>
                </li>
                <li class="flex items-center justify-between">
                  <span class="text-gray-500 dark:text-gray-400">输出 Token</span>
                  <span class="font-semibold text-green-600 dark:text-green-400">
                    {{ formatNumber(activeRecord.outputTokens || 0) }}
                  </span>
                </li>
                <li class="flex items-center justify-between">
                  <span class="text-gray-500 dark:text-gray-400">缓存创建</span>
                  <span class="font-semibold text-purple-600 dark:text-purple-400">
                    {{ formatNumber(activeRecord.cacheCreateTokens || 0) }}
                  </span>
                </li>
                <li class="flex items-center justify-between">
                  <span class="text-gray-500 dark:text-gray-400">缓存读取</span>
                  <span class="font-semibold text-orange-600 dark:text-orange-400">
                    {{ formatNumber(activeRecord.cacheReadTokens || 0) }}
                  </span>
                </li>
                <li
                  class="flex items-center justify-between border-t border-gray-200 pt-2 dark:border-gray-700"
                >
                  <span class="text-gray-500 dark:text-gray-400">总计</span>
                  <span class="font-semibold text-gray-900 dark:text-gray-100">
                    {{ formatNumber(activeRecord.totalTokens || 0) }}
                  </span>
                </li>
              </ul>
            </div>
          </div>

          <!-- 费用详情（倍率计费分解） -->
          <div
            class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900/40"
          >
            <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">费用详情</h4>
            <div v-if="activeRecord.costBreakdown" class="grid gap-3 sm:grid-cols-2">
              <div
                class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
              >
                <span class="text-sm text-gray-500 dark:text-gray-400">输入费用</span>
                <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {{ formatCost(activeRecord.costBreakdown?.input) }}
                </span>
              </div>
              <div
                class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
              >
                <span class="text-sm text-gray-500 dark:text-gray-400">输出费用</span>
                <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {{ formatCost(activeRecord.costBreakdown?.output) }}
                </span>
              </div>
              <div
                class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
              >
                <span class="text-sm text-gray-500 dark:text-gray-400">缓存创建</span>
                <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {{ formatCost(activeRecord.costBreakdown?.cacheCreate) }}
                </span>
              </div>
              <div
                class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
              >
                <span class="text-sm text-gray-500 dark:text-gray-400">缓存读取</span>
                <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {{ formatCost(activeRecord.costBreakdown?.cacheRead) }}
                </span>
              </div>
            </div>
            <div
              class="mt-4 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800"
            >
              <span class="text-sm font-semibold text-gray-700 dark:text-gray-200">总费用</span>
              <div class="text-base font-bold text-yellow-600 dark:text-yellow-400">
                {{ formatCost(activeRecord.cost) }}
              </div>
            </div>
          </div>
        </div>

        <div class="mt-5 flex justify-end">
          <button
            class="rounded-xl bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            @click="closeRecordDetail"
          >
            关闭
          </button>
        </div>
      </div>
    </div>

    <!-- 账号级 IP 白名单弹窗（对本账号下所有未自定义白名单的子 key 生效） -->
    <Teleport to="body">
      <div
        v-if="showAccountIpWhitelistModal"
        class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
      >
        <div class="modal-content mx-auto w-full max-w-md p-4 sm:p-6">
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-xl font-bold text-gray-900 dark:text-gray-100">账号级 IP 白名单</h3>
            <button
              class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              @click="closeAccountIpWhitelistModal"
            >
              <i class="fas fa-times text-xl" />
            </button>
          </div>
          <p class="mb-4 text-sm text-gray-500 dark:text-gray-400">
            对本账号下所有未自定义白名单的 API Key 生效；仅限制 API 调用，不影响后台登录。
          </p>
          <div
            v-if="accountIpWhitelistLoading"
            class="py-8 text-center text-gray-500 dark:text-gray-400"
          >
            <div class="loading-spinner mx-auto mb-2" />
            加载中...
          </div>
          <form v-else class="space-y-4" @submit.prevent="saveAccountIpWhitelist">
            <div class="flex items-center gap-2">
              <input
                id="v2-account-ip-enable"
                v-model="accountIpWhitelistForm.enableIpWhitelist"
                type="checkbox"
              />
              <label
                class="text-sm font-semibold text-gray-700 dark:text-gray-300"
                for="v2-account-ip-enable"
              >
                启用 IP 白名单
              </label>
            </div>
            <div>
              <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">
                允许的 IP / CIDR
              </label>
              <textarea
                v-model="accountIpWhitelistForm.input"
                class="form-input w-full font-mono text-xs"
                placeholder="每行一个 IP 或 CIDR，例如：&#10;203.0.113.10&#10;198.51.100.0/24"
                rows="6"
              />
              <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
                支持换行、逗号、空格、分号分隔；支持 IPv4 / IPv6 与 CIDR。
              </p>
            </div>
            <p v-if="accountIpWhitelistError" class="text-sm text-red-500">
              {{ accountIpWhitelistError }}
            </p>
            <div class="flex gap-3 pt-2">
              <button
                class="flex-1 rounded-xl bg-gray-100 px-4 py-2.5 font-semibold text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                type="button"
                @click="closeAccountIpWhitelistModal"
              >
                取消
              </button>
              <button
                class="btn btn-primary flex-1 px-4 py-2.5 font-semibold"
                :disabled="accountIpWhitelistSaving"
                type="submit"
              >
                <div v-if="accountIpWhitelistSaving" class="loading-spinner mr-2" />
                保存
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

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
import { showToast, copyText, formatDate, formatNumber, parseIpWhitelistInput } from '@/utils/tools'
import {
  getV2AccountApi,
  getV2ApiKeysApi,
  createV2ApiKeyApi,
  updateV2ApiKeyApi,
  deleteV2ApiKeyApi,
  getV2ApiKeyUsageRecordsApi,
  getV2IpWhitelistApi,
  updateV2IpWhitelistApi
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
  isActive: true,
  // IP 白名单三态：inherit=跟随账号默认 / custom=自定义 / disabled=覆盖为不启用
  ipWhitelistMode: 'inherit',
  ipWhitelistInput: ''
})

const showSecretModal = ref(false)
const newSecret = ref('')

// 账号级 IP 白名单弹窗
const showAccountIpWhitelistModal = ref(false)
const accountIpWhitelistLoading = ref(false)
const accountIpWhitelistSaving = ref(false)
const accountIpWhitelistError = ref('')
const accountIpWhitelistForm = reactive({
  enableIpWhitelist: false,
  input: ''
})

// 详情弹窗 + 请求时间线
const showDetailModal = ref(false)
const detailKey = ref(null)
const timeline = ref([])
const timelineLoading = ref(false)
const timelineLoaded = ref(false)

// 单条请求详情弹窗（不含任何账户信息）
const showRecordModal = ref(false)
const activeRecord = ref(null)

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

// 单条请求费用自适应展示（与管理员请求详情一致：>=1 两位，>=0.001 四位，否则六位）
const formatCost = (n) => {
  const num = Number(n) || 0
  if (num >= 1) {
    return `$${num.toFixed(2)}`
  }
  if (num >= 0.001) {
    return `$${num.toFixed(4)}`
  }
  return `$${num.toFixed(6)}`
}

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
  form.ipWhitelistMode = 'inherit'
  form.ipWhitelistInput = ''
  showFormModal.value = true
}

const openEditModal = (key) => {
  editingId.value = key.id
  form.name = key.name || ''
  form.description = key.description || ''
  form.dailyCostLimit = key.dailyCostLimit || 0
  form.totalCostLimit = key.totalCostLimit || 0
  form.isActive = key.isActive !== false
  if (!key.ipWhitelistOverride) {
    form.ipWhitelistMode = 'inherit'
    form.ipWhitelistInput = ''
  } else if (key.enableIpWhitelist) {
    form.ipWhitelistMode = 'custom'
    form.ipWhitelistInput = Array.isArray(key.ipWhitelist) ? key.ipWhitelist.join('\n') : ''
  } else {
    form.ipWhitelistMode = 'disabled'
    form.ipWhitelistInput = ''
  }
  showFormModal.value = true
}

// 详情弹窗摘要：展示子 key 自身 override 状态（账号级名单不经列表接口下发）
const ipWhitelistSummary = (key) => {
  if (!key?.ipWhitelistOverride) {
    return '跟随账号默认'
  }
  if (key.enableIpWhitelist) {
    return `自定义（${Array.isArray(key.ipWhitelist) ? key.ipWhitelist.length : 0} 个 IP）`
  }
  return '自定义（已停用）'
}

const submitForm = async () => {
  if (!form.name || !form.name.trim()) {
    showToast('请填写名称', 'error')
    return
  }
  formLoading.value = true
  try {
    if (editingId.value) {
      const payload = {
        name: form.name.trim(),
        description: form.description?.trim() || '',
        dailyCostLimit: form.dailyCostLimit || 0,
        totalCostLimit: form.totalCostLimit || 0,
        isActive: form.isActive
      }
      // 三态恰好对应三个合法终态；inherit 只发 override=false，不携带表单残留 enable/list
      if (form.ipWhitelistMode === 'inherit') {
        payload.ipWhitelistOverride = false
      } else if (form.ipWhitelistMode === 'disabled') {
        payload.ipWhitelistOverride = true
        payload.enableIpWhitelist = false
        payload.ipWhitelist = []
      } else {
        const entries = parseIpWhitelistInput(form.ipWhitelistInput)
        if (entries.length === 0) {
          showToast('启用 IP 白名单时至少需要填写一个 IP 或 CIDR', 'error')
          return
        }
        payload.ipWhitelistOverride = true
        payload.enableIpWhitelist = true
        payload.ipWhitelist = entries
      }
      const res = await updateV2ApiKeyApi(editingId.value, payload)
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

// 账号级 IP 白名单：打开弹窗时才 GET（不在首屏加载时额外请求）
const openAccountIpWhitelistModal = async () => {
  showAccountIpWhitelistModal.value = true
  accountIpWhitelistError.value = ''
  accountIpWhitelistLoading.value = true
  try {
    const res = await getV2IpWhitelistApi()
    if (res.success && res.data) {
      accountIpWhitelistForm.enableIpWhitelist = !!res.data.enableIpWhitelist
      accountIpWhitelistForm.input = Array.isArray(res.data.ipWhitelist)
        ? res.data.ipWhitelist.join('\n')
        : ''
    }
  } catch (error) {
    showToast(error.message || '加载 IP 白名单失败', 'error')
    showAccountIpWhitelistModal.value = false
  } finally {
    accountIpWhitelistLoading.value = false
  }
}

const closeAccountIpWhitelistModal = () => {
  showAccountIpWhitelistModal.value = false
  accountIpWhitelistError.value = ''
}

const saveAccountIpWhitelist = async () => {
  const entries = parseIpWhitelistInput(accountIpWhitelistForm.input)
  if (accountIpWhitelistForm.enableIpWhitelist && entries.length === 0) {
    accountIpWhitelistError.value = '启用 IP 白名单时至少需要填写一个 IP 或 CIDR'
    return
  }
  accountIpWhitelistError.value = ''
  accountIpWhitelistSaving.value = true
  try {
    const res = await updateV2IpWhitelistApi({
      enableIpWhitelist: accountIpWhitelistForm.enableIpWhitelist,
      ipWhitelist: entries
    })
    if (res.success) {
      showToast('IP 白名单已更新', 'success')
      showAccountIpWhitelistModal.value = false
    } else {
      accountIpWhitelistError.value = res.message || '保存失败'
    }
  } catch (error) {
    accountIpWhitelistError.value = error.message || '保存失败'
  } finally {
    accountIpWhitelistSaving.value = false
  }
}

const openDetailModal = (key) => {
  detailKey.value = key
  timeline.value = []
  timelineLoaded.value = false
  timelineLoading.value = false
  showDetailModal.value = true
}

const closeDetailModal = () => {
  showDetailModal.value = false
  detailKey.value = null
  timeline.value = []
  timelineLoaded.value = false
  timelineLoading.value = false
  showRecordModal.value = false
  activeRecord.value = null
}

const loadTimeline = async () => {
  if (!detailKey.value?.id) {
    return
  }
  timelineLoading.value = true
  try {
    const res = await getV2ApiKeyUsageRecordsApi(detailKey.value.id, { limit: 100 })
    timeline.value = res.success && Array.isArray(res.data) ? res.data : []
    timelineLoaded.value = true
  } catch (error) {
    showToast(error.message || '加载请求时间线失败', 'error')
  } finally {
    timelineLoading.value = false
  }
}

const openRecordDetail = (record) => {
  activeRecord.value = record
  showRecordModal.value = true
}

const closeRecordDetail = () => {
  showRecordModal.value = false
  activeRecord.value = null
}

const copySecret = async () => {
  await copyText(newSecret.value)
  showToast('已复制', 'success')
}

onMounted(refresh)
</script>
