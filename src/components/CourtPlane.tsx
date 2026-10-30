import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { COURT_PRESETS, type CourtCalibration, type CourtPoint, type CourtPreset } from '../../shared/contracts.ts'
import {
  COURT_AREAS,
  COURT_LANDMARKS,
  courtArea,
  defaultLandmarks,
  LANDMARK_SETS,
  landmarkById,
  landmarksProblem,
} from '../../shared/court.ts'
import { AnnotationCanvas } from './AnnotationCanvas'
import type { AiSnapshot } from '../types'
import { frameRect } from '../vision/draw'
import { renderCourt } from '../vision/opencv'

const ANKLES = [
  { index: 27, label: 'Left ankle' },
  { index: 28, label: 'Right ankle' },
] as const

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
  const [preset, setPreset] = useState<CourtPreset>(owns && saved ? saved.preset : 'tennis-doubles')
  const [points, setPoints] = useState<CourtPoint[]>(owns && saved ? saved.imagePoints : [])
  const [landmarks, setLandmarks] = useState<string[]>(
    owns && saved?.landmarks ? saved.landmarks : defaultLandmarks(owns && saved ? saved.preset : 'tennis-doubles'),
  )
  const [callArea, setCallArea] = useState<string>(courtArea(preset, owns ? saved?.callArea : undefined).id)
  const problem = landmarksProblem(preset, landmarks)
  const setId = LANDMARK_SETS[preset].find((set) => set.landmarks.join() === landmarks.join())?.id ?? 'custom'
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const node = imageRef.current
    if (node?.complete && node.naturalWidth > 0) setImage(node)
  }, [imageUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!image || points.length !== 4 || !canvas) {
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
    renderCourt(image, canvas, { preset, landmarks, imagePoints: points }, sourceWidth, sourceHeight, markers, () => current)
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
  }, [image, points, preset, landmarks, snapshot, sourceWidth, sourceHeight])

  function publish(
    nextPoints: CourtPoint[],
    next: { preset?: CourtPreset; landmarks?: string[]; callArea?: string } = {},
  ) {
    const nextPreset = next.preset ?? preset
    const nextLandmarks = next.landmarks ?? landmarks
    if (nextPoints.length !== 4 || landmarksProblem(nextPreset, nextLandmarks)) return
    const court: CourtCalibration = {
      preset: nextPreset,
      assetId,
      sourceWidth,
      sourceHeight,
      imagePoints: nextPoints,
      callArea: next.callArea ?? callArea,
    }
    if (nextLandmarks.join() !== defaultLandmarks(nextPreset).join()) court.landmarks = nextLandmarks
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
    if (!image || points.length >= 4 || problem) return
    const bounds = frameRect(image.clientWidth, image.clientHeight, sourceWidth, sourceHeight)
    const rect = image.getBoundingClientRect()
    const x = event.clientX - rect.left - bounds.x
    const y = event.clientY - rect.top - bounds.y
    if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return
    const next = [...points, { x: (x / bounds.width) * sourceWidth, y: (y / bounds.height) * sourceHeight }]
    setPoints(next)
    if (next.length === 4) publish(next)
  }

  function clearCourt() {
    setPoints([])
    setLines([])
    if (owns) onClear()
  }

  return (
    <div className="still-pose">
      <p className="muted">
        Click four court points this camera can see, in the order below. They do not have to be the outer
        corners: the service line ends or one half of the court work too. OpenCV.js builds the top-down plane.{' '}
        {problem
          ? problem
          : points.length < 4
            ? `Next: ${landmarkById(preset, landmarks[points.length]!)?.label}.`
            : 'All four points are set.'}
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
            My own four points
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
            publish(points, { callArea: event.target.value })
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
        {image
          ? points.map((point, index) => (
              <span
                key={`${index}-${point.x}-${point.y}`}
                className="court-marker"
                style={markerStyle(point, image, sourceWidth, sourceHeight)}
              >
                {index + 1}
              </span>
            ))
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
            if (owns && next.length < 4) onClear()
          }}
        >
          Undo point
        </button>
        <button type="button" className="secondary" onClick={clearCourt}>
          Clear court
        </button>
      </div>
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
      {busy ? <p className="muted">Loading OpenCV.js and flattening the court.</p> : null}
      {points.length === 4 ? <canvas ref={canvasRef} className="court-flat" /> : null}
      {lines.length > 0 ? (
        <ul className="label-list">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {points.length === 4 && !busy && !error && lines.length === 0 ? (
        <p className="muted">No ankles in this capture. The court plane is still saved.</p>
      ) : null}
    </div>
  )
}
