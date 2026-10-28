import type { InferencePerformance } from '../types'

export type PerformanceState = {
  seen: number
  dropped: number
  stamps: number[]
  latencies: number[]
}

export function emptyPerformance(): PerformanceState {
  return { seen: 0, dropped: 0, stamps: [], latencies: [] }
}

export function noteInference(
  state: PerformanceState,
  now: number,
  inferenceMs: number,
  presented: number,
): { state: PerformanceState; sample: InferencePerformance } {
  const missed = Math.max(0, presented - state.seen - 1)
  const dropped = state.dropped + missed
  const stamps = state.stamps.concat(now).filter((stamp) => now - stamp <= 1000)
  const latencies = state.latencies.concat(inferenceMs).slice(-12)
  const latencyMs = latencies.reduce((sum, value) => sum + value, 0) / latencies.length
  return {
    state: { seen: presented, dropped, stamps, latencies },
    sample: {
      processedFps: stamps.length,
      latencyMs,
      droppedFrames: dropped,
    },
  }
}
