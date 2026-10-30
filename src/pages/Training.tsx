import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { TrainingBox, TrainingImage, TrainingSet, TrainingSplit } from '../../shared/contracts.ts'
import { Labeler } from '../components/training/Labeler'
import { classColor } from '../training/colors'
import { useSession } from '../session/context'
import {
  deleteTrainingImage,
  exportUrl,
  fetchTraining,
  saveClasses,
  saveTrainingImage,
  splitFor,
  uploadToRoboflow,
  uploadTrainingImage,
  type RoboflowResult,
} from '../training/api'
import { photoFrame, sampleFrames, type Frame } from '../training/frames'
import { modelChoices } from '../vision/models'

export function Training() {
  const { sessionId, backend, assets, models } = useSession()
  const [set, setSet] = useState<TrainingSet | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [classText, setClassText] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [every, setEvery] = useState(0.5)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [project, setProject] = useState('')
  const [roboflow, setRoboflow] = useState<RoboflowResult | null>(null)
  const saving = useRef(new Map<string, Promise<unknown>>())
  const online = backend === 'online' && sessionId

  useEffect(() => {
    if (!online) return
    let active = true
    fetchTraining(sessionId)
      .then((loaded) => {
        if (!active) return
        setSet(loaded)
        setClassText(loaded.classes.join(', '))
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'The training set could not be opened.'))
    return () => {
      active = false
    }
  }, [online, sessionId])

  const sources = assets.filter((asset) => asset.width && asset.height)
  const source = sources.find((asset) => asset.id === sourceId) ?? sources[0]
  const images = set?.images ?? []
  const selected = images.find((image) => image.id === selectedId) ?? images[0] ?? null
  const choices = useMemo(() => modelChoices(models), [models])

  const updateImage = useCallback((id: string, boxes: TrainingBox[], split: TrainingSplit) => {
    setSet((current) =>
      current ? { ...current, images: current.images.map((image) => (image.id === id ? { ...image, boxes, split } : image)) } : current,
    )
    const previous = saving.current.get(id) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => saveTrainingImage(id, boxes, split))
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'The boxes were not saved.'))
    saving.current.set(id, next)
  }, [])

  async function addFrames(frames: Frame[], sourceAssetId: string, isVideo: boolean) {
    if (!sessionId) return
    const added: TrainingImage[] = []
    for (const [index, frame] of frames.entries()) {
      setWorking(`Saving frame ${index + 1} of ${frames.length}…`)
      const id = crypto.randomUUID()
      added.push(
        await uploadTrainingImage(sessionId, {
          id,
          blob: frame.blob,
          width: frame.width,
          height: frame.height,
          split: splitFor(id),
          sourceAssetId,
          ...(isVideo ? { frameTime: frame.time } : {}),
        }),
      )
    }
    setSet((current) => (current ? { ...current, images: [...current.images, ...added] } : current))
    if (added[0]) setSelectedId(added[0].id)
  }

  async function addSource() {
    if (!source) return
    setError(null)
    try {
      if (source.kind === 'photo') {
        setWorking('Reading the photo…')
        await addFrames([await photoFrame(source.url)], source.id, false)
      } else {
        const frames = await sampleFrames(source.url, every, (done, total) => setWorking(`Reading frame ${done} of ${total}…`))
        await addFrames(frames, source.id, true)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The frames could not be added.')
    } finally {
      setWorking(null)
    }
  }

  async function storeClasses() {
    if (!sessionId) return
    setError(null)
    try {
      const saved = await saveClasses(
        sessionId,
        classText.split(',').map((name) => name.trim()).filter(Boolean),
      )
      setSet(saved)
      setClassText(saved.classes.join(', '))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The classes were not saved.')
    }
  }

  async function sendToRoboflow() {
    if (!sessionId) return
    setError(null)
    setRoboflow(null)
    setWorking('Uploading labeled frames to Roboflow…')
    try {
      await Promise.all(saving.current.values())
      setRoboflow(await uploadToRoboflow(sessionId, apiKey, project))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Roboflow upload failed.')
    } finally {
      setWorking(null)
    }
  }

  if (!online) {
    return (
      <section className="screen">
        <div className="screen-intro">
          <h2>Training</h2>
          <p>Building a training set needs the server, so every phone in the session can label the same frames.</p>
        </div>
      </section>
    )
  }

  const classes = set?.classes ?? []
  const labeled = images.filter((image) => image.boxes.length > 0)
  const counts = classes.map((_, index) => images.reduce((sum, image) => sum + image.boxes.filter((box) => box.classId === index).length, 0))
  const at = selected ? images.indexOf(selected) : -1

  return (
    <section className="screen">
      <div className="screen-intro">
        <h2>Training</h2>
        <p>
          Turn your own footage into a ball or player model. Pick frames, draw boxes, then export a YOLO dataset or send it
          to Roboflow. Train it, and add the exported ONNX file on the <Link to="/ai">AI screen</Link>.
        </p>
      </div>
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}

      <div className="layout">
        <div className="preview-column">
          <article className="card" aria-label="Label a frame">
            <header className="card-head">
              <h3>{selected ? `Frame ${at + 1} of ${images.length}` : 'No frames yet'}</h3>
              {selected ? (
                <div className="controls">
                  <button type="button" className="secondary" disabled={at <= 0} onClick={() => setSelectedId(images[at - 1]!.id)}>
                    Previous
                  </button>
                  <button type="button" className="secondary" disabled={at >= images.length - 1} onClick={() => setSelectedId(images[at + 1]!.id)}>
                    Next
                  </button>
                </div>
              ) : null}
            </header>
            {selected && set ? (
              <>
                <Labeler
                  key={selected.id}
                  image={selected}
                  classes={classes}
                  models={choices}
                  onChange={(boxes, split) => updateImage(selected.id, boxes, split)}
                />
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    void deleteTrainingImage(selected.id).catch(() => undefined)
                    setSet({ ...set, images: images.filter((image) => image.id !== selected.id) })
                    setSelectedId(images[at + 1]?.id ?? images[at - 1]?.id ?? null)
                  }}
                >
                  Remove this frame from the set
                </button>
              </>
            ) : (
              <p className="muted">Add a photo or frames from a video on the right to start labeling.</p>
            )}
          </article>

          {images.length > 0 ? (
            <ul className="thumb-grid" aria-label="Frames in the set">
              {images.map((image, index) => (
                <li key={image.id}>
                  <button
                    type="button"
                    className={image.id === selected?.id ? 'thumb thumb-on' : 'thumb'}
                    aria-label={`Frame ${index + 1}, ${image.boxes.length} boxes`}
                    onClick={() => setSelectedId(image.id)}
                  >
                    <img src={image.fileUrl} alt="" loading="lazy" />
                    <span className={image.boxes.length ? 'thumb-count' : 'thumb-count thumb-empty'}>
                      {image.boxes.length}
                      {image.split === 'val' ? ' · val' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <aside className="side">
          <article className="card" aria-label="Classes">
            <header className="card-head">
              <h3>Classes</h3>
            </header>
            <label className="field">
              <span>Names, separated by commas, in model order</span>
              <input className="text-input" value={classText} onChange={(event) => setClassText(event.target.value)} />
            </label>
            <button type="button" className="secondary" onClick={() => void storeClasses()}>
              Save classes
            </button>
            {classes.length > 0 ? (
              <ul className="label-list">
                {classes.map((name, index) => (
                  <li key={name}>
                    <span className="swatch" style={{ background: classColor(index) }} /> {name}: {counts[index]}{' '}
                    {counts[index] === 1 ? 'box' : 'boxes'}
                  </li>
                ))}
              </ul>
            ) : null}
          </article>

          <article className="card" aria-label="Add frames">
            <header className="card-head">
              <h3>Add frames</h3>
            </header>
            {sources.length === 0 ? (
              <p className="muted">Take photos or record a video on the Camera screen first.</p>
            ) : (
              <>
                <label className="field">
                  <span>From</span>
                  <select value={source?.id ?? ''} onChange={(event) => setSourceId(event.target.value)}>
                    {sources.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.kind === 'photo' ? 'Photo' : 'Video'} · {asset.cameraLabel} ·{' '}
                        {new Date(asset.createdAt).toLocaleTimeString()}
                      </option>
                    ))}
                  </select>
                </label>
                {source?.kind === 'video' ? (
                  <label className="field">
                    <span>One frame every (seconds)</span>
                    <input
                      className="text-input"
                      type="number"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={every}
                      onChange={(event) => setEvery(Math.max(0.1, Number(event.target.value) || 0.5))}
                    />
                  </label>
                ) : null}
                <button type="button" className="primary" disabled={Boolean(working)} onClick={() => void addSource()}>
                  {source?.kind === 'video' ? 'Add frames from this video' : 'Add this photo'}
                </button>
              </>
            )}
            {working ? (
              <p className="muted" role="status">
                {working}
              </p>
            ) : null}
          </article>

          <article className="card" aria-label="Export">
            <header className="card-head">
              <h3>Export and train</h3>
            </header>
            <p className="muted">
              {images.length} frames · {labeled.length} labeled · {images.filter((image) => image.split === 'val').length} for
              validation
            </p>
            <div className="controls">
              <a className="primary link-button" href={exportUrl(sessionId, true)} download>
                Download YOLO dataset
              </a>
              <a className="secondary link-button" href={exportUrl(sessionId, false)} download>
                With empty frames
              </a>
            </div>
            <ol className="label-list">
              <li>Unzip it and run <code>pip install ultralytics</code>, then <code>python train.py</code>.</li>
              <li>It trains YOLOv8n and exports <code>best.onnx</code>.</li>
              <li>
                Add that file on the <Link to="/ai">AI screen</Link> under Custom models.
              </li>
            </ol>
            <h4 className="sub-head">Or send it to Roboflow</h4>
            <label className="field">
              <span>Roboflow API key</span>
              <input className="text-input" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            </label>
            <label className="field">
              <span>Project id, from the project URL</span>
              <input className="text-input" placeholder="tennis-balls" value={project} onChange={(event) => setProject(event.target.value)} />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={!apiKey.trim() || !project.trim() || labeled.length === 0 || Boolean(working)}
              onClick={() => void sendToRoboflow()}
            >
              Upload {labeled.length} labeled {labeled.length === 1 ? 'frame' : 'frames'}
            </button>
            <p className="muted">The key is sent once to this server for the upload and is not stored.</p>
            {roboflow ? (
              <p className={roboflow.failed.length ? 'warn' : 'note'} role="status">
                {roboflow.uploaded} uploaded with boxes
                {roboflow.failed.length ? `, ${roboflow.failed.length} failed: ${roboflow.failed[0]!.error}` : '.'}
              </p>
            ) : null}
          </article>
        </aside>
      </div>
    </section>
  )
}
