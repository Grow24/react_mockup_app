import { useState, type ChangeEvent } from 'react'
import type { CustomModel } from '../../shared/contracts.ts'
import { MAX_MODEL_BYTES } from '../../shared/contracts.ts'
import { fetchModelBytes } from '../session/api'
import { useSession } from '../session/context'
import { classCountFrom, readOnnxMeta } from '../vision/onnxMeta'

type Draft = {
  modelId: string | null
  bytes: ArrayBuffer | null
  name: string
  inputSize: number
  labels: string
  ballClasses: number[]
  classCount: number
  note: string | null
}

function splitLabels(text: string) {
  return text
    .split(/[,\n]/)
    .map((label) => label.trim())
    .filter(Boolean)
}

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function draftFrom(bytes: ArrayBuffer, name: string): Draft {
  const meta = readOnnxMeta(bytes)
  const count = classCountFrom(meta) ?? meta.names?.length ?? 1
  const labels = Array.from({ length: count }, (_, index) => meta.names?.[index] ?? `class ${index}`)
  const size = meta.inputSize ?? 640
  return {
    modelId: null,
    bytes,
    name,
    inputSize: size,
    labels: labels.join(', '),
    ballClasses: labels.flatMap((label, index) => (/ball/i.test(label) ? [index] : [])),
    classCount: count,
    note: `Found ${count} ${count === 1 ? 'class' : 'classes'}${meta.names ? '' : ' without names, so name them below'} and a ${size} px input.`,
  }
}

function draftOf(model: CustomModel): Draft {
  return {
    modelId: model.id,
    bytes: null,
    name: model.name,
    inputSize: model.inputSize,
    labels: model.labels.join(', '),
    ballClasses: model.ballClasses,
    classCount: model.labels.length,
    note: null,
  }
}

