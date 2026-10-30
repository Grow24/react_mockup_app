import { formatPercent, formatPerformance } from '../format'
import { useSession } from '../session/context'
import { useAi } from '../vision/context'
import { modelChoices } from '../vision/models'
import { onnxBackend } from '../vision/onnxDetector'
import { OBJECT_MODEL_ID } from '../vision/yolo'
import { playerName } from '../vision/players'
import type { PoseMode } from '../vision/context'

function statusLabel(status: string) {
  if (status === 'loading') return 'Loading'
  if (status === 'ready') return 'On'
  if (status === 'error') return 'Error'
  return 'Off'
}

export function AiControls() {
  const ai = useAi()
  const { models } = useSession()
  const model = ai.objectModel
  const poseReady =
    (ai.latest?.pose.filter((point) => point.visibility >= 0.5).length ?? 0) >= 4 || (ai.latest?.people?.length ?? 0) > 0

  return (
    <article className="card">
      <header className="card-head">
        <h3>AI</h3>
        <span className="pill">{statusLabel(ai.status)}</span>
      </header>
      <p>
        This switch only controls labels and the skeleton. Photo and video capture keep working
        either way.
      </p>
      <div className="controls">
        {ai.status === 'error' ? (
          <button type="button" className="primary" onClick={ai.retry}>
            Try AI again
          </button>
        ) : (
          <button
            type="button"
            className={ai.enabled ? 'secondary' : 'primary'}
            aria-pressed={ai.enabled}
            onClick={() => ai.setEnabled(!ai.enabled)}
          >
            {ai.status === 'loading' ? 'Cancel loading' : ai.enabled ? 'Turn AI off' : 'Turn AI on'}
          </button>
        )}
      </div>
      {ai.error ? (
        <p className="warn" role="alert">
          {ai.error}
        </p>
      ) : null}
      {ai.status === 'loading' ? (
        <p className="muted">
          {model
            ? `Downloading ${model.builtIn ? 'YOLOv8n. The first time is about 12 MB' : model.name}. Capture still works.`
            : 'Starting the models. The first time downloads them and can take a moment.'}
        </p>
      ) : null}
      {ai.status === 'ready' && model ? (
        <p className="muted">
          {model.builtIn ? 'YOLOv8n' : model.name} is running in a worker
          {onnxBackend() ? (onnxBackend()!.name === 'webgpu' ? ' on WebGPU' : ` on WASM ×${onnxBackend()!.threads}`) : ''}. Pose
          still uses MediaPipe{ai.delegate ? ` on ${ai.delegate}` : ''}.
        </p>
      ) : null}
      {ai.status === 'ready' && ai.objectDetector === OBJECT_MODEL_ID && ai.delegate ? (
        <p className="muted">MediaPipe is running on {ai.delegate}.</p>
      ) : null}

      <label className="field">
        <span>Object model</span>
        <select
          value={ai.objectDetector}
          onChange={(event) => ai.setObjectDetector(event.target.value)}
        >
          <option value={OBJECT_MODEL_ID}>MediaPipe EfficientDet</option>
          {modelChoices(models).map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.builtIn ? 'ONNX YOLOv8n, COCO classes' : `${choice.name} (custom)`}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        Every model draws the same kind of boxes, with its own class names. Add your own model below.
      </p>

      <label className="field">
        <span>Pose model</span>
        <select value={ai.poseMode} onChange={(event) => ai.setPoseMode(event.target.value as PoseMode)}>
          <option value="single">MediaPipe: one person, with a 3D pose</option>
          <option value="people">YOLOv8n-pose: every person, players named</option>
        </select>
      </label>
      <p className="muted">
        {ai.poseMode === 'people'
          ? 'YOLOv8n-pose finds 17 joints on everyone in view (about 13 MB the first time). With the court marked for this phone, the near and far players are named and people off the court are left out.'
          : 'MediaPipe follows one person with 33 points and a 3D pose.'}
      </p>

      <label className="field">
        <span>Confidence {formatPercent(ai.confidence)}</span>
        <input
          type="range"
          min={0.3}
          max={0.9}
          step={0.05}
          value={ai.confidence}
          disabled={!ai.enabled}
          onChange={(event) => ai.setConfidence(Number(event.target.value))}
        />
      </label>
      <p className="muted">Labels below this score stay hidden. The skeleton uses its own visibility check.</p>

      <div aria-live="polite">
        {ai.enabled && ai.latest ? (
          <>
            <p className="muted">
              Last pass {Math.round(ai.latest.inferenceMs)} ms.
              {ai.latest.performance ? ` ${formatPerformance(ai.latest.performance)}.` : ''}
            </p>
            {ai.latest.detections.length === 0 && !poseReady ? (
              <p className="muted">No object above the confidence line, and no pose yet.</p>
            ) : (
              <ul className="label-list">
                {ai.latest.detections.map((detection) => (
                  <li key={`${detection.label}-${detection.box.x}-${detection.box.y}`}>
                    {detection.label} {formatPercent(detection.score)}
                  </li>
                ))}
                {ai.latest.people?.length ? (
                  ai.latest.people.map((person, index) => <li key={person.player ?? index}>{playerName(person.player)} found</li>)
                ) : (
                  <li>{poseReady ? 'Pose landmarks visible' : 'No pose in this frame'}</li>
                )}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">
            {ai.enabled
              ? 'Open the camera preview to see live labels and the skeleton.'
              : 'Turn AI on, then open the camera. Capture does not wait for it.'}
          </p>
        )}
      </div>
    </article>
  )
}
