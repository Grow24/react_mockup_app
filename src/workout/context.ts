import { createContext, useContext } from 'react'
import type { Exercise, Workout } from '../../shared/contracts.ts'

export type RestTimer = { until: number; seconds: number; label: string }

export type WorkoutValue = {
  ready: boolean
  workouts: Workout[]
  exercises: Exercise[]
  active: Workout | null
  pending: number
  rest: RestTimer | null
  saveWorkout: (workout: Workout) => void
  removeWorkout: (id: string) => void
  saveExercise: (exercise: Exercise) => void
  removeExercise: (id: string) => void
  startRest: (seconds: number, label: string) => void
  stopRest: () => void
}

export const WorkoutContext = createContext<WorkoutValue | null>(null)

export function useWorkouts() {
  const value = useContext(WorkoutContext)
  if (!value) throw new Error('useWorkouts must be used within WorkoutProvider')
  return value
}
