import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { TAKE_SECONDS, type BallTrack } from '../../shared/contracts.ts'
import { courtArea } from '../../shared/court.ts'
import { useCamera } from '../camera/useCamera'
import { useSyncedTake } from '../camera/useSyncedTake'
import { AiControls } from '../components/AiControls'
import { AnnotationCanvas } from '../components/AnnotationCanvas'
import { BallModelSelect } from '../components/BallModelSelect'
import { LiveBallOverlay } from '../components/LiveBallOverlay'
import { framePath, framePathLabel } from '../camera/webcodecs'
import { formatClock, formatRange, formatSetting } from '../format'
import { courtFor, deviceId as ownDeviceId } from '../session/api'
import { useSession } from '../session/context'
import { useAi } from '../vision/context'
import { useLiveAnalysis } from '../vision/useLiveAnalysis'
import { useBallModel } from '../vision/useBallModel'
import { useLiveBall, type LiveBounce } from '../vision/useLiveBall'

function bounceLine(bounce: LiveBounce, now: number) {
  const ago = `${Math.max(0, now - bounce.t).toFixed(1)} s ago`
  const where = bounce.meters
    ? `${bounce.meters.x.toFixed(1)} m from the left line, ${bounce.meters.y.toFixed(1)} m from the near line`
    : 'mark the court for this phone to place it'
  return `${bounce.call ? `${bounce.call.toUpperCase()} · ` : ''}${where} · ${ago}${bounce.confirmed ? '' : ' (checking)'}`
}

export function CameraExplorer() {
  const previewRef = useRef<HTMLVideoElement | null>(null)
  const ai = useAi()
  const { assets, storageWarning, noteCameras, sessionId, backend, courts, setBallTrack } = useSession()
  const trackRef = useRef<(assetId: string, fromMs: number, toMs: number) => BallTrack | null>(() => null)
  const camera = useCamera(previewRef, ai.readSnapshot, (video) => {
    const track = trackRef.current(video.assetId, video.fromMs, video.toMs)
    if (track && track.points.length > 0) setBallTrack(video.assetId, track)
  })
  const [ballOn, setBallOn] = useState(false)
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const [takeSeconds, setTakeSeconds] = useState<number>(TAKE_SECONDS[0])
  useLiveAnalysis(previewRef, camera.status === 'live' && ai.enabled && ai.status === 'ready')
  const latest = assets[0]
  const previewOn = camera.status === 'live' && !camera.busy
  const showOverlay = !previewOn
  const ownCourt = courtFor(courts, ownDeviceId())
  const ballModel = useBallModel()
  const liveBall = useLiveBall(previewRef, ballOn && previewOn, ownCourt, ballModel.model)
  useEffect(() => {
    trackRef.current = ballOn ? liveBall.trackBetween : () => null
  })
  const lastBounce = liveBall.view?.bounces.at(-1)
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
            <LiveBallOverlay frameRef={previewRef} view={previewOn ? liveBall.view : null} />
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
              <h3>Live ball</h3>
              {liveBall.status === 'live' ? (
                <span className="pill">
                  {liveBall.fps.toFixed(1)} checks/s
                  {liveBall.backend
                    ? liveBall.backend.name === 'webgpu'
                      ? ' · WebGPU'
                      : ` · WASM ×${liveBall.backend.threads}`
                    : ''}
                </span>
              ) : null}
            </header>
            <p className="muted">
              {ballModel.model.builtIn ? 'YOLOv8n' : ballModel.model.name} follows the ball on the preview and
              calls each bounce. A video recorded while this is on keeps the live track, so Results has it
              straight away.
            </p>
            {ballModel.choices.length > 1 ? (
              <BallModelSelect model={ballModel.model} choices={ballModel.choices} onChange={ballModel.choose} />
            ) : null}
            <button
              type="button"
              className={ballOn ? 'secondary' : 'primary'}
              disabled={!previewOn && !ballOn}
              onClick={() => setBallOn((on) => !on)}
            >
              {ballOn ? 'Stop live ball' : 'Start live ball'}
            </button>
            {liveBall.status === 'loading' ? (
              <p className="muted" role="status">
                Loading YOLOv8n. The first time downloads about 12 MB.
              </p>
            ) : null}
            {liveBall.status === 'error' ? (
              <p className="warn" role="alert">
                {liveBall.error}
              </p>
            ) : null}
            {ballOn ? (
              <p className="muted">
                {ownCourt
                  ? `Bounces are called for the ${courtArea(ownCourt.preset, ownCourt.callArea).label.toLowerCase()} marked for this phone. Lines count as in.`
                  : 'No court is marked for this phone yet. Save a photo from this camera, mark its corners on Results, and bounces get in or out calls.'}
              </p>
            ) : null}
            {lastBounce && liveBall.view ? (
              <div className="line-call-box" role="status">
                {lastBounce.call ? (
                  <span className={`line-call call-${lastBounce.call}`}>{lastBounce.call.toUpperCase()}</span>
                ) : null}
                <span className="muted">{bounceLine(lastBounce, liveBall.view.now)}</span>
              </div>
            ) : ballOn && liveBall.status === 'live' ? (
              <p className="muted">No bounce yet.</p>
            ) : null}
            {liveBall.view && liveBall.view.bounces.length > 1 ? (
              <ul className="label-list">
                {liveBall.view.bounces
                  .slice(0, -1)
                  .reverse()
                  .map((bounce) => (
                    <li key={bounce.t}>{bounceLine(bounce, liveBall.view!.now)}</li>
                  ))}
              </ul>
            ) : null}
          </article>
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
