import { useEffect, useMemo, useState } from 'react'
import type { Exercise, Workout, WorkoutEntry, WorkoutSet } from '../../../shared/contracts.ts'
import { unlockSound } from '../../workout/beep'
import { useWorkouts } from '../../workout/context'
import { allExercises, exerciseById, KIND_LABELS, REST_SECONDS } from '../../workout/exercises'
import { clock } from '../../workout/intervals'
import { freshSets, newId, startFrom } from '../../workout/plan'
import { describeSets, lastSets, recordsFor, workoutSeconds, workoutVolume } from '../../workout/stats'

function readNumber(raw: string) {
  if (raw.trim() === '') return undefined
  const value = Number(raw.replace(',', '.'))
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function ExercisePicker({ exercises, onPick }: { exercises: Exercise[]; onPick: (exercise: Exercise) => void }) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return exercises
      .filter((exercise) => {
        const haystack = `${exercise.name} ${exercise.muscles.join(' ')} ${exercise.equipment}`.toLowerCase()
        return words.every((word) => haystack.includes(word))
      })
      .slice(0, 8)
  }, [exercises, query])
  return (
    <div className="exercise-picker">
      <label className="field">
        <span>Add an exercise</span>
        <input
          className="text-input"
          placeholder="Search by name, muscle, or equipment"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {query ? (
        <ul className="pick-list">
          {matches.map((exercise) => (
            <li key={exercise.id}>
              <button
                type="button"
                className="asset"
                onClick={() => {
                  onPick(exercise)
                  setQuery('')
                }}
              >
                <span>{exercise.name}</span>
                <small>
                  {KIND_LABELS[exercise.kind]} · {exercise.muscles.join(', ')}
                </small>
              </button>
            </li>
          ))}
          {matches.length === 0 ? <li className="muted">No match. Add it on the Exercises tab.</li> : null}
        </ul>
      ) : null}
    </div>
  )
}

function SetRow({
  exercise,
  set,
  index,
  records,
  onChange,
  onRemove,
}: {
  exercise: Exercise
  set: WorkoutSet
  index: number
  records: string[]
  onChange: (set: WorkoutSet) => void
  onRemove: () => void
}) {
  const field = (key: 'weightKg' | 'reps' | 'seconds' | 'meters', label: string, step: string) => (
    <label className="set-field">
      <span>{label}</span>
      <input
        className="text-input"
        inputMode="decimal"
        type="number"
        min={0}
        step={step}
        value={set[key] ?? ''}
        onChange={(event) => {
          const value = readNumber(event.target.value)
          const next = { ...set }
          if (value === undefined) delete next[key]
          else next[key] = key === 'reps' ? Math.round(value) : value
          onChange(next)
        }}
      />
    </label>
  )
  return (
    <li className={set.done ? 'set-row set-done' : 'set-row'}>
      <span className="set-number">{index + 1}</span>
      {exercise.kind === 'strength' ? field('weightKg', 'kg', '0.5') : null}
      {exercise.kind === 'strength' || exercise.kind === 'bodyweight' ? field('reps', 'reps', '1') : null}
      {exercise.kind === 'bodyweight' ? field('weightKg', '+kg', '0.5') : null}
      {exercise.kind === 'timed' || exercise.kind === 'cardio' ? field('seconds', 'sec', '1') : null}
      {exercise.kind === 'cardio' ? field('meters', 'm', '10') : null}
      <label className="set-check">
        <input
          type="checkbox"
          checked={set.done}
          aria-label={`Set ${index + 1} done`}
          onChange={(event) => onChange({ ...set, done: event.target.checked, ...(event.target.checked ? { doneAt: Date.now() } : {}) })}
        />
        Done
      </label>
      <button type="button" className="text-button" aria-label={`Remove set ${index + 1}`} onClick={onRemove}>
        ×
      </button>
      {records.length > 0 ? <span className="pr-badge">PR · {records.join(' · ')}</span> : null}
    </li>
  )
}

