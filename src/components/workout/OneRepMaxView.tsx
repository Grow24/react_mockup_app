import { useMemo, useState } from 'react'
import { useWorkouts } from '../../workout/context'
import { exerciseById } from '../../workout/exercises'
import { estimates, MAX_ESTIMATE_REPS, percentTable } from '../../workout/oneRepMax'
import { exerciseHistory } from '../../workout/stats'

const CHART_WIDTH = 420
const CHART_HEIGHT = 160
const PAD = 28

function HistoryChart({ points }: { points: { at: number; oneRepMax: number }[] }) {
  if (points.length < 2) return <p className="muted">Log this lift on two days to see a trend.</p>
  const values = points.map((point) => point.oneRepMax)
  const low = Math.floor(Math.min(...values) * 0.95)
  const high = Math.ceil(Math.max(...values) * 1.05)
  const x = (index: number) => PAD + (index / (points.length - 1)) * (CHART_WIDTH - PAD * 2)
  const y = (value: number) => CHART_HEIGHT - PAD - ((value - low) / Math.max(1, high - low)) * (CHART_HEIGHT - PAD * 2)
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.oneRepMax).toFixed(1)}`).join(' ')
  return (
    <svg
      className="max-chart"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      aria-label={`Estimated one-rep max from ${values[0]!.toFixed(1)} to ${values.at(-1)!.toFixed(1)} kg`}
    >
      <text x={4} y={y(high) + 4} className="axis">{high} kg</text>
      <text x={4} y={y(low) + 4} className="axis">{low} kg</text>
      <path d={line} fill="none" stroke="#0f6a64" strokeWidth={2.5} />
      {points.map((point, index) => (
        <circle key={point.at} cx={x(index)} cy={y(point.oneRepMax)} r={4} fill="#0f6a64">
          <title>
            {new Date(point.at).toLocaleDateString()}: {point.oneRepMax.toFixed(1)} kg
          </title>
        </circle>
      ))}
    </svg>
  )
}

export function OneRepMaxView() {
  const { workouts, exercises } = useWorkouts()
  const [weight, setWeight] = useState('100')
  const [reps, setReps] = useState('5')
  const result = estimates(Number(weight), Number(reps))
  const lifted = useMemo(() => {
    const ids = new Set(workouts.flatMap((workout) => workout.entries.filter((entry) => entry.sets.some((set) => set.done && set.weightKg && set.reps)).map((entry) => entry.exerciseId)))
    return [...ids].flatMap((id) => {
      const exercise = exerciseById(exercises, id)
      return exercise ? [exercise] : []
    })
  }, [workouts, exercises])
  const [chosen, setChosen] = useState<string>('')
  const exerciseId = chosen || lifted[0]?.id || ''
  const history = useMemo(
    () =>
      exerciseHistory(
        workouts.filter((workout) => workout.finishedAt),
        exerciseId,
      ).flatMap((item) => (item.oneRepMax != null ? [{ ...item, oneRepMax: item.oneRepMax }] : [])),
    [workouts, exerciseId],
  )
  const best = history.reduce<(typeof history)[number] | null>((top, item) => (!top || item.oneRepMax > top.oneRepMax ? item : top), null)
  const heaviest = history.reduce<(typeof history)[number] | null>((top, item) => (!top || item.weightKg > top.weightKg ? item : top), null)

  return (
    <div className="layout">
      <article className="card" aria-label="One-rep max calculator">
        <header className="card-head">
          <h3>1RM calculator</h3>
        </header>
        <div className="timer-fields">
          <label className="field">
            <span>Weight (kg)</span>
            <input className="text-input" type="number" min={0} step={0.5} inputMode="decimal" value={weight} onChange={(event) => setWeight(event.target.value)} />
          </label>
          <label className="field">
            <span>Reps</span>
            <input className="text-input" type="number" min={1} max={MAX_ESTIMATE_REPS} step={1} value={reps} onChange={(event) => setReps(event.target.value)} />
          </label>
        </div>
        {result ? (
          <>
            <p className="max-result">
              <strong>{result.average.toFixed(1)} kg</strong> estimated one-rep max
            </p>
            <p className="muted">
              Epley {result.epley.toFixed(1)} · Brzycki {result.brzycki.toFixed(1)} · Lombardi {result.lombardi.toFixed(1)} kg
            </p>
            <table className="max-table">
              <thead>
                <tr>
                  <th>% of max</th>
                  <th>Weight</th>
                  <th>About</th>
                </tr>
              </thead>
              <tbody>
                {percentTable(result.average).map((row) => (
                  <tr key={row.percent}>
                    <td>{row.percent}%</td>
                    <td>{row.weight} kg</td>
                    <td>
                      {row.reps} {row.reps === 1 ? 'rep' : 'reps'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="warn">Enter a weight and 1 to {MAX_ESTIMATE_REPS} reps. Estimates past that are unreliable.</p>
        )}
      </article>

      <aside className="side">
        <article className="card" aria-label="Lift history">
          <header className="card-head">
            <h3>Your lifts</h3>
          </header>
          {lifted.length === 0 ? (
            <p className="muted">Finish a workout with weights and reps to track your estimated max here.</p>
          ) : (
            <>
              <label className="field">
                <span>Exercise</span>
                <select value={exerciseId} onChange={(event) => setChosen(event.target.value)}>
                  {lifted.map((exercise) => (
                    <option key={exercise.id} value={exercise.id}>
                      {exercise.name}
                    </option>
                  ))}
                </select>
              </label>
              <HistoryChart points={history} />
              <ul className="label-list">
                {best ? (
                  <li>
                    Best estimated max {best.oneRepMax.toFixed(1)} kg ({best.weightKg} kg × {best.reps},{' '}
                    {new Date(best.at).toLocaleDateString()})
                  </li>
                ) : null}
                {heaviest ? (
                  <li>
                    Heaviest set {heaviest.weightKg} kg × {heaviest.reps} ({new Date(heaviest.at).toLocaleDateString()})
                  </li>
                ) : null}
              </ul>
            </>
          )}
        </article>
      </aside>
    </div>
  )
}
