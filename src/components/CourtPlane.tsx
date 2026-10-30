import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { COURT_PRESETS, type CourtCalibration, type CourtPoint, type CourtPreset } from '../../shared/contracts.ts'
import { AnnotationCanvas } from './AnnotationCanvas'
import type { AiSnapshot } from '../types'
import { CORNER_LABELS } from '../vision/court'
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
    renderCourt(image, canvas, preset, sourceWidth, sourceHeight, points, markers, () => current)
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
  }, [image, points, preset, snapshot, sourceWidth, sourceHeight])

  function publish(nextPoints: CourtPoint[], nextPreset: CourtPreset) {
    const court: CourtCalibration = {
      preset: nextPreset,
      assetId,
      sourceWidth,
      sourceHeight,
      imagePoints: nextPoints,
    }
    if (deviceId) court.deviceId = deviceId
    onSave(court)
  }

  function clickImage(event: MouseEvent<HTMLImageElement>) {
    if (!image || points.length >= 4) return
    const bounds = frameRect(image.clientWidth, image.clientHeight, sourceWidth, sourceHeight)
    const rect = image.getBoundingClientRect()
    const x = event.clientX - rect.left - bounds.x
    const y = event.clientY - rect.top - bounds.y
    if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return
    const next = [...points, { x: (x / bounds.width) * sourceWidth, y: (y / bounds.height) * sourceHeight }]
    setPoints(next)
    if (next.length === 4) publish(next, preset)
  }

  function clearCourt() {
    setPoints([])
    setLines([])
    if (owns) onClear()
  }

  return (
    <div className="still-pose">
      <p className="muted">
        Click the four court corners in order: {CORNER_LABELS.join(', ')}. OpenCV.js builds the top-down
        plane. {points.length < 4 ? `Next: ${CORNER_LABELS[points.length]}.` : 'All four corners are set.'}
      </p>
      {saved && !owns ? (
        <p className="muted">
          Corners for this camera were marked on another photo. Mark this photo to replace them.
        </p>
      ) : null}
      <label className="field">
        <span>Court</span>
        <select
          value={preset}
          onChange={(event) => {
            const next = event.target.value as CourtPreset
            setPreset(next)
            if (points.length === 4) publish(points, next)
          }}
        >
          {Object.entries(COURT_PRESETS).map(([id, spec]) => (
            <option key={id} value={id}>
              {spec.label}
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
          Undo corner
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
