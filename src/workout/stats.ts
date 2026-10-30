import type { Workout, WorkoutSet } from '../../shared/contracts.ts'
import { estimateOneRepMax } from './oneRepMax.ts'

export function doneSets(workout: Workout) {
  return workout.entries.flatMap((entry) => entry.sets.filter((set) => set.done).map((set) => ({ entry, set })))
}

export function setVolume(set: WorkoutSet) {
  return set.done && set.weightKg && set.reps ? set.weightKg * set.reps : 0
}

export function workoutVolume(workout: Workout) {
  return doneSets(workout).reduce((sum, { set }) => sum + setVolume(set), 0)
}

export function workoutSeconds(workout: Workout, now = Date.now()) {
  return Math.max(0, Math.round(((workout.finishedAt ?? now) - workout.startedAt) / 1000))
}

export type ExerciseBest = { weightKg: number; reps: number; oneRepMax: number | null; at: number; workoutId: string }

// The best set of an exercise in one workout, by estimated one-rep max, then by weight.
export function bestSet(workout: Workout, exerciseId: string): ExerciseBest | null {
  let best: ExerciseBest | null = null
  for (const entry of workout.entries) {
    if (entry.exerciseId !== exerciseId) continue
    for (const set of entry.sets) {
      if (!set.done || !set.weightKg || !set.reps) continue
      const oneRepMax = estimateOneRepMax(set.weightKg, set.reps)
      const better =
        !best ||
        (oneRepMax ?? 0) > (best.oneRepMax ?? 0) ||
        ((oneRepMax ?? 0) === (best.oneRepMax ?? 0) && set.weightKg > best.weightKg)
      if (better) {
        best = { weightKg: set.weightKg, reps: set.reps, oneRepMax, at: set.doneAt ?? workout.startedAt, workoutId: workout.id }
      }
    }
  }
  return best
}

export function exerciseHistory(workouts: Workout[], exerciseId: string) {
  return workouts
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .flatMap((workout) => {
      const best = bestSet(workout, exerciseId)
      return best ? [{ ...best, at: workout.startedAt }] : []
    })
}

export type Record = { kind: 'weight' | 'oneRepMax' | 'reps'; label: string }

// What a finished set beats from every earlier workout: the heaviest weight, the best estimated
// max, or the most reps at this weight or more.
export function recordsFor(set: WorkoutSet, exerciseId: string, earlier: Workout[]): Record[] {
  if (!set.done || !set.weightKg || !set.reps) return []
  let heaviest = 0
  let bestMax = 0
  let mostReps = 0
  let seen = false
  for (const workout of earlier) {
    for (const entry of workout.entries) {
      if (entry.exerciseId !== exerciseId) continue
      for (const past of entry.sets) {
        if (!past.done || !past.weightKg || !past.reps) continue
        seen = true
        heaviest = Math.max(heaviest, past.weightKg)
        bestMax = Math.max(bestMax, estimateOneRepMax(past.weightKg, past.reps) ?? 0)
        if (past.weightKg >= set.weightKg) mostReps = Math.max(mostReps, past.reps)
      }
    }
  }
  if (!seen) return []
  const records: Record[] = []
  if (set.weightKg > heaviest) records.push({ kind: 'weight', label: `Heaviest ${set.weightKg} kg` })
  const max = estimateOneRepMax(set.weightKg, set.reps)
  if (max != null && max > bestMax + 0.05) records.push({ kind: 'oneRepMax', label: `Best 1RM ${max.toFixed(1)} kg` })
  if (set.weightKg <= heaviest && set.reps > mostReps) records.push({ kind: 'reps', label: `Most reps at ${set.weightKg} kg` })
  return records
}

// The sets from the last time this exercise was done, to show and to copy into a new workout.
export function lastSets(workouts: Workout[], exerciseId: string, before = Number.POSITIVE_INFINITY) {
  const previous = workouts
    .filter((workout) => workout.startedAt < before)
    .sort((a, b) => b.startedAt - a.startedAt)
  for (const workout of previous) {
    const entry = workout.entries.find((item) => item.exerciseId === exerciseId && item.sets.some((set) => set.done))
    if (entry) return entry.sets.filter((set) => set.done)
  }
  return []
}

export function describeSets(sets: WorkoutSet[]) {
  if (sets.length === 0) return ''
  const parts = sets.map((set) => {
    if (set.weightKg && set.reps) return `${set.weightKg} kg × ${set.reps}`
    if (set.reps) return `${set.reps} reps`
    if (set.seconds) return `${set.seconds} s`
    if (set.meters) return `${set.meters} m`
    return 'done'
  })
  const same = parts.every((part) => part === parts[0])
  return same && parts.length > 1 ? `${parts.length} × ${parts[0]}` : parts.join(', ')
}
