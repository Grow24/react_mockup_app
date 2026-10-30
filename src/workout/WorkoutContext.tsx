import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Exercise, Workout } from '../../shared/contracts.ts'
import { useSession } from '../session/context'
import {
  fetchWorkoutBook,
  putExercise,
  putWorkout,
  removeExerciseRemote,
  removeWorkoutRemote,
} from './api'
import { WorkoutContext, type RestTimer } from './context'

type LocalBook = {
  workouts: Workout[]
  exercises: Exercise[]
  deleted: string[]
  deletedExercises: string[]
  dirty: string[]
  dirtyExercises: string[]
}

const empty = (): LocalBook => ({ workouts: [], exercises: [], deleted: [], deletedExercises: [], dirty: [], dirtyExercises: [] })

function bookKey(sessionId: string) {
  return `pbmp-workouts:${sessionId}`
}

function readLocal(sessionId: string): LocalBook {
  try {
    const raw = localStorage.getItem(bookKey(sessionId))
    return raw ? { ...empty(), ...(JSON.parse(raw) as Partial<LocalBook>) } : empty()
  } catch {
    return empty()
  }
}

function writeLocal(sessionId: string, book: LocalBook) {
  try {
    localStorage.setItem(bookKey(sessionId), JSON.stringify(book))
  } catch {
    // The workout still shows for this visit; it reaches the server on the next save.
  }
}

const unique = (items: string[]) => [...new Set(items)]

