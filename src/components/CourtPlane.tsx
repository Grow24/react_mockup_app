import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { COURT_PRESETS, type CourtCalibration, type CourtPoint, type CourtPreset } from '../../shared/contracts.ts'
import {
  COURT_AREAS,
  COURT_LANDMARKS,
  courtArea,
  completingLandmark,
  defaultLandmarks,
  LANDMARK_SETS,
  landmarkById,
  landmarksProblem,
} from '../../shared/court.ts'
import { AnnotationCanvas } from './AnnotationCanvas'
import { CourtLinesOverlay } from './CourtLinesOverlay'
import type { AiSnapshot } from '../types'
import { cameraText, levelCamera, levelSpread } from '../vision/cameraPose'
import { frameRect } from '../vision/draw'
import { cameraFromCourt, projectPoint } from '../vision/flight'
import { renderCourt } from '../vision/opencv'
import { detectCourt } from '../vision/courtDetect'
import { length, useUnits } from '../units'

const ANKLES = [
  { index: 27, label: 'Left ankle' },
  { index: 28, label: 'Right ankle' },
] as const

type Completed = {
  imagePoints: CourtPoint[]
  landmarks: string[]
  estimated: number
  note: string | null
  warning: string | null
}

// Four clicks are used as they are. Three clicks place a level camera, which then shows where a
// fourth court point is, even outside the photo.
function complete(
  preset: CourtPreset,
  landmarks: string[],
  clicks: CourtPoint[],
  width: number,
  height: number,
): Completed | { error: string } | null {
  if (clicks.length !== landmarks.length) return null
  if (landmarks.length === 4) return { imagePoints: clicks, landmarks, estimated: 0, note: null, warning: null }
  const world = landmarks.map((id) => landmarkById(preset, id)!)
  const fit = levelCamera(world, clicks, width, height)
  const extra = completingLandmark(preset, landmarks)
  if (!fit || !extra) {
    return { error: 'No level camera fits these three points. Check each click, or pick four points.' }
  }
  const at = projectPoint(fit.camera, { x: extra.x, y: extra.y, z: 0 })
  if (!at) return { error: 'The fourth point would be behind the camera. Pick another three points.' }
  const spread = levelSpread(world, clicks, width, height, extra)
  const rival = fit.others
    .map((camera) => projectPoint(camera, { x: extra.x, y: extra.y, z: 0 }))
    .some((other) => !other || Math.hypot(other.x - at.x, other.y - at.y) > 10)
  return {
    imagePoints: [...clicks, { x: at.x, y: at.y }],
    landmarks: [...landmarks, extra.id],
    estimated: 1,
    note: `${extra.label} is estimated from a level phone${
      spread && Number.isFinite(spread.pixels) ? `; it moves about ${spread.pixels.toFixed(0)} px if each click is 1.5 px off` : ''
    }.`,
    warning: rival
      ? 'Two camera positions fit these three points. Check that the drawn lines sit on the court, or click four points.'
      : null,
  }
}

function markerStyle(
  point: CourtPoint,
  image: HTMLImageElement,
  sourceWidth: number,
  sourceHeight: number,
) {
  const bounds = frameRect(image.clientWidth, image.clientHeight, sourceWidth, sourceHeight)
  return {
    left: `${bounds.x + (point.x / sourceWidth) * bounds.width}px`,
    top: `${bounds.y + (point.y / sourceHeight) * bounds.height}px`,
  }
}

