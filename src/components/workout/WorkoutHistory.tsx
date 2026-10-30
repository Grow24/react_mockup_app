import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkouts } from '../../workout/context'
import { exerciseById } from '../../workout/exercises'
import { clock } from '../../workout/intervals'
import { describeSets, doneSets, workoutSeconds, workoutVolume } from '../../workout/stats'
import { startFrom } from '../../workout/plan'

export function WorkoutHistory() {
  const { workouts, exercises, active, saveWorkout, removeWorkout } = useWorkouts()
  const [open, setOpen] = useState<string | null>(null)
  const navigate = useNavigate()
  const finished = workouts.filter((workout) => workout.finishedAt)

  if (finished.length === 0) {
    return (
      <article className="card empty-card">
        <h3>No finished workouts yet</h3>
        <p className="muted">Finished workouts appear here with their time, sets, and total weight lifted.</p>
      </article>
    )
  }

  return (
    <ul className="asset-list">
      {finished.map((workout) => {
        const expanded = open === workout.id
        return (
          <li key={workout.id} className="card history-row">
            <button type="button" className="asset" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : workout.id)}>
              <span>{workout.name}</span>
              <small>
                {new Date(workout.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
                {clock(workoutSeconds(workout))} · {doneSets(workout).length} sets · {Math.round(workoutVolume(workout))} kg
              </small>
            </button>
            {expanded ? (
              <>
                <ul className="label-list">
                  {workout.entries.map((entry) => {
                    const sets = entry.sets.filter((set) => set.done)
                    if (sets.length === 0) return null
                    return (
                      <li key={entry.id}>
                        {exerciseById(exercises, entry.exerciseId)?.name ?? 'Removed exercise'}: {describeSets(sets)}
                      </li>
                    )
                  })}
                </ul>
                <div className="controls">
                  <button
                    type="button"
                    className="secondary"
                    disabled={Boolean(active)}
                    onClick={() => {
                      saveWorkout(startFrom(workout, workouts))
                      navigate('/workouts')
                    }}
                  >
                    {active ? 'Finish the running workout first' : 'Repeat this workout'}
                  </button>
                  <button type="button" className="text-button" onClick={() => removeWorkout(workout.id)}>
                    Delete
                  </button>
                </div>
              </>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
