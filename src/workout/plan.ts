import type { Workout, WorkoutSet } from '../../shared/contracts.ts'
import { lastSets } from './stats.ts'

export function newId() {
  return crypto.randomUUID()
}

function todayName() {
  return `Workout · ${new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`
}

// New sets copy the weights and reps from last time, ready to tick off.
export function freshSets(previous: WorkoutSet[], count = 3): WorkoutSet[] {
  if (previous.length === 0) return Array.from({ length: count }, () => ({ id: newId(), done: false }))
  return previous.map((set) => ({
    id: newId(),
    done: false,
    ...(set.reps != null ? { reps: set.reps } : {}),
    ...(set.weightKg != null ? { weightKg: set.weightKg } : {}),
    ...(set.seconds != null ? { seconds: set.seconds } : {}),
    ...(set.meters != null ? { meters: set.meters } : {}),
  }))
}

// A new workout, empty or repeating `source` with the most recent numbers for each exercise.
export function startFrom(source: Workout | null, everything: Workout[]): Workout {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name: source ? source.name : todayName(),
    startedAt: now,
    updatedAt: now,
    entries: source
      ? source.entries.map((entry) => ({
          id: newId(),
          exerciseId: entry.exerciseId,
          sets: freshSets(lastSets(everything, entry.exerciseId).length ? lastSets(everything, entry.exerciseId) : entry.sets),
        }))
      : [],
  }
}
