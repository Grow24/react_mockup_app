import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { CourtCalibration, MotionTrack, PoseTrack } from '../../shared/contracts.ts'
import { motionAt, movedCourt } from '../vision/motion'
import { drawPeople, frameRect } from '../vision/draw'
import {
  feetOnCourt,
  frameAt,
  jointAngles,
  playerName,
  playerPaths,
} from '../vision/players'
import { POSE_FPS_CHOICES, trackPlayers } from '../vision/playerTracker'
import { length, useUnits, xyz, type Units } from '../units'

const FPS_KEY = 'pbmp-pose-fps'

function readFps() {
  try {
    const stored = Number(localStorage.getItem(FPS_KEY))
    return (POSE_FPS_CHOICES as readonly number[]).includes(stored) ? stored : 10
  } catch {
    return 10
  }
}

function fits(track: PoseTrack, court: CourtCalibration | null) {
  return court && Math.abs(court.sourceWidth / court.sourceHeight - track.sourceWidth / track.sourceHeight) / (track.sourceWidth / track.sourceHeight) <= 0.02
    ? court
    : null
}

function angleText(value: number | null) {
  return value == null ? '–' : `${Math.round(value)}°`
}

// What each player is doing at time t: where their feet are on the court and how bent their joints are.
function momentLines(track: PoseTrack, court: CourtCalibration | null, t: number, units: Units) {
  const frame = frameAt(track, t)
  if (!frame || frame.people.length === 0) return [`At ${t.toFixed(2)} s no player is in view.`]
  return frame.people.map((person) => {
    const feet = feetOnCourt(person, court, track.sourceWidth, track.sourceHeight)
    const angles = jointAngles(person)
    const where = feet ? `feet at ${xyz({ ...feet, z: 0 }, units)}` : 'mark the court to place the feet'
    return `${playerName(person.player)} · ${where} · knees L ${angleText(angles.leftKnee)} R ${angleText(angles.rightKnee)} · elbows L ${angleText(angles.leftElbow)} R ${angleText(angles.rightElbow)} · hips L ${angleText(angles.leftHip)} R ${angleText(angles.rightHip)}`
  })
}

