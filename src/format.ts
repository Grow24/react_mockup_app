import type { InferencePerformance, NumericRange } from './types'

export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatWhen(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function formatRange(range: NumericRange | undefined, unit: string) {
  if (!range || (range.min == null && range.max == null)) {
    return 'Not exposed by this browser'
  }
  if (range.min != null && range.max != null) {
    if (range.min === range.max) return `${formatNumber(range.min)} ${unit}`
    return `${formatNumber(range.min)}–${formatNumber(range.max)} ${unit}`
  }
  const only = range.max ?? range.min
  return only == null ? 'Not exposed by this browser' : `${formatNumber(only)} ${unit}`
}

export function formatPercent(score: number) {
  return `${Math.round(score * 100)}%`
}

export function formatPerformance(sample: InferencePerformance) {
  return `${sample.processedFps} processed/s · ${Math.round(sample.latencyMs)} ms latency · ${sample.droppedFrames} dropped`
}

export function formatSetting(value: number | string | undefined, unit = '') {
  if (value == null || value === '') return 'Not reported'
  const rendered = typeof value === 'number' ? formatNumber(value) : value
  return unit ? `${rendered} ${unit}` : rendered
}
