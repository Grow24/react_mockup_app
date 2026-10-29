import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { jpegFromVideo } from '../camera/webcodecs'
import { AnnotationCanvas } from '../components/AnnotationCanvas'
import { CourtPlane } from '../components/CourtPlane'
import { SkeletonView } from '../components/SkeletonView'
import { formatPercent, formatPerformance, formatWhen } from '../format'
import { useSession } from '../session/context'
import type { AiSnapshot } from '../types'

function poseReady(snapshot: AiSnapshot | undefined) {
  return (snapshot?.pose.filter((point) => point.visibility >= 0.5).length ?? 0) >= 4
}

function worldReady(snapshot: AiSnapshot | undefined) {
  return (snapshot?.worldPose?.filter((point) => point.z != null && point.visibility >= 0.5).length ?? 0) >= 4
}

export function Results() {
  const { assets, ready, storageWarning, backend, court, addAsset, removeAsset, setCourt } = useSession()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [frameReady, setFrameReady] = useState(false)
  const [savingFrame, setSavingFrame] = useState(false)
  const [frameMessage, setFrameMessage] = useState<string | null>(null)
  const photoRef = useRef<HTMLImageElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const poseFrameRef = useRef<HTMLDivElement | null>(null)
  const selected = assets.find((asset) => asset.id === selectedId) ?? assets[0]

  useEffect(() => {
    setFrameReady(false)
    setFrameMessage(null)
  }, [selected?.id])

  async function saveDisplayedFrame() {
    const video = videoRef.current
    if (!video || !selected || selected.kind !== 'video') return
    setSelectedId(selected.id)
    setSavingFrame(true)
    setFrameMessage(null)
    try {
      const still = await jpegFromVideo(video)
      addAsset({
        kind: 'photo',
        blob: still.blob,
        mimeType: 'image/jpeg',
        cameraLabel: selected.cameraLabel,
        width: still.width,
        height: still.height,
      })
      setFrameMessage(
        still.path === 'webcodecs'
          ? 'Frame saved with WebCodecs. Open the new photo to mark the court.'
          : 'Frame saved from the video. Open the new photo to mark the court.',
      )
    } catch (error) {
      setFrameMessage(error instanceof Error ? error.message : 'Could not save a JPEG from this frame.')
    } finally {
      setSavingFrame(false)
    }
  }

  if (!ready) {
    return (
      <section className="screen">
        <div className="screen-intro">
          <h2>Results</h2>
          <p>Opening the shared session.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="screen">
      <div className="screen-intro">
        <h2>Results</h2>
        <p>
          Photos and videos in this shared session.
          {backend === 'online'
            ? ' The session link in the header opens the same files in another browser.'
            : ' The server is offline, so these stay in this browser.'}{' '}
          A photo keeps the boxes, the 2D skeleton, and the 3D pose from the moment it was taken.
          Click its four court corners to flatten the ground into meters. A video keeps the last
          analyzed frame. Save the frame on screen to turn that moment into a photo.
        </p>
      </div>

      {storageWarning ? (
        <p className="warn" role="alert">
          {storageWarning}
        </p>
      ) : null}

      {assets.length === 0 || !selected ? (
        <article className="card empty-card">
          <h3>Nothing captured yet</h3>
          <p className="muted">Take a photo or record a short video on the camera screen.</p>
          <Link className="primary link-button" to="/">
            Open camera
          </Link>
        </article>
      ) : (
        <div className="layout">
          <article className="card playback">
            <header className="card-head">
              <h3>{selected.kind === 'photo' ? 'Photo' : 'Video'}</h3>
              <button type="button" className="text-button" onClick={() => removeAsset(selected.id)}>
                Remove
              </button>
            </header>
            <figure>
              {selected.kind === 'photo' && selected.width && selected.height ? (
                <CourtPlane
                  key={selected.id}
                  assetId={selected.id}
                  imageUrl={selected.url}
                  alt={`Photo from ${selected.cameraLabel}`}
                  sourceWidth={selected.width}
                  sourceHeight={selected.height}
                  snapshot={selected.snapshot}
                  saved={court}
                  onSave={setCourt}
                  onClear={() => setCourt(null)}
                />
              ) : selected.kind === 'photo' ? (
                <div className="annotated">
                  <img ref={photoRef} src={selected.url} alt={`Photo from ${selected.cameraLabel}`} />
                  <AnnotationCanvas
                    frameRef={photoRef}
                    sourceWidth={selected.width ?? 0}
                    sourceHeight={selected.height ?? 0}
                    snapshot={selected.snapshot ?? null}
                  />
                </div>
              ) : (
                <div className="video-still">
                  <video
                    key={selected.id}
                    ref={videoRef}
                    src={selected.url}
                    controls
                    playsInline
                    onLoadedData={() => setFrameReady(true)}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={!frameReady || savingFrame}
                    onClick={() => void saveDisplayedFrame()}
                  >
                    Save this frame
                  </button>
                  {frameMessage ? (
                    <p className="note" role="status">
                      {frameMessage}
                    </p>
                  ) : null}
                </div>
              )}
              <figcaption>
                {selected.cameraLabel} · {formatWhen(selected.createdAt)}
                {selected.width && selected.height ? ` · ${selected.width}×${selected.height}` : ''}
              </figcaption>
            </figure>

            {selected.kind === 'video' && selected.snapshot && selected.width && selected.height ? (
              <div className="still-pose">
                <p className="muted">Boxes and skeleton from the last analyzed frame.</p>
                <div
                  ref={poseFrameRef}
                  className="pose-frame"
                  style={{ aspectRatio: `${selected.width} / ${selected.height}` }}
                >
                  <AnnotationCanvas
                    frameRef={poseFrameRef}
                    sourceWidth={selected.width}
                    sourceHeight={selected.height}
                    snapshot={selected.snapshot}
                  />
                </div>
              </div>
            ) : null}

            {selected.snapshot ? (
              <div className="still-pose">
                <p className="muted">Drag the view to turn the skeleton.</p>
                {worldReady(selected.snapshot) && selected.snapshot.worldPose ? (
                  <SkeletonView pose={selected.snapshot.worldPose} />
                ) : (
                  <p className="muted">
                    No 3D pose stored with this capture. Turn AI on, then take a photo while a person
                    is in frame.
                  </p>
                )}
                {selected.snapshot.performance ? (
                  <p className="muted">{formatPerformance(selected.snapshot.performance)} at capture.</p>
                ) : null}
              </div>
            ) : null}

            {selected.snapshot ? (
              <ul className="label-list">
                {selected.snapshot.detections.length === 0 ? (
                  <li>No object stored above the confidence line</li>
                ) : (
                  selected.snapshot.detections.map((detection) => (
                    <li key={`${detection.label}-${detection.box.x}-${detection.box.y}`}>
                      {detection.label} {formatPercent(detection.score)}
                    </li>
                  ))
                )}
                <li>{poseReady(selected.snapshot) ? 'Pose stored with this capture' : 'No pose stored'}</li>
              </ul>
            ) : (
              <p className="muted">AI was off for this capture, so there are no boxes or a skeleton.</p>
            )}
          </article>

          <aside className="side">
            <article className="card">
              <header className="card-head">
                <h3>Saved here</h3>
                <span className="pill">{assets.length}</span>
              </header>
              <ul className="asset-list">
                {assets.map((asset) => (
                  <li key={asset.id}>
                    <button
                      type="button"
                      className={asset.id === selected.id ? 'asset active' : 'asset'}
                      onClick={() => setSelectedId(asset.id)}
                    >
                      <span>{asset.kind === 'photo' ? 'Photo' : 'Video'}</span>
                      <small>
                        {formatWhen(asset.createdAt)} · {asset.cameraLabel}
                        {asset.snapshot ? ' · AI' : ''}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            </article>
          </aside>
        </div>
      )}
    </section>
  )
}
