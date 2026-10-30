import { useEffect, useRef, useState, type RefObject } from 'react'
import type { BallPoint, BallTrack, CourtCalibration, CourtPoint, MotionTrack } from '../../shared/contracts.ts'
import { courtArea, courtLines } from '../../shared/court.ts'
import { BallFlight } from './BallFlight'
import { BallModelSelect } from './BallModelSelect'
import { useBallModel } from '../vision/useBallModel'
import { courtFitsTrack, groundPoints, pointAt, trailAt } from '../vision/ball'
import { BALL_FPS_CHOICES, BALL_SAMPLE_FPS, trackBall } from '../vision/ballTracker'
import { courtMeters, courtPixelSize, mapPixel } from '../vision/court'
import { applyHomography, motionAt, type Homography } from '../vision/motion'
import { flightAt, lineCall, positionAt, projectPoint, type FlightFit } from '../vision/flight'
import { sharedFlightFit } from '../vision/flightFit'
import { frameRect } from '../vision/draw'
import { projectToCourt } from '../vision/opencv'
import { length, useUnits, xyz, type Units } from '../units'

const FPS_KEY = 'pbmp-ball-fps'

function readFps() {
  try {
    const stored = Number(localStorage.getItem(FPS_KEY))
    return (BALL_FPS_CHOICES as readonly number[]).includes(stored) ? stored : BALL_SAMPLE_FPS
  } catch {
    return BALL_SAMPLE_FPS
  }
}

const GAP_SECONDS = 0.4
const MAP_PAD = 16

