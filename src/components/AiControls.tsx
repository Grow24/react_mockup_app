import { formatPercent, formatPerformance } from '../format'
import { useAi } from '../vision/context'

function statusLabel(status: string) {
  if (status === 'loading') return 'Loading'
  if (status === 'ready') return 'On'
  if (status === 'error') return 'Error'
  return 'Off'
}

export function AiControls() {
  const ai = useAi()
  const poseReady =
    (ai.latest?.pose.filter((point) => point.visibility >= 0.5).length ?? 0) >= 4

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
        <p className="muted">Starting the models. The first time downloads them and can take a moment.</p>
      ) : null}
      {ai.status === 'ready' && ai.delegate ? (
        <p className="muted">MediaPipe is running on {ai.delegate}.</p>
      ) : null}

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
                <li>{poseReady ? 'Pose landmarks visible' : 'No pose in this frame'}</li>
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
