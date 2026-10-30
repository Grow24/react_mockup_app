import type { Exercise, Workout, WorkoutBook } from '../../shared/contracts.ts'

async function errorText(response: Response) {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error || response.statusText
  } catch {
    return response.statusText
  }
}

export type ServerBook = WorkoutBook & { deleted: string[] }

export async function fetchWorkoutBook(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/workouts`, { cache: 'no-store' })
  if (!response.ok) throw new Error(await errorText(response))
  return (await response.json()) as ServerBook
}

async function send<T>(path: string, method: 'PUT' | 'DELETE', body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(await errorText(response))
  return ((await response.json()) as { saved: T }).saved
}

export function putWorkout(sessionId: string, workout: Workout) {
  return send<Workout | null>(`/api/sessions/${sessionId}/workouts/${workout.id}`, 'PUT', workout)
}

export function removeWorkoutRemote(sessionId: string, id: string) {
  return send<boolean>(`/api/sessions/${sessionId}/workouts/${id}`, 'DELETE')
}

export function putExercise(sessionId: string, exercise: Exercise) {
  return send<Exercise>(`/api/sessions/${sessionId}/exercises/${exercise.id}`, 'PUT', exercise)
}

export function removeExerciseRemote(sessionId: string, id: string) {
  return send<boolean>(`/api/sessions/${sessionId}/exercises/${id}`, 'DELETE')
}