// track is what the camera saw, for the trail; steadyTrack is the same ball with any camera motion
// taken out, for the 3D fit, which is then drawn back into the moving frame.
export function BallOverlay({
  videoRef,
  track,
  steadyTrack,
  court,
  motion,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  track: BallTrack
  steadyTrack: BallTrack
  court: CourtCalibration | null
  motion: MotionTrack | null
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const units = useUnits()
  const usable = court && courtFitsTrack(track, court) ? court : null
  const [fit, setFit] = useState<{ court: CourtCalibration; fit: FlightFit | null } | null>(null)

  useEffect(() => {
    if (!usable) return
    let current = true
    sharedFlightFit(steadyTrack, usable)
      .then((next) => {
        if (current) setFit({ court: usable, fit: next })
      })
      .catch((caught) => console.error(caught))
    return () => {
      current = false
    }
  }, [steadyTrack, usable])

  useEffect(() => {
    let frame = 0
    let drawn = ''
    const fitted = fit && fit.court === usable ? fit.fit : null
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
      const sx = bounds.width / track.sourceWidth
      const sy = bounds.height / track.sourceHeight
      const trail = trailAt(track.points, video.currentTime)
      context.lineWidth = 3
      context.lineCap = 'round'
      for (let index = 1; index < trail.length; index += 1) {
        const from = trail[index - 1]!
        const to = trail[index]!
        if (to.t - from.t > GAP_SECONDS) continue
        context.strokeStyle = `rgba(243, 211, 138, ${0.25 + (0.75 * index) / trail.length})`
        context.beginPath()
        context.moveTo(from.x * sx, from.y * sy)
        context.lineTo(to.x * sx, to.y * sy)
        context.stroke()
      }
      for (const point of trail) {
        if (!point.bounce) continue
        context.fillStyle = '#e0603c'
        context.beginPath()
        context.arc(point.x * sx, (point.y + point.radius) * sy, 5, 0, Math.PI * 2)
        context.fill()
      }
      const current = pointAt(track.points, video.currentTime, 1 / track.sampleFps)
      if (current) {
        context.strokeStyle = '#f3d38a'
        context.beginPath()
        context.arc(current.x * sx, current.y * sy, Math.max(7, current.radius * sx + 4), 0, Math.PI * 2)
        context.stroke()
      }
      if (usable && fitted) {
        const moved = motion ? motionAt(motion, video.currentTime) : null
        drawHeight(context, usable, fitted, video.currentTime, bounds.width, bounds.height, units, moved)
      }
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [videoRef, track, usable, fit, units, motion])

  return <canvas ref={canvasRef} className="annotation" aria-hidden="true" />
}

// The ball's fitted 3D spot, a line down to its shadow on the court, and its court coordinates.
function drawHeight(
  context: CanvasRenderingContext2D,
  court: CourtCalibration,
  fit: FlightFit,
  t: number,
  width: number,
  height: number,
  units: Units,
  moved: Homography | null,
) {
  const flight = flightAt(fit, t)
  if (!flight) return
  const p = positionAt(flight, Math.min(flight.to, Math.max(flight.from, t)))
  const inFrame = (point: { x: number; y: number } | null) => (point && moved ? applyHomography(moved, point) : point)
  const ball = inFrame(projectPoint(fit.camera, p))
  const shadow = inFrame(projectPoint(fit.camera, { x: p.x, y: p.y, z: 0 }))
  if (!ball || !shadow) return
  const kx = width / court.sourceWidth
  const ky = height / court.sourceHeight
  context.save()
  context.setLineDash([4, 4])
  context.strokeStyle = 'rgba(255, 253, 249, 0.8)'
  context.lineWidth = 1.5
  context.beginPath()
  context.moveTo(ball.x * kx, ball.y * ky)
  context.lineTo(shadow.x * kx, shadow.y * ky)
  context.stroke()
  context.setLineDash([])
  context.fillStyle = 'rgba(22, 19, 16, 0.55)'
  context.beginPath()
  context.ellipse(shadow.x * kx, shadow.y * ky, 6, 3, 0, 0, Math.PI * 2)
  context.fill()
  const label = xyz(p, units)
  context.font = '700 12px "Avenir Next", "Segoe UI", sans-serif'
  const textWidth = context.measureText(label).width
  const x = Math.min(width - textWidth - 6, Math.max(4, ball.x * kx + 12))
  const y = Math.max(16, ball.y * ky - 10)
  context.fillStyle = 'rgba(22, 19, 16, 0.75)'
  context.fillRect(x - 4, y - 13, textWidth + 8, 18)
  context.fillStyle = '#f3d38a'
  context.fillText(label, x, y)
  context.restore()
}

function insideMap(point: CourtPoint, width: number, height: number) {
  return point.x > -width * 0.5 && point.x < width * 1.5 && point.y > -height * 0.5 && point.y < height * 1.5
}

function drawCourtLines(context: CanvasRenderingContext2D, court: Pick<CourtCalibration, 'preset' | 'callArea'>) {
  const preset = court.preset
  const size = courtPixelSize(preset)
  context.fillStyle = '#2e6b4a'
  context.fillRect(0, 0, size.width, size.height)
  const area = courtArea(preset, court.callArea)
  const corner = mapPixel(preset, { x: area.x0, y: area.y1 })
  const far = mapPixel(preset, { x: area.x1, y: area.y0 })
  context.fillStyle = 'rgba(127, 216, 207, 0.22)'
  context.fillRect(corner.x, corner.y, far.x - corner.x, far.y - corner.y)
  context.strokeStyle = '#f6f1ea'
  context.lineWidth = 2
  for (const line of courtLines(preset)) {
    const from = mapPixel(preset, line.from)
    const to = mapPixel(preset, line.to)
    context.setLineDash(line.dashed ? [6, 6] : [])
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
  }
  context.setLineDash([])
}

function drawCourtMap(
  canvas: HTMLCanvasElement,
  court: CourtCalibration,
  points: BallPoint[],
  flat: CourtPoint[],
) {
  const size = courtPixelSize(court.preset)
  canvas.width = size.width + MAP_PAD * 2
  canvas.height = size.height + MAP_PAD * 2
  const context = canvas.getContext('2d')
  if (!context) return
  context.fillStyle = '#161310'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.translate(MAP_PAD, MAP_PAD)
  drawCourtLines(context, court)

  context.strokeStyle = 'rgba(243, 211, 138, 0.55)'
  context.lineWidth = 2
  for (let index = 1; index < points.length; index += 1) {
    const from = flat[index - 1]!
    const to = flat[index]!
    if (points[index]!.t - points[index - 1]!.t > GAP_SECONDS) continue
    if (!insideMap(from, size.width, size.height) || !insideMap(to, size.width, size.height)) continue
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
  }

  let number = 0
  context.font = '700 11px "Avenir Next", "Segoe UI", sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  points.forEach((point, index) => {
    if (!point.bounce) return
    number += 1
    const spot = flat[index]!
    if (!insideMap(spot, size.width, size.height)) return
    context.fillStyle = '#f3d38a'
    context.beginPath()
    context.arc(spot.x, spot.y, 8, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#241c12'
    context.fillText(String(number), spot.x, spot.y + 0.5)
  })
}

function BallCourtMap({ track, court }: { track: BallTrack; court: CourtCalibration }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const units = useUnits()
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let current = true
    projectToCourt(court, groundPoints(track, court))
      .then((flat) => {
        if (!current) return
        drawCourtMap(canvas, court, track.points, flat)
        const next: string[] = []
        track.points.forEach((point, index) => {
          if (!point.bounce) return
          const meters = courtMeters(court.preset, flat[index]!)
          const call = lineCall(court.preset, { x: meters.fromLeft, y: meters.fromNear }, court.callArea)
          next.push(
            `Bounce ${next.length + 1} at ${point.t.toFixed(1)} s: ${call.toUpperCase()} · ${length(meters.fromLeft, units)} from the left line, ${length(meters.fromNear, units)} from the near line`,
          )
        })
        setLines(next)
        setError(null)
      })
      .catch((caught) => {
        if (!current) return
        console.error(caught)
        setError(caught instanceof Error ? caught.message : 'OpenCV.js could not place the ball on the court.')
      })
    return () => {
      current = false
    }
  }, [track, court, units])

  return (
    <div className="still-pose">
      <p className="muted">
        Top-down court. The faint line is the ball&apos;s path as if it were on the ground, so only the
        numbered bounces are true court positions. Calls are for the shaded area:{' '}
        {courtArea(court.preset, court.callArea).label.toLowerCase()}.
      </p>
      <canvas ref={canvasRef} className="court-flat" aria-label="Ball path on the court" />
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
      {lines.length > 0 ? (
        <ul className="label-list">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

type Progress = { done: number; total: number; found: number }

export function BallPanel({
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
  track: BallTrack | null
  // The same track with camera motion taken out, used for the court map and the 3D flight.
  steadyTrack?: BallTrack | null
  court: CourtCalibration | null
  onSave: (track: BallTrack) => void
  onClear: () => void
}) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const ballModel = useBallModel()
  const [fps, setFps] = useState(readFps)
  const abortRef = useRef<AbortController | null>(null)
  const running = progress !== null

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  function start() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setMessage(null)
    setFailed(false)
    setProgress({ done: 0, total: 0, found: 0 })
    trackBall(
      url,
      assetId,
      controller.signal,
      (done, total, found) => {
        if (!controller.signal.aborted) setProgress({ done, total, found })
      },
      ballModel.model,
      fps,
    )
      .then((next) => {
        if (controller.signal.aborted) return
        onSave(next)
        setMessage(
          next.points.length === 0
            ? 'No ball was found. Try a video where the ball is larger and not blurred.'
            : null,
        )
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          setMessage('Ball tracking was stopped. Nothing was saved.')
          return
        }
        console.error(caught)
        setFailed(true)
        setMessage(caught instanceof Error ? caught.message : 'Ball tracking failed.')
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null
        setProgress(null)
      })
  }

  function stop() {
    abortRef.current?.abort()
  }

  const bounces = track?.points.filter((point) => point.bounce) ?? []

  return (
    <section className="still-pose ball-panel" aria-label="Ball tracking">
      <h4>Ball tracking</h4>
      <p className="muted">
        {ballModel.model.builtIn
          ? `YOLOv8n looks for a sports ball in ${fps} frames per second of this video and links the hits into one path. The first run downloads about 12 MB.`
          : `${ballModel.model.name} looks for ${ballModel.model.ballClasses.map((index) => ballModel.model.labels[index]).join(', ') || 'a ball'} in ${fps} frames per second of this video and links the hits into one path.`}
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
          {BALL_FPS_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice} per second{choice === BALL_SAMPLE_FPS ? ', quickest' : choice === 30 ? ', most 3D points for fast shots' : ''}
            </option>
          ))}
        </select>
      </label>
      {ballModel.choices.length > 1 ? (
        <BallModelSelect
          model={ballModel.model}
          choices={ballModel.choices}
          onChange={ballModel.choose}
          disabled={running}
        />
      ) : null}
      <div className="controls">
        {running ? (
          <button type="button" className="secondary" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="primary" onClick={start}>
            {track ? 'Track again' : 'Track the ball'}
          </button>
        )}
        {track && !running ? (
          <button type="button" className="secondary" onClick={onClear}>
            Remove track
          </button>
        ) : null}
      </div>
      {progress ? (
        <p className="muted" role="status">
          {progress.total === 0
            ? 'Loading YOLOv8n and opening the video.'
            : `Reading frame ${progress.done} of ${progress.total} · ball seen in ${progress.found}`}
        </p>
      ) : null}
      {message ? (
        <p className={failed ? 'warn' : 'note'} role={failed ? 'alert' : 'status'}>
          {message}
        </p>
      ) : null}
      {track && !running ? (
        <>
          <p className="muted">
            Ball in {track.points.length} of {Math.floor(track.duration * track.sampleFps) + 1} frames ·{' '}
            {bounces.length === 1 ? '1 bounce' : `${bounces.length} bounces`}. Play the video to see the
            trail.
          </p>
          {track.live ? (
            <p className="muted">
              Tracked live at about {track.sampleFps} checks per second while recording. Track again to read{' '}
              {fps} frames per second.
            </p>
          ) : null}
          {bounces.length > 0 ? (
            <div className="controls">
              {bounces.map((point, index) => (
                <button
                  key={point.t}
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const video = videoRef.current
                    if (!video) return
                    video.pause()
                    video.currentTime = point.t
                  }}
                >
                  Bounce {index + 1} · {point.t.toFixed(1)} s
                </button>
              ))}
            </div>
          ) : null}
          {!court ? (
            <p className="muted">
              To see the path in meters, press Save this frame, open the new photo, and click its four
              court corners.
            </p>
          ) : !courtFitsTrack(track, court) ? (
            <p className="muted">
              The court was marked on a {court.sourceWidth}×{court.sourceHeight} photo, which is a different
              shape from this video. Save a frame from this video and mark the court on it.
            </p>
          ) : (
            <>
              <BallCourtMap track={steadyTrack ?? track} court={court} />
              <BallFlight track={steadyTrack ?? track} court={court} videoRef={videoRef} />
            </>
          )}
        </>
      ) : null}
    </section>
  )
}
