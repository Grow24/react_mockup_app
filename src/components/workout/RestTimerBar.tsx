import { useEffect, useRef, useState } from 'react'
import { beep } from '../../workout/beep'
import { useWorkouts } from '../../workout/context'
import { clock } from '../../workout/intervals'

export function RestTimerBar() {
  const { rest, startRest, stopRest } = useWorkouts()
  const [now, setNow] = useState(() => Date.now())
  const beeped = useRef<number | null>(null)

  useEffect(() => {
    if (!rest) return
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [rest])

  // The last tick can be from before this rest started, so the time left never exceeds the rest itself.
  const left = rest ? Math.min(rest.seconds, (rest.until - now) / 1000) : 0

  useEffect(() => {
    if (!rest) return
    const whole = Math.ceil(left)
    if (whole <= 3 && whole > 0 && beeped.current !== whole) {
      beeped.current = whole
      beep(660, 120)
    }
    if (left <= 0 && beeped.current !== 0) {
      beeped.current = 0
      beep(990, 400, true)
    }
  }, [left, rest])

  if (!rest) return null
  const done = left <= 0
  return (
    <div className={done ? 'rest-bar rest-done' : 'rest-bar'} role="timer" aria-live="polite">
      <div>
        <strong>{done ? 'Rest is over' : clock(left)}</strong>
        <small> · {done ? `Next set of ${rest.label}` : `rest after ${rest.label}`}</small>
      </div>
      <div className="controls">
        {!done ? (
          <button type="button" className="secondary" onClick={() => startRest(Math.max(0, left) + 15, rest.label)}>
            +15 s
          </button>
        ) : null}
        <button type="button" className="secondary" onClick={stopRest}>
          {done ? 'Close' : 'Skip'}
        </button>
      </div>
    </div>
  )
}
