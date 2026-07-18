import dayjs from 'dayjs'
import { formatNumber } from '@/utils/tools'

export const formatRequestDetailNumber = (value) => formatNumber(Number(value) || 0)

export const formatRequestDetailDate = (value) =>
  value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-'

export const formatRequestDetailDurationValue = (value) => {
  const durationMs = Number(value || 0)
  const seconds = Number.isFinite(durationMs) ? durationMs / 1000 : 0
  return seconds.toFixed(2)
}

export const formatRequestDetailDuration = (value) => `${formatRequestDetailDurationValue(value)}s`

export const formatRequestDetailPercent = (value) => `${Number(value || 0).toFixed(2)}%`

export const formatRequestDetailCost = (value) => {
  const amount = Number(value || 0)
  if (amount >= 1) return `$${amount.toFixed(2)}`
  if (amount >= 0.001) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(6)}`
}

export const formatRequestDetailCacheCreate = (value, notApplicable = false) =>
  notApplicable ? '-' : formatRequestDetailNumber(value)

export const formatRequestDetailCacheCreateCost = (value, notApplicable = false) =>
  notApplicable ? '-' : formatRequestDetailCost(value)

export const formatRequestDetailReasoning = (value) => value || '-'