export function ModelLibrary() {
  const { models, backend, addModel, editModel, removeModel } = useSession()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [link, setLink] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const online = backend === 'online'

  async function open(load: () => Promise<{ bytes: ArrayBuffer; name: string }>, message: string) {
    setError(null)
    setWorking(message)
    try {
      const { bytes, name } = await load()
      if (bytes.byteLength > MAX_MODEL_BYTES) throw new Error('The model is larger than 200 MB.')
      setDraft(draftFrom(bytes, name))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The model could not be read.')
    } finally {
      setWorking(null)
    }
  }

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    void open(async () => ({ bytes: await file.arrayBuffer(), name: file.name.replace(/\.onnx$/i, '') }), 'Reading the model…')
  }

  function fetchLink() {
    const target = link.trim()
    if (!target) return
    const name = decodeURIComponent(target.split(/[?#]/)[0]!.split('/').pop() ?? 'Model').replace(/\.onnx$/i, '')
    void open(async () => ({ bytes: await fetchModelBytes(target), name }), 'Downloading the model through the server…')
  }

  const labels = draft ? splitLabels(draft.labels) : []
  const countMatches = draft ? labels.length === draft.classCount : false
  const sizeValid = draft ? draft.inputSize >= 32 && draft.inputSize <= 2048 && draft.inputSize % 32 === 0 : false

  async function save() {
    if (!draft || !countMatches || !sizeValid) return
    const details = {
      name: draft.name.trim() || 'Custom model',
      inputSize: draft.inputSize,
      labels,
      ballClasses: draft.ballClasses.filter((index) => index < labels.length),
    }
    setError(null)
    setWorking(draft.bytes ? `Saving ${megabytes(draft.bytes.byteLength)} to this session…` : 'Saving…')
    try {
      if (draft.modelId) await editModel(draft.modelId, details)
      else if (draft.bytes) await addModel(details, draft.bytes)
      setDraft(null)
      setLink('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The model could not be saved.')
    } finally {
      setWorking(null)
    }
  }

  async function remove(model: CustomModel) {
    setError(null)
    try {
      await removeModel(model.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The model could not be removed.')
    }
  }

  return (
    <article className="card" aria-label="Custom models">
      <header className="card-head">
        <h3>Custom models</h3>
        <span className="pill">{models.length}</span>
      </header>
      <p className="muted">
        Add a YOLOv8 or YOLOv5 ONNX export, for example a ball or player model trained on Roboflow. It is saved
        in this session, so every phone with the session link can use it for ball tracking and AI labels.
      </p>

      {models.length > 0 ? (
        <ul className="asset-list">
          {models.map((model) => (
            <li key={model.id} className="model-row">
              <div>
                <strong>{model.name}</strong>
                <small className="muted">
                  {' '}
                  · {model.labels.length} {model.labels.length === 1 ? 'class' : 'classes'} · ball:{' '}
                  {model.ballClasses.map((index) => model.labels[index]).join(', ') || 'none picked'} ·{' '}
                  {model.inputSize} px · {megabytes(model.byteLength)}
                </small>
              </div>
              <div className="controls">
                <button type="button" className="secondary" disabled={!online} onClick={() => setDraft(draftOf(model))}>
                  Edit classes
                </button>
                <button type="button" className="text-button" disabled={!online} onClick={() => void remove(model)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {!online ? <p className="muted">Custom models need the server.</p> : null}

      {online && !draft ? (
        <div className="model-add">
          <label className="field">
            <span>ONNX file</span>
            <input type="file" accept=".onnx,application/octet-stream" disabled={Boolean(working)} onChange={pickFile} />
          </label>
          <label className="field">
            <span>Or a link to the .onnx file</span>
            <input
              type="url"
              className="text-input"
              placeholder="https://…/best.onnx"
              value={link}
              disabled={Boolean(working)}
              onChange={(event) => setLink(event.target.value)}
            />
          </label>
          <button type="button" className="secondary" disabled={!link.trim() || Boolean(working)} onClick={fetchLink}>
            Fetch the link
          </button>
        </div>
      ) : null}

      {draft ? (
        <div className="model-add">
          {draft.note ? <p className="note">{draft.note}</p> : null}
          <label className="field">
            <span>Name</span>
            <input
              className="text-input"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Class names, in the model&apos;s order</span>
            <textarea
              className="text-input"
              rows={2}
              value={draft.labels}
              onChange={(event) => setDraft({ ...draft, labels: event.target.value })}
            />
          </label>
          {!countMatches ? (
            <p className="warn" role="alert">
              This model outputs {draft.classCount} {draft.classCount === 1 ? 'class' : 'classes'}, so it needs exactly
              that many names ({labels.length} now).
            </p>
          ) : null}
          <fieldset className="field model-classes">
            <legend>Which classes are the ball</legend>
            {labels.map((label, index) => (
              <label key={`${index}-${label}`}>
                <input
                  type="checkbox"
                  checked={draft.ballClasses.includes(index)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      ballClasses: event.target.checked
                        ? [...draft.ballClasses, index].sort((a, b) => a - b)
                        : draft.ballClasses.filter((item) => item !== index),
                    })
                  }
                />{' '}
                {label}
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>Input size (px)</span>
            <input
              type="number"
              className="text-input"
              min={32}
              max={2048}
              step={32}
              value={draft.inputSize}
              onChange={(event) => setDraft({ ...draft, inputSize: Number(event.target.value) })}
            />
          </label>
          {!sizeValid ? <p className="warn">The input size must be a multiple of 32 between 32 and 2048.</p> : null}
          <div className="controls">
            <button
              type="button"
              className="primary"
              disabled={!countMatches || !sizeValid || Boolean(working)}
              onClick={() => void save()}
            >
              {draft.modelId ? 'Save classes' : 'Save to this session'}
            </button>
            <button type="button" className="secondary" disabled={Boolean(working)} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {working ? (
        <p className="muted" role="status">
          {working}
        </p>
      ) : null}
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  )
}
