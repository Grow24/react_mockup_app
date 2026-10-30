import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { TrainingBox, TrainingImage, TrainingSplit } from '../../../shared/contracts.ts'
import { classColor } from '../../training/colors'
import { suggestBoxes } from '../../training/suggest'
import type { DetectorModel } from '../../vision/models'
import { detectSource } from '../../vision/onnxDetector'

function overlap(a: TrainingBox, b: TrainingBox) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const shared = width * height
  return shared / (a.width * a.height + b.width * b.height - shared)
}

type Point = { x: number; y: number }

export function Labeler({
  image,
  classes,
  models,
  onChange,
}: {
  image: TrainingImage
  classes: string[]
  models: DetectorModel[]
  onChange: (boxes: TrainingBox[], split: TrainingSplit) => void
}) {
  const imageRef = useRef<HTMLImageElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [start, setStart] = useState<Point | null>(null)
  const [draft, setDraft] = useState<TrainingBox | null>(null)
  const [modelId, setModelId] = useState(models[0]?.id ?? '')
  const [suggesting, setSuggesting] = useState<string | null>(null)
  const boxes = image.boxes

  const toImage = (event: PointerEvent<HTMLDivElement>): Point => {
    const rect = stageRef.current!.getBoundingClientRect()
    return {
      x: Math.min(image.width, Math.max(0, ((event.clientX - rect.left) / rect.width) * image.width)),
      y: Math.min(image.height, Math.max(0, ((event.clientY - rect.top) / rect.height) * image.height)),
    }
  }

  const boxFrom = (a: Point, b: Point): TrainingBox => ({
    classId: active,
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      const digit = Number(event.key)
      if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(9, classes.length)) {
        if (selected != null) {
          onChange(boxes.map((box, index) => (index === selected ? { ...box, classId: digit - 1 } : box)), image.split)
        }
        setActive(digit - 1)
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected != null) {
        event.preventDefault()
        onChange(boxes.filter((_, index) => index !== selected), image.split)
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [boxes, classes.length, image.split, onChange, selected])

  async function suggest() {
    const model = models.find((item) => item.id === modelId)
    const node = imageRef.current
    if (!model || !node) return
    setSuggesting(`Running ${model.builtIn ? 'YOLOv8n' : model.name}…`)
    try {
      let result = null
      while (!result) {
        result = await detectSource(node, image.width, image.height, { model, minScore: 0.25 })
        if (!result) await new Promise((resolve) => window.setTimeout(resolve, 50))
      }
      const found = suggestBoxes(result.detections, classes).filter((box) => boxes.every((old) => overlap(old, box) < 0.5))
      onChange([...boxes, ...found], image.split)
      setSuggesting(found.length ? `Added ${found.length} ${found.length === 1 ? 'box' : 'boxes'}. Check them.` : 'No new box matched these classes.')
    } catch (error) {
      setSuggesting(error instanceof Error ? error.message : 'The model could not run.')
    }
  }

  const shown = draft ? [...boxes, draft] : boxes
  return (
    <div className="labeler">
      <div className="controls class-chips" role="radiogroup" aria-label="Class to draw">
        {classes.map((name, index) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={active === index}
            className={active === index ? 'chip chip-on' : 'chip'}
            style={{ borderColor: classColor(index) }}
            onClick={() => {
              setActive(index)
              if (selected != null) onChange(boxes.map((box, at) => (at === selected ? { ...box, classId: index } : box)), image.split)
            }}
          >
            {index < 9 ? `${index + 1} · ` : ''}
            {name}
          </button>
        ))}
      </div>
      <div className="label-stage" ref={stageRef} style={{ aspectRatio: `${image.width} / ${image.height}` }}>
        <img ref={imageRef} src={image.fileUrl} alt="Frame to label" draggable={false} />
        <div
          className="label-layer"
          aria-label="Drag to draw a box"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).dataset.box) return
            event.currentTarget.setPointerCapture(event.pointerId)
            const point = toImage(event)
            setStart(point)
            setDraft(boxFrom(point, point))
            setSelected(null)
          }}
          onPointerMove={(event) => {
            if (start) setDraft(boxFrom(start, toImage(event)))
          }}
          onPointerUp={(event) => {
            if (!start) return
            const box = boxFrom(start, toImage(event))
            setStart(null)
            setDraft(null)
            if (box.width >= 4 && box.height >= 4) {
              onChange([...boxes, box], image.split)
              setSelected(boxes.length)
            }
          }}
        >
          {shown.map((box, index) => (
            <div
              key={`${index}-${box.x}-${box.y}`}
              data-box="1"
              className={index === selected ? 'label-box label-box-on' : 'label-box'}
              style={{
                left: `${(box.x / image.width) * 100}%`,
                top: `${(box.y / image.height) * 100}%`,
                width: `${(box.width / image.width) * 100}%`,
                height: `${(box.height / image.height) * 100}%`,
                borderColor: classColor(box.classId),
              }}
              onPointerDown={(event) => {
                event.stopPropagation()
                if (index < boxes.length) setSelected(index)
              }}
            >
              <span data-box="1" style={{ background: classColor(box.classId) }}>
                {classes[box.classId] ?? box.classId}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="muted">
        Drag to draw a box for the chosen class. Click a box to pick it, press a number to change its class, or Delete
        to remove it.
      </p>
      <div className="controls">
        <button
          type="button"
          className="secondary"
          disabled={selected == null}
          onClick={() => {
            onChange(boxes.filter((_, index) => index !== selected), image.split)
            setSelected(null)
          }}
        >
          Delete box
        </button>
        <button type="button" className="secondary" onClick={() => onChange(boxes, image.split === 'train' ? 'val' : 'train')}>
          {image.split === 'train' ? 'In training · move to validation' : 'In validation · move to training'}
        </button>
      </div>
      <div className="controls suggest-row">
        <select aria-label="Model for suggestions" value={modelId} onChange={(event) => setModelId(event.target.value)}>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" disabled={!modelId || Boolean(suggesting?.endsWith('…'))} onClick={() => void suggest()}>
          Suggest boxes
        </button>
      </div>
      {suggesting ? <p className="muted" role="status">{suggesting}</p> : null}
    </div>
  )
}
