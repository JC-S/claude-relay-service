<template>
  <div class="flex flex-col items-start gap-0.5 text-[11px] leading-4">
    <div
      :aria-label="refreshTokenState.ariaLabel"
      :class="['inline-flex items-center gap-1', refreshTokenState.className]"
      tabindex="0"
      :title="refreshTokenState.title"
    >
      <i :class="['fas w-3 text-center text-[10px]', refreshTokenState.icon]" />
      <span>{{ refreshTokenState.text }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const props = defineProps({
  refreshTokenExpiresAt: {
    type: String,
    default: null
  },
  nowTs: {
    type: Number,
    required: true
  }
})

const parseDate = (value) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const formatLocalDateTime = (date) =>
  date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })

const refreshTokenState = computed(() => {
  const expiresAt = parseDate(props.refreshTokenExpiresAt)
  if (!expiresAt) {
    return {
      text: 'Refresh Token · 未知',
      title: '等待下次 Token 刷新或重新授权后获取',
      ariaLabel: 'Refresh Token 到期时间未知，等待下次 Token 刷新或重新授权后获取',
      icon: 'fa-key',
      className: 'text-gray-500 dark:text-gray-400'
    }
  }

  const remainingMs = expiresAt.getTime() - props.nowTs
  const exactTime = `到期时间：${formatLocalDateTime(expiresAt)}`
  if (remainingMs <= 0) {
    return {
      text: 'Refresh Token · 已过期',
      title: exactTime,
      ariaLabel: 'Refresh Token 已过期',
      icon: 'fa-exclamation-triangle',
      className: 'font-medium text-red-600 dark:text-red-400'
    }
  }

  if (remainingMs > 7 * DAY_MS) {
    const days = Math.floor(remainingMs / DAY_MS)
    return {
      text: `Refresh Token · ${days} 天后到期`,
      title: exactTime,
      ariaLabel: `Refresh Token 将在 ${days} 天后到期`,
      icon: 'fa-key',
      className: 'text-gray-500 dark:text-gray-400'
    }
  }

  if (remainingMs >= DAY_MS) {
    const days = Math.floor(remainingMs / DAY_MS)
    return {
      text: `Refresh Token · ${days} 天后到期`,
      title: exactTime,
      ariaLabel: `Refresh Token 即将到期，剩余 ${days} 天`,
      icon: 'fa-clock',
      className: 'font-medium text-orange-600 dark:text-orange-400'
    }
  }

  if (remainingMs >= HOUR_MS) {
    const hours = Math.floor(remainingMs / HOUR_MS)
    return {
      text: `Refresh Token · ${hours} 小时后到期`,
      title: exactTime,
      ariaLabel: `Refresh Token 即将到期，剩余 ${hours} 小时`,
      icon: 'fa-exclamation-triangle',
      className: 'font-medium text-red-600 dark:text-red-400'
    }
  }

  const minutes = Math.max(1, Math.ceil(remainingMs / MINUTE_MS))
  return {
    text: `Refresh Token · ${minutes} 分钟后到期`,
    title: exactTime,
    ariaLabel: `Refresh Token 即将到期，剩余 ${minutes} 分钟`,
    icon: 'fa-exclamation-triangle',
    className: 'font-medium text-red-600 dark:text-red-400'
  }
})
</script>
