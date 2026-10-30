import { useEffect, useRef, useState, type RefObject } from 'react'
import type { CourtCalibration, MotionTrack } from '../../shared/contracts.ts'
import { drawCourtOverlay } from '../vision/courtOverlay'
import { frameRect } from '../vision/draw'
import { cssMatrix, invertHomography, motionAt, motionSummary, movedCourt, multiplyHomography } from '../vision/motion'
import { trackMotion } from '../vision/motionTracker'

const FPS_CHOICES = [5, 10, 30] as const

// The court lines over the playing video, carried along when the camera moves.
export function VideoCourtOverlay({
  videoRef,
  court,
  motion,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  court: CourtCalibration
  motion: MotionTrack | null
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let frame = 0
    let drawn = ''
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.videoWidth < 2) return
      const key = `${video.clientWidth}x${video.clientHeight}@${motion ? video.currentTime : 0}`
      if (key === drawn) return
      drawn = key
      const bounds = frameRect(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight)
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
      const h = motion ? motionAt(motion, video.currentTime) : null
      const shown = h ? movedCourt(court, h) : court
      drawCourtOverlay(context, shown, bounds.width / court.sourceWidth, bounds.height / court.sourceHeight)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [videoRef, court, motion])

  return <canvas ref={canvasRef} className="annotation" aria-hidden="true" />
}

// Holds the frame still: the video and everything drawn over it are warped back to the court photo's view.
export function SteadyFrame({
  frameRef,
  videoRef,
  court,
  motion,
}: {
  frameRef: RefObject<HTMLElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  court: CourtCalibration
  motion: MotionTrack
}) {
  useEffect(() => {
    const container = frameRef.current
    if (!container) return
    let frame = 0
    const hold = () => {
      frame = requestAnimationFrame(hold)
      const video = videoRef.current
      if (!video || video.videoWidth < 2) return
      const h = motionAt(motion, video.currentTime)
      const back = h ? invertHomography(h) : null
      if (!back) return
      const bounds = frameRect(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight)
      const k = bounds.width / court.sourceWidth
      const ox = video.offsetLeft + bounds.x
      const oy = video.offsetTop + bounds.y
      const toPage = [k, 0, ox, 0, k, oy, 0, 0, 1]
      const fromPage = [1 / k, 0, -ox / k, 0, 1 / k, -oy / k, 0, 0, 1]
      container.style.transformOrigin = '0 0'
      container.style.transform = cssMatrix(multiplyHomography(toPage, multiplyHomography(back, fromPage)))
    }
    frame = requestAnimationFrame(hold)
    return () => {
      cancelAnimationFrame(frame)
      container.style.transform = ''
    }
  }, [frameRef, videoRef, court, motion])

  return null
}

type Progress = { done: number; total: number; trusted: number }

export function MotionPanel({
  assetId,
  url,
  referenceUrl,
  court,
  motion,
  steady,
  onSteady,
  onSave,
  onClear,
}: {
  assetId: string
  url: string
  referenceUrl: string | null
  court: CourtCalibration | null
  motion: MotionTrack | null
  steady: boolean
  onSteady: (steady: boolean) => void
  onSave: (track: MotionTrack) => void
  onClear: () => void
}) {
  const [fps, setFps] = useState(10)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const stale = motion && court && motion.referenceId !== court.assetId
  const summary = motion && !stale ? motionSummary(motion) : null

  useEffect(() => () => abortRef.current?.abort(), [])

  async function run() {
    if (!court || !referenceUrl) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setError(null)
    setProgress(null)
    try {
      onSave(await trackMotion(url, referenceUrl, court, assetId, controller.signal, (done, total, trusted) => setProgress({ done, total, trusted }), fps))
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        console.error(caught)
        setError(caught instanceof Error ? caught.message : 'The camera motion could not be measured.')
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  if (!court || !referenceUrl) {
    return (
      <section className="still-pose ball-panel" aria-label="Camera motion">
        <h4>Camera motion</h4>
        <p className="muted">Mark the court on a photo from this camera first; the motion is measured against that photo.</p>
      </section>
    )
  }

  return (
    <section className="still-pose ball-panel" aria-label="Camera motion">
      <h4>Camera motion</h4>
      <p className="muted">
        Each frame is matched to the court photo with OpenCV (ORB features on the court and around it, RANSAC), so a
        shaking or panning phone still has the court in the right place. Ball and player positions are measured as if the
        camera had stood still, and the video can be held steady.
      </p>
      <label className="field">
        <span>Frames per second to match</span>
        <select value={fps} disabled={running} onChange={(event) => setFps(Number(event.target.value))}>
          {FPS_CHOICES.map((choice) => (
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
            {motion ? 'Measure camera motion again' : 'Measure camera motion'}
          </button>
        )}
        {motion && !running ? (
          <button type="button" className="secondary" onClick={onClear}>
            Remove motion
          </button>
        ) : null}
      </div>
      {progress ? (
        <p className="muted" role="status">
          Frame {progress.done} of {progress.total} · matched {progress.trusted}
        </p>
      ) : null}
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
      {stale ? <p className="warn">The court was marked again on another photo. Measure the motion again.</p> : null}
      {summary ? (
        <>
          <p className="note">
            The view moved up to {summary.shift.toFixed(0)} px and turned up to {summary.turn.toFixed(1)}° · matched in {summary.trusted} of{' '}
            {summary.total} frames
            {summary.trusted < summary.total ? '; the others keep the last good match' : ''}.
          </p>
          <label className="check">
            <input type="checkbox" checked={steady} onChange={(event) => onSteady(event.target.checked)} /> Hold the video steady
          </label>
        </>
      ) : null}
    </section>
  )
}
