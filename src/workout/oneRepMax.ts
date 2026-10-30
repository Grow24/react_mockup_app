// Estimated one-rep max from a set of `reps` at `weight`. The formulas agree closely up to about
// ten reps and drift apart after that, so estimates past twelve reps are not shown.
export const MAX_ESTIMATE_REPS = 12

export function epley(weight: number, reps: number) {
  return reps === 1 ? weight : weight * (1 + reps / 30)
}

export function brzycki(weight: number, reps: number) {
  return reps === 1 ? weight : (weight * 36) / (37 - reps)
}

export function lombardi(weight: number, reps: number) {
  return weight * reps ** 0.1
}

export function estimates(weight: number, reps: number) {
  if (!(weight > 0) || !Number.isInteger(reps) || reps < 1 || reps > MAX_ESTIMATE_REPS) return null
  const values = { epley: epley(weight, reps), brzycki: brzycki(weight, reps), lombardi: lombardi(weight, reps) }
  return { ...values, average: (values.epley + values.brzycki + values.lombardi) / 3 }
}

export function estimateOneRepMax(weight: number | undefined, reps: number | undefined) {
  if (weight == null || reps == null) return null
  return estimates(weight, reps)?.average ?? null
}

// Reps a lifter can usually do at a share of their max, from the Epley curve, rounded down.
export function repsAtPercent(percent: number) {
  if (percent >= 100) return 1
  return Math.max(1, Math.floor(30 * (100 / percent - 1)))
}

export function roundToPlate(weight: number, step = 2.5) {
  return Math.round(weight / step) * step
}

export function percentTable(oneRepMax: number, step = 2.5) {
  const rows: { percent: number; weight: number; reps: number }[] = []
  for (let percent = 100; percent >= 50; percent -= 5) {
    rows.push({ percent, weight: roundToPlate((oneRepMax * percent) / 100, step), reps: repsAtPercent(percent) })
  }
  return rows
}
