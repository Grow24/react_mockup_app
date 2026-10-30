import { useEffect, useRef, useState } from 'react'
import type { Take } from '../../shared/contracts.ts'
import { createTake, fetchLatestTake } from '../session/api'
import { clockSync, serverNow, syncClock } from '../session/clock'
import type { TakeRecording } from './useCamera'

const POLL_MS = 1000
const MIN_LEFT_MS = 1000

export type TakePhase = 'idle' | 'waiting' | 'recording' | 'saved' | 'error'

// Every phone with a live camera in the session polls for the newest take and starts recording at
// the take's server time, so one press records the same moment everywhere.
export function useSyncedTake({
  sessionId,
  online,
  live,
  recording,
  recordTake,
}: {
  sessionId: string | null
  online: boolean
  live: boolean
  recording: boolean
  recordTake: (take: TakeRecording) => boolean
}) {
  const [phase, setPhase] = useState<TakePhase>('idle')
  const [take, setTake] = useState<Take | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [now, setNow] = useState(() => serverNow())
  const handledRef = useRef<string | null>(null)
  const startTimerRef = useRef<number | null>(null)
  const recordRef = useRef(recordTake)
  const recordingRef = useRef(recording)

  useEffect(() => {
    recordRef.current = recordTake
    recordingRef.current = recording
  })

  useEffect(() => {
    if (!sessionId || !online || !live) return
    let active = true

    const join = (next: Take) => {
      if (handledRef.current === next.id) return
      const stopAt = next.startAt + next.seconds * 1000
      if (stopAt - serverNow() < MIN_LEFT_MS) {
        handledRef.current = next.id
        return
      }
      handledRef.current = next.id
      setTake(next)
      if (recordingRef.current) {
        setPhase('error')
        setMessage('A synced take started while this phone was already recording, so it did not join.')
        return
      }
      setPhase('waiting')
      setMessage(null)
      startTimerRef.current = window.setTimeout(
        () => {
          if (!active) return
          if (recordRef.current({ id: next.id, stopAt })) {
            setPhase('recording')
          } else {
            setPhase('error')
            setMessage('This phone could not start recording the take.')
          }
        },
        Math.max(0, next.startAt - serverNow()),
      )
    }

    const poll = async () => {
      try {
        await syncClock()
        const latest = await fetchLatestTake(sessionId)
        if (active && latest) join(latest)
      } catch (error) {
        console.error(error)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
      if (startTimerRef.current != null) window.clearTimeout(startTimerRef.current)
      startTimerRef.current = null
    }
  }, [sessionId, online, live])

  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'recording') return
    const timer = window.setInterval(() => setNow(serverNow()), 100)
    return () => window.clearInterval(timer)
  }, [phase])

  async function start(seconds: number) {
    if (!sessionId) return
    try {
      setMessage('Scheduling the take on every phone…')
      await syncClock(true)
      const created = await createTake(sessionId, seconds)
      setMessage(null)
      setTake(created)
    } catch (error) {
      setPhase('error')
      setMessage(error instanceof Error ? error.message : 'The take could not be scheduled.')
    }
  }

  const shown: TakePhase = phase === 'recording' && !recording ? 'saved' : phase
  let status = message
  if (!status && shown === 'saved') status = 'Take saved on this phone. Open Results to track the ball on each camera.'
  if (!status && take && phase === 'waiting') {
    status = `Take starts in ${Math.max(0, (take.startAt - now) / 1000).toFixed(1)} s. Hold still.`
  }
  if (!status && take && shown === 'recording') {
    status = `Recording the take · ${Math.max(0, (take.startAt + take.seconds * 1000 - now) / 1000).toFixed(0)} s left`
  }

  const sync = clockSync()
  return {
    phase: shown,
    status,
    busy: shown === 'waiting' || shown === 'recording',
    clock: sync ? Math.round(sync.roundTripMs / 2) : null,
    start: (seconds: number) => void start(seconds),
  }
}
