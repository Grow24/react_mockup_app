export type IntervalPlan = { workSeconds: number; restSeconds: number; rounds: number; prepareSeconds: number }

export type IntervalPhase = {
  kind: 'prepare' | 'work' | 'rest' | 'done'
  round: number
  left: number
  total: number
}

export const INTERVAL_PRESETS: { name: string; plan: IntervalPlan }[] = [
  { name: 'Tabata 20 / 10 × 8', plan: { workSeconds: 20, restSeconds: 10, rounds: 8, prepareSeconds: 10 } },
  { name: 'EMOM 60 s × 10', plan: { workSeconds: 60, restSeconds: 0, rounds: 10, prepareSeconds: 10 } },
  { name: 'Court sprints 30 / 30 × 6', plan: { workSeconds: 30, restSeconds: 30, rounds: 6, prepareSeconds: 10 } },
  { name: 'Shadow swings 45 / 15 × 5', plan: { workSeconds: 45, restSeconds: 15, rounds: 5, prepareSeconds: 10 } },
]

export function planSeconds(plan: IntervalPlan) {
  return plan.prepareSeconds + plan.rounds * plan.workSeconds + Math.max(0, plan.rounds - 1) * plan.restSeconds
}

// Where an interval plan is after `elapsed` seconds. The last round has no rest after it.
export function phaseAt(plan: IntervalPlan, elapsed: number): IntervalPhase {
  let t = Math.max(0, elapsed)
  if (t < plan.prepareSeconds) return { kind: 'prepare', round: 0, left: plan.prepareSeconds - t, total: plan.prepareSeconds }
  t -= plan.prepareSeconds
  for (let round = 1; round <= plan.rounds; round += 1) {
    if (t < plan.workSeconds) return { kind: 'work', round, left: plan.workSeconds - t, total: plan.workSeconds }
    t -= plan.workSeconds
    if (round === plan.rounds) break
    if (t < plan.restSeconds) return { kind: 'rest', round, left: plan.restSeconds - t, total: plan.restSeconds }
    t -= plan.restSeconds
  }
  return { kind: 'done', round: plan.rounds, left: 0, total: 0 }
}

export function clock(seconds: number) {
  const whole = Math.max(0, Math.ceil(seconds - 1e-9))
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}