// Workouts live in this browser first, so logging works in a gym without signal, and every
// change is sent to the shared session when the server answers.
export function WorkoutProvider({ children }: { children: ReactNode }) {
  const { sessionId, backend } = useSession()
  // The provider renders once the session is open, so the local copy can be read up front.
  const [book, setBook] = useState<LocalBook>(() => (sessionId ? readLocal(sessionId) : empty()))
  const [ready, setReady] = useState(false)
  const [rest, setRest] = useState<RestTimer | null>(null)
  const bookRef = useRef(book)
  const syncing = useRef(false)

  const commit = useCallback(
    (next: LocalBook) => {
      bookRef.current = next
      setBook(next)
      if (sessionId) writeLocal(sessionId, next)
    },
    [sessionId],
  )

  const sync = useCallback(async () => {
    if (!sessionId || backend !== 'online' || syncing.current) return
    syncing.current = true
    try {
      for (;;) {
        const current = bookRef.current
        const workoutId = current.dirty[0]
        const exerciseId = current.dirtyExercises[0]
        if (!workoutId && !exerciseId) break
        if (workoutId) {
          const workout = current.workouts.find((item) => item.id === workoutId)
          let replacement: Workout | null | undefined
          if (current.deleted.includes(workoutId) || !workout) await removeWorkoutRemote(sessionId, workoutId)
          else replacement = await putWorkout(sessionId, workout)
          const latest = bookRef.current
          const keptNewer = latest.workouts.find((item) => item.id === workoutId)?.updatedAt !== workout?.updatedAt
          commit({
            ...latest,
            dirty: keptNewer ? latest.dirty : latest.dirty.filter((id) => id !== workoutId),
            workouts:
              replacement === null
                ? latest.workouts.filter((item) => item.id !== workoutId)
                : replacement && !keptNewer
                  ? latest.workouts.map((item) => (item.id === workoutId ? replacement : item))
                  : latest.workouts,
          })
        } else if (exerciseId) {
          const exercise = current.exercises.find((item) => item.id === exerciseId)
          if (current.deletedExercises.includes(exerciseId) || !exercise) await removeExerciseRemote(sessionId, exerciseId)
          else await putExercise(sessionId, exercise)
          const latest = bookRef.current
          commit({ ...latest, dirtyExercises: latest.dirtyExercises.filter((id) => id !== exerciseId) })
        }
      }
    } catch (error) {
      console.error(error)
    } finally {
      syncing.current = false
    }
  }, [backend, commit, sessionId])

  useEffect(() => {
    if (!sessionId) return
    let active = true
    const local = bookRef.current
    const merge = async () => {
      if (backend === 'online') {
        try {
          const server = await fetchWorkoutBook(sessionId)
          if (!active) return
          const gone = new Set([...server.deleted, ...local.deleted])
          const byId = new Map<string, Workout>()
          const dirty = new Set(local.dirty)
          for (const workout of server.workouts) byId.set(workout.id, workout)
          for (const workout of local.workouts) {
            const remote = byId.get(workout.id)
            if (!remote || workout.updatedAt > remote.updatedAt) {
              byId.set(workout.id, workout)
              dirty.add(workout.id)
            }
          }
          const exercises = new Map(server.exercises.map((exercise) => [exercise.id, exercise]))
          const dirtyExercises = new Set(local.dirtyExercises)
          for (const exercise of local.exercises) {
            if (!exercises.has(exercise.id)) dirtyExercises.add(exercise.id)
            if (!exercises.has(exercise.id) || local.dirtyExercises.includes(exercise.id)) exercises.set(exercise.id, exercise)
          }
          for (const id of local.deletedExercises) exercises.delete(id)
          commit({
            workouts: [...byId.values()].filter((workout) => !gone.has(workout.id)),
            exercises: [...exercises.values()],
            deleted: local.deleted.filter((id) => !server.deleted.includes(id)),
            deletedExercises: local.deletedExercises,
            dirty: unique([...dirty, ...local.deleted.filter((id) => !server.deleted.includes(id))]).filter(
              (id) => !server.deleted.includes(id),
            ),
            dirtyExercises: unique([...dirtyExercises, ...local.deletedExercises]),
          })
        } catch (error) {
          console.error(error)
        }
      }
      if (active) setReady(true)
      void sync()
    }
    void merge()
    return () => {
      active = false
    }
  }, [backend, commit, sessionId, sync])

  const saveWorkout = useCallback(
    (workout: Workout) => {
      const current = bookRef.current
      const next = { ...workout, updatedAt: Math.max(Date.now(), workout.updatedAt + 1) }
      const exists = current.workouts.some((item) => item.id === next.id)
      commit({
        ...current,
        workouts: exists ? current.workouts.map((item) => (item.id === next.id ? next : item)) : [next, ...current.workouts],
        dirty: unique([...current.dirty, next.id]),
      })
      void sync()
    },
    [commit, sync],
  )

  const removeWorkout = useCallback(
    (id: string) => {
      const current = bookRef.current
      commit({
        ...current,
        workouts: current.workouts.filter((item) => item.id !== id),
        deleted: unique([...current.deleted, id]),
        dirty: unique([...current.dirty, id]),
      })
      void sync()
    },
    [commit, sync],
  )

  const saveExercise = useCallback(
    (exercise: Exercise) => {
      const current = bookRef.current
      const exists = current.exercises.some((item) => item.id === exercise.id)
      commit({
        ...current,
        exercises: exists
          ? current.exercises.map((item) => (item.id === exercise.id ? exercise : item))
          : [...current.exercises, exercise],
        deletedExercises: current.deletedExercises.filter((id) => id !== exercise.id),
        dirtyExercises: unique([...current.dirtyExercises, exercise.id]),
      })
      void sync()
    },
    [commit, sync],
  )

  const removeExercise = useCallback(
    (id: string) => {
      const current = bookRef.current
      commit({
        ...current,
        exercises: current.exercises.filter((item) => item.id !== id),
        deletedExercises: unique([...current.deletedExercises, id]),
        dirtyExercises: unique([...current.dirtyExercises, id]),
      })
      void sync()
    },
    [commit, sync],
  )

  const startRest = useCallback((seconds: number, label: string) => {
    setRest({ until: Date.now() + seconds * 1000, seconds, label })
  }, [])

  const stopRest = useCallback(() => setRest(null), [])

  const workouts = useMemo(() => book.workouts.slice().sort((a, b) => b.startedAt - a.startedAt), [book.workouts])
  const active = workouts.find((workout) => !workout.finishedAt) ?? null

  const value = useMemo(
    () => ({
      ready,
      workouts,
      exercises: book.exercises,
      active,
      pending: book.dirty.length + book.dirtyExercises.length,
      rest,
      saveWorkout,
      removeWorkout,
      saveExercise,
      removeExercise,
      startRest,
      stopRest,
    }),
    [ready, workouts, book, active, rest, saveWorkout, removeWorkout, saveExercise, removeExercise, startRest, stopRest],
  )

  return <WorkoutContext.Provider value={value}>{children}</WorkoutContext.Provider>
}
