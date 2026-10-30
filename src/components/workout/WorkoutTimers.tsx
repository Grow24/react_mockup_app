import { useEffect, useRef, useState } from 'react'
import { beep, unlockSound } from '../../workout/beep'
import { clock, INTERVAL_PRESETS, phaseAt, planSeconds, type IntervalPlan } from '../../workout/intervals'

// Runs from a start time instead of counting ticks, so a throttled background tab stays accurate.
function useRunClock() {
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [banked, setBanked] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [startedAt])
  const elapsed = banked + (startedAt != null ? (now - startedAt) / 1000 : 0)
  return {
    running: startedAt != null,
    elapsed,
    start: () => {
      unlockSound()
      setNow(Date.now())
      setStartedAt(Date.now())
    },
    pause: () => {
      setBanked(elapsed)
      setStartedAt(null)
    },
    reset: () => {
      setBanked(0)
      setStartedAt(null)
    },
  }
}

const PHASE_LABELS = { prepare: 'Get ready', work: 'Work', rest: 'Rest', done: 'All rounds finished' } as const

function IntervalTimer() {
  const [plan, setPlan] = useState<IntervalPlan>(INTERVAL_PRESETS[0]!.plan)
  const run = useRunClock()
  const phase = phaseAt(plan, run.elapsed)
  const last = useRef('')

  useEffect(() => {
    if (!run.running) return
    const key = `${phase.kind}-${phase.round}`
    const whole = Math.ceil(phase.left)
    if (key !== last.current.split('|')[0]) {
      last.current = `${key}|`
      if (phase.kind !== 'prepare') beep(phase.kind === 'work' ? 990 : 520, 300, true)
      if (phase.kind === 'done') run.pause()
      return
    }
    if (whole <= 3 && whole > 0 && last.current !== `${key}|${whole}`) {
      last.current = `${key}|${whole}`
      beep(660, 100)
    }
  }, [phase, run])

  const field = (key: keyof IntervalPlan, label: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        className="text-input"
        type="number"
        min={key === 'rounds' ? 1 : 0}
        max={key === 'rounds' ? 100 : 3600}
        value={plan[key]}
        disabled={run.running}
        onChange={(event) => {
          const value = Math.max(key === 'rounds' ? 1 : 0, Math.round(Number(event.target.value) || 0))
          setPlan({ ...plan, [key]: value })
          run.reset()
        }}
      />
    </label>
  )

  return (
    <article className="card" aria-label="Interval timer">
      <header className="card-head">
        <h3>Interval timer</h3>
        <span className="pill">{clock(planSeconds(plan))} total</span>
      </header>
      <div className={`timer-face timer-${phase.kind}`} role="timer" aria-live="polite">
        <span className="timer-phase">
          {PHASE_LABELS[phase.kind]}
          {phase.kind === 'work' || phase.kind === 'rest' ? ` · round ${phase.round} of ${plan.rounds}` : ''}
        </span>
        <strong className="timer-big">{phase.kind === 'done' ? 'Done' : clock(phase.left)}</strong>
      </div>
      <div className="controls">
        {run.running ? (
          <button type="button" className="secondary" onClick={run.pause}>
            Pause
          </button>
        ) : (
          <button type="button" className="primary" onClick={phase.kind === 'done' ? () => { run.reset(); run.start() } : run.start}>
            {run.elapsed > 0 && phase.kind !== 'done' ? 'Resume' : 'Start'}
          </button>
        )}
        <button type="button" className="secondary" onClick={run.reset}>
          Reset
        </button>
      </div>
      <label className="field">
        <span>Preset</span>
        <select
          disabled={run.running}
          value={INTERVAL_PRESETS.findIndex((preset) => JSON.stringify(preset.plan) === JSON.stringify(plan))}
          onChange={(event) => {
            const preset = INTERVAL_PRESETS[Number(event.target.value)]
            if (preset) setPlan(preset.plan)
            run.reset()
          }}
        >
          <option value={-1}>Custom</option>
          {INTERVAL_PRESETS.map((preset, index) => (
            <option key={preset.name} value={index}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>
      <div className="timer-fields">
        {field('workSeconds', 'Work (s)')}
        {field('restSeconds', 'Rest (s)')}
        {field('rounds', 'Rounds')}
        {field('prepareSeconds', 'Get ready (s)')}
      </div>
    </article>
  )
}

function Stopwatch() {
  const run = useRunClock()
  const [laps, setLaps] = useState<number[]>([])
  const tenths = (seconds: number) => `${clock(Math.floor(seconds))}.${Math.floor((seconds % 1) * 10)}`
  return (
    <article className="card" aria-label="Stopwatch">
      <header className="card-head">
        <h3>Stopwatch</h3>
      </header>
      <div className="timer-face" role="timer">
        <strong className="timer-big">{tenths(run.elapsed)}</strong>
      </div>
      <div className="controls">
        {run.running ? (
          <>
            <button type="button" className="secondary" onClick={run.pause}>
              Stop
            </button>
            <button type="button" className="secondary" onClick={() => setLaps([run.elapsed, ...laps])}>
              Lap
            </button>
          </>
        ) : (
          <button type="button" className="primary" onClick={run.start}>
            {run.elapsed > 0 ? 'Resume' : 'Start'}
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            run.reset()
            setLaps([])
          }}
        >
          Reset
        </button>
      </div>
      {laps.length > 0 ? (
        <ol className="label-list" reversed>
          {laps.map((lap, index) => (
            <li key={lap}>
              {tenths(lap)}
              {laps[index + 1] != null ? ` · split ${tenths(lap - laps[index + 1]!)}` : ''}
            </li>
          ))}
        </ol>
      ) : null}
    </article>
  )
}

export function WorkoutTimers() {
  return (
    <div className="layout">
      <IntervalTimer />
      <aside className="side">
        <Stopwatch />
      </aside>
    </div>
  )
}