export function PoseOverlay({
  videoRef,
  track,
  court,
  motion,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  track: PoseTrack
  court: CourtCalibration | null
  motion: MotionTrack | null
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const units = useUnits()
  const placed = fits(track, court)

  useEffect(() => {
    let frame = 0
    let drawn = ''
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) return
      const key = `${video.clientWidth}x${video.clientHeight}@${video.currentTime}:${units}`
      if (key === drawn) return
      drawn = key
      const bounds = frameRect(video.clientWidth, video.clientHeight, track.sourceWidth, track.sourceHeight)
      const dpr = window.devicePixelRatio || 1
      canvas.style.left = `${video.offsetLeft + bounds.x}px`
      canvas.style.top = `${video.offsetTop + bounds.y}px`
      canvas.style.width = `${bounds.width}px`
      canvas.style.height = `${bounds.height}px`
      canvas.width = Math.max(1, Math.round(bounds.width * dpr))
      canvas.height = Math.max(1, Math.round(bounds.height * dpr))
      const context = canvas.getContext('2d')
      if (!context || bounds.width < 2) return
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      const now = frameAt(track, video.currentTime)
      if (!now) return
      const moved = placed && motion ? motionAt(motion, video.currentTime) : null
      const here = placed && moved ? movedCourt(placed, moved) : placed
      drawPeople(context, now.people, bounds.width / track.sourceWidth, bounds.height / track.sourceHeight, (person) => {
        const feet = feetOnCourt(person, here, track.sourceWidth, track.sourceHeight)
        return `${playerName(person.player)}${feet ? ` · ${xyz(feet, units)}` : ''}`
      })
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [videoRef, track, placed, units, motion])

  return <canvas ref={canvasRef} className="annotation" aria-hidden="true" />
}

type Progress = { done: number; total: number; found: number }

export function PlayersPanel({
  assetId,
  url,
  videoRef,
  track,
  steadyTrack,
  court,
  onSave,
  onClear,
}: {
  assetId: string
  url: string
  videoRef: RefObject<HTMLVideoElement | null>
  track: PoseTrack | null
  // The same track with camera motion taken out, for feet positions and distances.
  steadyTrack?: PoseTrack | null
  court: CourtCalibration | null
  onSave: (track: PoseTrack) => void
  onClear: () => void
}) {
  const units = useUnits()
  const [fps, setFps] = useState(readFps)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const momentRef = useRef<HTMLUListElement | null>(null)
  const measured = steadyTrack ?? track
  const placed = measured ? fits(measured, court) : null
  const summary = useMemo(() => (measured ? playerPaths(measured, placed).summary : null), [measured, placed])

  useEffect(() => () => abortRef.current?.abort(), [])

  // The players' feet and joint angles at the video's time, written straight to the page every frame.
  useEffect(() => {
    if (!measured) return
    let frame = 0
    let shown = ''
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const video = videoRef.current
      const node = momentRef.current
      if (!video || !node) return
      const lines = momentLines(measured, placed, video.currentTime, units)
      const text = lines.join('\n')
      if (text === shown) return
      shown = text
      node.replaceChildren(
        ...lines.map((line) => {
          const item = document.createElement('li')
          item.textContent = line
          return item
        }),
      )
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [measured, placed, videoRef, units])

  async function run() {
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setError(null)
    setProgress(null)
    try {
      const next = await trackPlayers(url, assetId, court, controller.signal, (done, total, found) => setProgress({ done, total, found }), fps)
      onSave(next)
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        console.error(caught)
        setError(caught instanceof Error ? caught.message : 'The players could not be tracked.')
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  return (
    <section className="still-pose ball-panel" aria-label="Players">
      <h4>Players</h4>
      <p className="muted">
        YOLOv8n-pose finds 17 joints on every person in {fps} frames per second of this video and names the players
        by their side of the net. {court ? 'People well off the court, like the umpire, are left out.' : 'Mark the court on a frame from this camera to place their feet in court coordinates.'} The
        first run downloads about 13 MB.
      </p>
      <label className="field">
        <span>Frames per second to read</span>
        <select
          value={fps}
          disabled={running}
          onChange={(event) => {
            const next = Number(event.target.value)
            setFps(next)
            try {
              localStorage.setItem(FPS_KEY, String(next))
            } catch {
              // The choice still applies for this visit.
            }
          }}
        >
          {POSE_FPS_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice} per second
            </option>
          ))}
        </select>
      </label>
      <div className="controls">
        {running ? (
          <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void run()}>
            {track ? 'Track players again' : 'Track players'}
          </button>
        )}
        {track && !running ? (
          <button type="button" className="secondary" onClick={onClear}>
            Remove players
          </button>
        ) : null}
      </div>
      {progress ? (
        <p className="muted" role="status">
          Frame {progress.done} of {progress.total} · players in {progress.found}
        </p>
      ) : null}
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
      {track && summary ? (
        <>
          <ul className="label-list">
            {[...summary.entries()].map(([player, item]) => (
              <li key={player}>
                {playerName(player)}: on court in {item.seen} of {track.frames.length} frames · moved {length(item.meters, units)}
              </li>
            ))}
            {summary.size === 0 ? (
              <li>
                {track.frames.filter((frame) => frame.people.length > 0).length} of {track.frames.length} frames show players
                {placed ? '' : '; mark the court to measure how far they move'}
              </li>
            ) : null}
          </ul>
          <ul ref={momentRef} className="label-list" aria-live="off" />
          <p className="muted">
            Angles are read in the image, so they are true only when the limb faces the camera.
          </p>
        </>
      ) : null}
    </section>
  )
}