export function CourtPlane({
  assetId,
  deviceId,
  imageUrl,
  alt,
  sourceWidth,
  sourceHeight,
  snapshot,
  saved,
  onSave,
  onClear,
}: {
  assetId: string
  deviceId?: string
  imageUrl: string
  alt: string
  sourceWidth: number
  sourceHeight: number
  snapshot?: AiSnapshot
  saved: CourtCalibration | null
  onSave: (court: CourtCalibration) => void
  onClear: () => void
}) {
  const owns = saved?.assetId === assetId
  const imageRef = useRef<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const clicked = owns && saved ? 4 - (saved.estimatedPoints ?? 0) : 4
  const units = useUnits()
  const [preset, setPreset] = useState<CourtPreset>(owns && saved ? saved.preset : 'tennis-doubles')
  const [points, setPoints] = useState<CourtPoint[]>(owns && saved ? saved.imagePoints.slice(0, clicked) : [])
  const [landmarks, setLandmarks] = useState<string[]>(
    (owns && saved?.landmarks ? saved.landmarks : defaultLandmarks(owns && saved ? saved.preset : 'tennis-doubles')).slice(0, clicked),
  )
  const [callArea, setCallArea] = useState<string>(courtArea(preset, owns ? saved?.callArea : undefined).id)
  const problem = landmarksProblem(preset, landmarks, true)
  const setId = LANDMARK_SETS[preset].find((set) => set.landmarks.join() === landmarks.join())?.id ?? 'custom'
  const completed = useMemo(
    () => (problem ? null : complete(preset, landmarks, points, sourceWidth, sourceHeight)),
    [problem, preset, landmarks, points, sourceWidth, sourceHeight],
  )
  const full = completed && !('error' in completed) ? completed : null
  const draft = useMemo<CourtCalibration | null>(
    () =>
      full
        ? { preset, assetId, sourceWidth, sourceHeight, imagePoints: full.imagePoints, landmarks: full.landmarks, estimatedPoints: full.estimated }
        : null,
    [full, preset, assetId, sourceWidth, sourceHeight],
  )
  const camera = useMemo(() => (draft ? cameraFromCourt(draft) : null), [draft])
  const [lines, setLines] = useState<{ label: string; fromLeft: number; fromNear: number }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [finding, setFinding] = useState(false)
  const [found, setFound] = useState<string | null>(null)

  useEffect(() => {
    const node = imageRef.current
    if (node?.complete && node.naturalWidth > 0) setImage(node)
  }, [imageUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!image || !full || !canvas) {
      setLines([])
      return
    }
    let current = true
    setBusy(true)
    setError(null)
    const markers = ANKLES.flatMap((ankle) => {
      const point = snapshot?.pose[ankle.index]
      if (!point || point.visibility < 0.5) return []
      return [{ label: ankle.label, point: { x: point.x * sourceWidth, y: point.y * sourceHeight } }]
    })
    renderCourt(image, canvas, { preset, landmarks: full.landmarks, imagePoints: full.imagePoints }, sourceWidth, sourceHeight, markers, () => current)
      .then((next) => {
        if (!current) return
        setLines(next)
        setBusy(false)
      })
      .catch((caught) => {
        if (!current) return
        console.error(caught)
        setBusy(false)
        setError(caught instanceof Error ? caught.message : 'OpenCV.js could not flatten this photo.')
      })
    return () => {
      current = false
    }
  }, [image, full, preset, snapshot, sourceWidth, sourceHeight])

  function publish(nextPoints: CourtPoint[], nextCallArea = callArea) {
    const done = complete(preset, landmarks, nextPoints, sourceWidth, sourceHeight)
    if (!done || 'error' in done) return
    const court: CourtCalibration = {
      preset,
      assetId,
      sourceWidth,
      sourceHeight,
      imagePoints: done.imagePoints,
      callArea: nextCallArea,
    }
    if (done.landmarks.join() !== defaultLandmarks(preset).join()) court.landmarks = done.landmarks
    if (done.estimated) court.estimatedPoints = done.estimated
    if (deviceId) court.deviceId = deviceId
    onSave(court)
  }

  // Changing which point a click means makes the clicks so far meaningless.
  function chooseLandmarks(next: string[]) {
    setLandmarks(next)
    if (points.length === 0) return
    setPoints([])
    setLines([])
    if (owns) onClear()
  }

  function clickImage(event: MouseEvent<HTMLImageElement>) {
    if (!image || points.length >= landmarks.length || problem) return
    const bounds = frameRect(image.clientWidth, image.clientHeight, sourceWidth, sourceHeight)
    const rect = image.getBoundingClientRect()
    const x = event.clientX - rect.left - bounds.x
    const y = event.clientY - rect.top - bounds.y
    if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return
    const next = [...points, { x: (x / bounds.width) * sourceWidth, y: (y / bounds.height) * sourceHeight }]
    setPoints(next)
    if (next.length === landmarks.length) publish(next)
  }

  async function findCourt() {
    if (!image) return
    setFinding(true)
    setFound(null)
    try {
      const detected = await detectCourt(image, sourceWidth, sourceHeight)
      if (!detected) {
        setFound('No tennis court was found in this photo. Click the court points instead.')
        return
      }
      setLandmarks(detected.landmarks)
      setPoints(detected.imagePoints)
      const done = complete(preset, detected.landmarks, detected.imagePoints, sourceWidth, sourceHeight)
      if (done && !('error' in done)) {
        const court: CourtCalibration = { preset, assetId, sourceWidth, sourceHeight, imagePoints: done.imagePoints, callArea }
        if (done.landmarks.join() !== defaultLandmarks(preset).join()) court.landmarks = done.landmarks
        if (deviceId) court.deviceId = deviceId
        onSave(court)
      }
      setFound(
        `Court found: ${Math.round(detected.hitRate * 100)}% of its lines sit on painted lines. Check that the drawn lines match the court; Clear court to mark it by hand.`,
      )
    } catch (caught) {
      console.error(caught)
      setFound(caught instanceof Error ? caught.message : 'The court could not be found.')
    } finally {
      setFinding(false)
    }
  }

  function clearCourt() {
    setPoints([])
    setLines([])
    if (owns) onClear()
  }

  return (
    <div className="still-pose">
      <p className="muted">
        Click court points this camera can see, in the order below. Four points can be any that span the
        court, like the service line ends or one half. With the phone held level, three corners are enough and
        the rest of the court is worked out, even outside the photo. OpenCV.js builds the top-down plane.{' '}
        {problem
          ? problem
          : points.length < landmarks.length
            ? `Next: ${landmarkById(preset, landmarks[points.length]!)?.label}.`
            : 'All points are set.'}
      </p>
      {saved && !owns ? (
        <p className="muted">
          The court for this camera was marked on another photo. Mark this photo to replace it.
        </p>
      ) : null}
      <label className="field">
        <span>Court</span>
        <select
          value={preset}
          onChange={(event) => {
            const next = event.target.value as CourtPreset
            setPreset(next)
            setCallArea(courtArea(next).id)
            chooseLandmarks(defaultLandmarks(next))
          }}
        >
          {Object.entries(COURT_PRESETS).map(([id, spec]) => (
            <option key={id} value={id}>
              {spec.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Points to click</span>
        <select
          value={setId}
          onChange={(event) => {
            const set = LANDMARK_SETS[preset].find((item) => item.id === event.target.value)
            if (set) chooseLandmarks(set.landmarks)
          }}
        >
          {LANDMARK_SETS[preset].map((set) => (
            <option key={set.id} value={set.id}>
              {set.label}
            </option>
          ))}
          <option value="custom" disabled={setId !== 'custom'}>
            My own points
          </option>
        </select>
      </label>
      <details className="field">
        <summary>Choose each point</summary>
        {landmarks.map((id, index) => (
          <label key={index} className="field">
            <span>Point {index + 1}</span>
            <select
              value={id}
              onChange={(event) => {
                const next = landmarks.slice()
                next[index] = event.target.value
                chooseLandmarks(next)
              }}
            >
              {COURT_LANDMARKS[preset].map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </details>
      <label className="field">
        <span>Call bounces for</span>
        <select
          value={callArea}
          onChange={(event) => {
            setCallArea(event.target.value)
            publish(points, event.target.value)
          }}
        >
          {COURT_AREAS[preset].map((area) => (
            <option key={area.id} value={area.id}>
              {area.label}
            </option>
          ))}
        </select>
      </label>
      <div className="annotated court-photo">
        <img
          ref={imageRef}
          src={imageUrl}
          alt={alt}
          onLoad={(event) => setImage(event.currentTarget)}
          onClick={clickImage}
        />
        <AnnotationCanvas
          frameRef={imageRef}
          sourceWidth={sourceWidth}
          sourceHeight={sourceHeight}
          snapshot={snapshot ?? null}
        />
        <CourtLinesOverlay frameRef={imageRef} court={draft} mediaWidth={sourceWidth} mediaHeight={sourceHeight} />
        {image
          ? (full?.imagePoints ?? points).map((point, index) =>
              index >= points.length &&
              (point.x < 0 || point.y < 0 || point.x > sourceWidth || point.y > sourceHeight) ? null : (
                <span
                  key={`${index}-${point.x}-${point.y}`}
                  className={index >= points.length ? 'court-marker estimated' : 'court-marker'}
                  style={markerStyle(point, image, sourceWidth, sourceHeight)}
                  title={index >= points.length ? 'Estimated' : undefined}
                >
                  {index + 1}
                </span>
              ),
            )
          : null}
      </div>
      <div className="controls">
        <button
          type="button"
          className="secondary"
          disabled={points.length === 0}
          onClick={() => {
            const next = points.slice(0, -1)
            setPoints(next)
            if (owns && next.length < landmarks.length) onClear()
          }}
        >
          Undo point
        </button>
        <button type="button" className="secondary" onClick={clearCourt}>
          Clear court
        </button>
        {preset === 'tennis-doubles' ? (
          <button type="button" className="primary" disabled={!image || finding} onClick={() => void findCourt()}>
            {finding ? 'Looking for the court…' : 'Find the court automatically'}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
      {found ? (
        <p className="note" role="status">
          {found}
        </p>
      ) : null}
      {completed && 'error' in completed ? (
        <p className="warn" role="alert">
          {completed.error}
        </p>
      ) : null}
      {full?.warning ? (
        <p className="warn" role="alert">
          {full.warning}
        </p>
      ) : null}
      {full?.note ? <p className="note">{full.note}</p> : null}
      {camera ? (
        <p className="muted">
          {cameraText(camera, units)}. The court origin (0, 0, 0) is where the left doubles sideline meets the
          near baseline: x runs along the baseline, y toward the far baseline, and z up.
        </p>
      ) : null}
      {busy ? <p className="muted">Loading OpenCV.js and flattening the court.</p> : null}
      {full ? <canvas ref={canvasRef} className="court-flat" /> : null}
      {lines.length > 0 ? (
        <ul className="label-list">
          {lines.map((line) => (
            <li key={line.label}>
              {line.label}: {length(line.fromLeft, units)} from the left line, {length(line.fromNear, units)} from the near line
            </li>
          ))}
        </ul>
      ) : null}
      {full && !busy && !error && lines.length === 0 ? (
        <p className="muted">No ankles in this capture. The court plane is still saved.</p>
      ) : null}
    </div>
  )
}
