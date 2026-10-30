import { useMemo, useState } from 'react'
import type { Exercise, ExerciseKind } from '../../../shared/contracts.ts'
import { useWorkouts } from '../../workout/context'
import { allExercises, KIND_LABELS } from '../../workout/exercises'

const KINDS = Object.keys(KIND_LABELS) as ExerciseKind[]

export function ExerciseLibrary() {
  const { exercises: custom, saveExercise, removeExercise } = useWorkouts()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<ExerciseKind | 'all'>('all')
  const [draft, setDraft] = useState({ name: '', kind: 'strength' as ExerciseKind, muscles: '', equipment: '', cue: '' })
  const library = useMemo(() => allExercises(custom), [custom])
  const shown = library.filter((exercise) => {
    if (kind !== 'all' && exercise.kind !== kind) return false
    const haystack = `${exercise.name} ${exercise.muscles.join(' ')} ${exercise.equipment}`.toLowerCase()
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((word) => haystack.includes(word))
  })

  function add() {
    const name = draft.name.trim()
    if (!name) return
    const exercise: Exercise = {
      id: crypto.randomUUID(),
      name,
      kind: draft.kind,
      muscles: draft.muscles.split(',').map((muscle) => muscle.trim()).filter(Boolean),
      equipment: draft.equipment.trim(),
      cue: draft.cue.trim(),
    }
    saveExercise(exercise)
    setDraft({ name: '', kind: draft.kind, muscles: '', equipment: '', cue: '' })
  }

  return (
    <div className="layout">
      <article className="card">
        <header className="card-head">
          <h3>Exercises</h3>
          <span className="pill">{shown.length}</span>
        </header>
        <div className="controls filter-row">
          <input
            className="text-input"
            aria-label="Search exercises"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value as ExerciseKind | 'all')}>
            <option value="all">All kinds</option>
            {KINDS.map((item) => (
              <option key={item} value={item}>
                {KIND_LABELS[item]}
              </option>
            ))}
          </select>
        </div>
        <ul className="asset-list">
          {shown.map((exercise) => (
            <li key={exercise.id} className="model-row">
              <div>
                <strong>{exercise.name}</strong>
                <small className="muted">
                  {' '}
                  · {KIND_LABELS[exercise.kind]} · {exercise.muscles.join(', ') || 'no muscles listed'}
                  {exercise.equipment ? ` · ${exercise.equipment}` : ''}
                </small>
                {exercise.cue ? <p className="muted">{exercise.cue}</p> : null}
              </div>
              {exercise.builtIn ? null : (
                <button type="button" className="text-button" onClick={() => removeExercise(exercise.id)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </article>

      <aside className="side">
        <article className="card" aria-label="Add an exercise">
          <header className="card-head">
            <h3>Add your own</h3>
          </header>
          <label className="field">
            <span>Name</span>
            <input className="text-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="field">
            <span>Kind</span>
            <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as ExerciseKind })}>
              {KINDS.map((item) => (
                <option key={item} value={item}>
                  {KIND_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Muscles, separated by commas</span>
            <input className="text-input" value={draft.muscles} onChange={(event) => setDraft({ ...draft, muscles: event.target.value })} />
          </label>
          <label className="field">
            <span>Equipment</span>
            <input className="text-input" value={draft.equipment} onChange={(event) => setDraft({ ...draft, equipment: event.target.value })} />
          </label>
          <label className="field">
            <span>Coaching cue</span>
            <input className="text-input" value={draft.cue} onChange={(event) => setDraft({ ...draft, cue: event.target.value })} />
          </label>
          <button type="button" className="primary" disabled={!draft.name.trim()} onClick={add}>
            Add exercise
          </button>
        </article>
      </aside>
    </div>
  )
}