function ActiveWorkout({ workout }: { workout: Workout }) {
  const { workouts, exercises: custom, saveWorkout, removeWorkout, startRest } = useWorkouts()
  const [now, setNow] = useState(() => Date.now())
  const library = useMemo(() => allExercises(custom), [custom])
  const earlier = useMemo(
    () => workouts.filter((item) => item.id !== workout.id && item.startedAt < workout.startedAt),
    [workouts, workout.id, workout.startedAt],
  )

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const update = (entries: WorkoutEntry[], patch: Partial<Workout> = {}) => saveWorkout({ ...workout, ...patch, entries })
  const updateEntry = (entry: WorkoutEntry) =>
    update(workout.entries.map((item) => (item.id === entry.id ? entry : item)))

  const doneCount = workout.entries.reduce((sum, entry) => sum + entry.sets.filter((set) => set.done).length, 0)

  return (
    <article className="card">
      <header className="card-head">
        <input
          className="text-input workout-name"
          aria-label="Workout name"
          value={workout.name}
          onChange={(event) => saveWorkout({ ...workout, name: event.target.value })}
        />
        <span className="pill">{clock(workoutSeconds(workout, now))}</span>
      </header>
      <p className="muted">
        {doneCount} {doneCount === 1 ? 'set' : 'sets'} done · {Math.round(workoutVolume(workout))} kg lifted. Ticking a set
        starts the rest timer.
      </p>

      {workout.entries.map((entry) => {
        const exercise = exerciseById(custom, entry.exerciseId)
        if (!exercise) {
          return (
            <section key={entry.id} className="entry">
              <h4>Removed exercise</h4>
              <button type="button" className="text-button" onClick={() => update(workout.entries.filter((item) => item.id !== entry.id))}>
                Remove
              </button>
            </section>
          )
        }
        const previous = describeSets(lastSets(earlier, exercise.id))
        return (
          <section key={entry.id} className="entry" aria-label={exercise.name}>
            <header className="card-head">
              <h4>{exercise.name}</h4>
              <button type="button" className="text-button" onClick={() => update(workout.entries.filter((item) => item.id !== entry.id))}>
                Remove
              </button>
            </header>
            <p className="muted">{previous ? `Last time: ${previous}` : exercise.cue}</p>
            <ul className="set-list">
              {entry.sets.map((set, index) => (
                <SetRow
                  key={set.id}
                  exercise={exercise}
                  set={set}
                  index={index}
                  records={recordsFor(set, exercise.id, earlier).map((record) => record.label)}
                  onChange={(next) => {
                    if (next.done && !set.done) {
                      unlockSound()
                      startRest(REST_SECONDS[exercise.kind], exercise.name)
                    }
                    updateEntry({ ...entry, sets: entry.sets.map((item) => (item.id === set.id ? next : item)) })
                  }}
                  onRemove={() => updateEntry({ ...entry, sets: entry.sets.filter((item) => item.id !== set.id) })}
                />
              ))}
            </ul>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const last = entry.sets.at(-1)
                updateEntry({ ...entry, sets: [...entry.sets, ...freshSets(last ? [last] : [], 1)] })
              }}
            >
              Add set
            </button>
          </section>
        )
      })}

      <ExercisePicker
        exercises={library}
        onPick={(exercise) =>
          update([...workout.entries, { id: newId(), exerciseId: exercise.id, sets: freshSets(lastSets(earlier, exercise.id)) }])
        }
      />

      <div className="controls">
        <button type="button" className="primary" onClick={() => saveWorkout({ ...workout, finishedAt: Date.now() })}>
          Finish workout
        </button>
        <button type="button" className="text-button" onClick={() => removeWorkout(workout.id)}>
          Discard
        </button>
      </div>
    </article>
  )
}

export function WorkoutLog() {
  const { ready, active, workouts, saveWorkout } = useWorkouts()
  if (!ready) return <p className="muted">Opening your workouts.</p>
  if (active) return <ActiveWorkout workout={active} />
  const recent = workouts.filter((workout) => workout.finishedAt).slice(0, 3)
  return (
    <article className="card empty-card">
      <h3>No workout running</h3>
      <p className="muted">Start an empty one, or repeat a recent workout with your last weights filled in.</p>
      <div className="controls">
        <button type="button" className="primary" onClick={() => saveWorkout(startFrom(null, workouts))}>
          Start a workout
        </button>
        {recent.map((workout) => (
          <button key={workout.id} type="button" className="secondary" onClick={() => saveWorkout(startFrom(workout, workouts))}>
            Repeat {workout.name}
          </button>
        ))}
      </div>
    </article>
  )
}
