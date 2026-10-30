import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { TAKE_SECONDS } from '../../shared/contracts.ts'
import { useCamera } from '../camera/useCamera'
import { useSyncedTake } from '../camera/useSyncedTake'
import { AiControls } from '../components/AiControls'
import { AnnotationCanvas } from '../components/AnnotationCanvas'
import { framePath, framePathLabel } from '../camera/webcodecs'
import { formatClock, formatRange, formatSetting } from '../format'
import { useSession } from '../session/context'
import { useAi } from '../vision/context'
import { useLiveAnalysis } from '../vision/useLiveAnalysis'

export function CameraExplorer() {
  const previewRef = useRef<HTMLVideoElement | null>(null)
  const ai = useAi()
  const camera = useCamera(previewRef, ai.readSnapshot)
  const { assets, storageWarning, noteCameras, sessionId, backend } = useSession()
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const [takeSeconds, setTakeSeconds] = useState<number>(TAKE_SECONDS[0])
  useLiveAnalysis(previewRef, camera.status === 'live' && ai.enabled && ai.status === 'ready')
  const latest = assets[0]
  const previewOn = camera.status === 'live' && !camera.busy
  const showOverlay = !previewOn
  const take = useSyncedTake({
    sessionId,
    online: backend === 'online',
    live: previewOn,
    recording: camera.recording,
    recordTake: camera.recordTake,
  })

  useEffect(() => {
    const video = previewRef.current
    if (!video) return
    const sync = () => setFrame({ width: video.videoWidth, height: video.videoHeight })
    sync()
    video.addEventListener('loadeddata', sync)
    video.addEventListener('resize', sync)
    return () => {
      video.removeEventListener('loadeddata', sync)
      video.removeEventListener('resize', sync)
    }
  }, [camera.stream])

  useEffect(() => {
    const listed = new Map(camera.cameras.map((item) => [item.deviceId, item.label]))
    if (camera.live?.deviceId) listed.set(camera.live.deviceId, camera.live.label)
    if (listed.size === 0) return
    noteCameras(
      [...listed.entries()].map(([deviceId, label]) => {
        const live = camera.live?.deviceId === deviceId ? camera.live : undefined
        return {
          deviceId,
          label,
          capability: live
            ? {
                width: live.widthRange,
                height: live.heightRange,
                frameRate: live.frameRateRange,
                facingModes: live.facingModes,
              }
            : undefined,
        }
      }),
    )
  }, [camera.cameras, camera.live, noteCameras])

  return (
    <section className="screen">
      <div className="screen-intro">
        <h2>Camera Explorer</h2>
        <p>
          Choose a camera, read the settings this browser exposes, then take a photo or record a
          video. Files are kept in this browser and, when the server is running, in the shared
          session. AI labels and the skeleton appear on the preview only while AI is on.
        </p>
      </div>

      <div className="layout">
        <div className="preview-column">
          <div className="stage">
            <video
              ref={previewRef}
              className={previewOn ? 'is-live' : ''}
              playsInline
              muted
              autoPlay
            />
            {showOverlay ? (
              <div className="stage-copy">
                {camera.busy || camera.status === 'requesting' ? (
                  <p>{camera.notice ?? 'Opening the camera…'}</p>
                ) : null}
                {camera.status === 'idle' ? (
                  <>
                    <p>The preview is off.</p>
                    <button type="button" className="primary" onClick={camera.start}>
                      Enable camera
                    </button>
                  </>
                ) : null}
                {camera.status === 'denied' || camera.status === 'error' ? (
                  <>
                    <p role="alert">{camera.error}</p>
                    <button type="button" className="primary" onClick={camera.start}>
                      Try again
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            <AnnotationCanvas
              frameRef={previewRef}
              sourceWidth={frame.width}
              sourceHeight={frame.height}
              snapshot={previewOn && ai.enabled ? ai.latest : null}
            />
            {camera.recording ? (
              <div className="rec-badge">
                <span className="rec-dot" />
                {formatClock(camera.elapsedMs)}
              </div>
            ) : null}
          </div>

          <div className="controls">
            <button
              type="button"
              className="primary"
              disabled={!previewOn}
              onClick={camera.capturePhoto}
            >
              Capture photo
            </button>
            <button
              type="button"
              className={camera.recording ? 'danger' : 'secondary'}
              disabled={!previewOn}
              onClick={camera.toggleRecording}
            >
              {camera.recording ? 'Stop recording' : 'Start recording'}
            </button>
          </div>
          {camera.captureMessage ? (
            <p className="note" role="status">
              {camera.captureMessage}
            </p>
          ) : null}
          {storageWarning ? (
            <p className="warn" role="alert">
              {storageWarning}
            </p>
          ) : null}

          <article className="card playback">
            <header className="card-head">
              <h3>Latest capture</h3>
              {latest ? <Link to="/results">All results</Link> : null}
            </header>
            {latest ? (
              <figure>
                {latest.kind === 'photo' ? (
                  <img src={latest.url} alt={`Photo from ${latest.cameraLabel}`} />
                ) : (
                  <video src={latest.url} controls playsInline />
                )}
                <figcaption>
                  {latest.kind === 'photo' ? 'JPEG' : 'Video'} · {latest.cameraLabel}
                  {latest.width && latest.height ? ` · ${latest.width}×${latest.height}` : ''}
                </figcaption>
              </figure>
            ) : (
              <p className="muted">Photos and recordings appear here after you capture them.</p>
            )}
          </article>
        </div>

        <aside className="side">
          <article className="card">
            <header className="card-head">
              <h3>Synced take</h3>
            </header>
            <p className="muted">
              Open the session link from the header on a second phone and start its camera. One press
              records on every phone with a live camera, starting at the same server time.
            </p>
            <label className="field">
              <span>Length</span>
              <select
                value={takeSeconds}
                disabled={take.busy}
                onChange={(event) => setTakeSeconds(Number(event.target.value))}
              >
                {TAKE_SECONDS.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds} seconds
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={!previewOn || backend !== 'online' || take.busy || camera.recording}
              onClick={() => take.start(takeSeconds)}
            >
              Start synced take
            </button>
            {take.status ? (
              <p className={take.phase === 'error' ? 'warn' : 'note'} role="status">
                {take.status}
              </p>
            ) : null}
            <p className="muted">
              {backend !== 'online'
                ? 'Synced takes need the server.'
                : take.clock != null
                  ? `This phone's clock is matched to the server within about ${take.clock} ms.`
                  : 'The clock is matched to the server when the camera starts.'}
            </p>
          </article>
          <AiControls />
          <article className="card">
            <header className="card-head">
              <h3>Camera</h3>
            </header>
            <label className="field">
              <span>Input</span>
              <select
                value={camera.selectedId}
                disabled={!previewOn || camera.cameras.length === 0}
                onChange={(event) => void camera.selectCamera(event.target.value)}
              >
                {camera.cameras.length === 0 ? <option value="">No camera yet</option> : null}
                {camera.live &&
                camera.selectedId &&
                !camera.cameras.some((item) => item.deviceId === camera.selectedId) ? (
                  <option value={camera.selectedId}>{camera.live.label}</option>
                ) : null}
                {camera.cameras.map((item) => (
                  <option key={item.deviceId} value={item.deviceId}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {camera.cameras.length > 0
                ? `${camera.cameras.length} camera${camera.cameras.length === 1 ? '' : 's'} visible to this browser.`
                : 'Allow the camera to list devices. Labels stay hidden until permission is granted.'}
            </p>
          </article>

          <article className="card">
            <header className="card-head">
              <h3>Active settings</h3>
            </header>
            <dl className="facts">
              <div>
                <dt>Resolution</dt>
                <dd>
                  {previewOn && camera.live?.width && camera.live.height
                    ? `${camera.live.width}×${camera.live.height}`
                    : 'Not reporting'}
                </dd>
              </div>
              <div>
                <dt>Frame rate</dt>
                <dd>{previewOn ? formatSetting(camera.live?.frameRate, 'fps') : 'Not reporting'}</dd>
              </div>
              <div>
                <dt>Facing</dt>
                <dd>{previewOn ? formatSetting(camera.live?.facingMode) : 'Not reporting'}</dd>
              </div>
              <div>
                <dt>Still frames</dt>
                <dd>{framePathLabel(framePath())}</dd>
              </div>
            </dl>
          </article>

          <article className="card">
            <header className="card-head">
              <h3>Supported ranges</h3>
            </header>
            <dl className="facts">
              <div>
                <dt>Width</dt>
                <dd>{formatRange(camera.live?.widthRange, 'px')}</dd>
              </div>
              <div>
                <dt>Height</dt>
                <dd>{formatRange(camera.live?.heightRange, 'px')}</dd>
              </div>
              <div>
                <dt>Frame rate</dt>
                <dd>{formatRange(camera.live?.frameRateRange, 'fps')}</dd>
              </div>
              <div>
                <dt>Facing modes</dt>
                <dd>
                  {camera.live?.facingModes && camera.live.facingModes.length > 0
                    ? camera.live.facingModes.join(', ')
                    : 'Not exposed by this browser'}
                </dd>
              </div>
            </dl>
          </article>
        </aside>
      </div>
    </section>
  )
}
