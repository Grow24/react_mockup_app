import { useEffect, useMemo, useState } from 'react'
import type { BallTrack, CourtCalibration } from '../../shared/contracts.ts'
import { courtFor, deviceId as ownDeviceId } from '../session/api'
import type { MediaAsset } from '../types'
import { courtFitsTrack } from '../vision/ball'
import { predictFlight, type Prediction } from '../vision/physics'
import { ballisticEnd, triangulateTake, type TakeView, type TriangulatedPoint } from '../vision/triangulate'
import { describeSpot, PREDICT_SECONDS, predictionText, type PathSample } from '../vision/flightText'
import { FlightView } from './BallFlight'

const PATH_GAP_SECONDS = 0.25

function phoneName(asset: MediaAsset, index: number) {
  const mine = asset.deviceId && asset.deviceId === ownDeviceId()
  return `Camera ${String.fromCharCode(65 + index)} · ${asset.cameraLabel}${mine ? ' (this phone)' : ''}`
}

function pathsFrom(points: TriangulatedPoint[]): PathSample[][] {
  const paths: PathSample[][] = []
  let current: PathSample[] = []
  for (const point of points) {
    const last = current[current.length - 1]
    if (last && point.t - last.t > PATH_GAP_SECONDS) {
      paths.push(current)
      current = []
    }
    current.push({ t: point.t, p: point.p })
  }
  if (current.length > 0) paths.push(current)
  return paths
}

export function TakePanel({
  takeId,
  assets,
  courts,
  ballTracks,
}: {
  takeId: string
  assets: MediaAsset[]
  courts: CourtCalibration[]
  ballTracks: Record<string, BallTrack>
}) {
  const videos = useMemo(
    () =>
      assets
        .filter((asset) => asset.kind === 'video' && asset.takeId === takeId)
        .sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt)),
    [assets, takeId],
  )
  const rows = useMemo(
    () =>
      videos.map((video, index) => {
        const track = ballTracks[video.id]
        const court = courtFor(courts, video.deviceId)
        const missing: string[] = []
        if (!track) missing.push('track the ball')
        if (!court) missing.push('mark the court on a frame from this camera')
        else if (track && !courtFitsTrack(track, court)) missing.push('mark the court on a frame from this video')
        if (video.startedAt == null) missing.push('a recording start time')
        return { video, name: phoneName(video, index), track, court, missing }
      }),
    [videos, courts, ballTracks],
  )
  const views: TakeView[] = useMemo(
    () =>
      rows.flatMap((row) =>
        row.missing.length === 0 && row.track && row.court && row.video.startedAt != null
          ? [{ assetId: row.video.id, label: row.name, track: row.track, court: row.court, startedAt: row.video.startedAt }]
          : [],
      ),
    [rows],
  )
  const result = useMemo(() => triangulateTake(views), [views])
  const end = useMemo(() => (result ? ballisticEnd(result.points) : null), [result])
  const paths = useMemo(() => (result ? pathsFrom(result.points) : []), [result])
  const bounceSpots = useMemo(() => result?.bounces.map((bounce) => bounce.p) ?? [], [result])
  const cameraSpots = useMemo(() => result?.cameras.map((camera) => camera.position) ?? [], [result])
  const preset = views[0]?.court.preset ?? 'tennis-doubles'
  const [predicted, setPredicted] = useState<{ from: NonNullable<typeof end>; prediction: Prediction } | null>(null)

  useEffect(() => {
    if (!end) return
    let current = true
    predictFlight(preset, end, PREDICT_SECONDS)
      .then((prediction) => {
        if (current) setPredicted({ from: end, prediction })
      })
      .catch((error) => console.error(error))
    return () => {
      current = false
    }
  }, [end, preset])

  const prediction = predicted && predicted.from === end ? predicted.prediction : null

  return (
    <section className="still-pose ball-panel" aria-label="Multi-camera take">
      <h4>Multi-camera take</h4>
      <p className="muted">
        {videos.length === 1
          ? 'Only this phone recorded the take. Open the session link on a second phone, start its camera, and record another synced take.'
          : `${videos.length} cameras recorded this take at the same server time. With the ball tracked and the court marked on each, their views are intersected into real 3D positions.`}
      </p>
      <ul className="label-list">
        {rows.map((row) => (
          <li key={row.video.id}>
            {row.name}: {row.missing.length === 0 ? 'ready' : `still needs to ${row.missing.join(', ')}`}
          </li>
        ))}
      </ul>
      {views.length >= 2 && !result ? (
        <p className="warn" role="alert">
          The cameras could not be placed from their court corners. Check the corner order on each.
        </p>
      ) : null}
      {result && result.points.length === 0 ? (
        <p className="warn" role="alert">
          The cameras never agreed on where the ball was. Check that each court was marked in the same order
          and that both videos show the same rally.
        </p>
      ) : null}
      {result && result.points.length > 0 ? (
        <>
          <p className="muted">
            {result.points.length} 3D points · cameras agree within {result.medianErrorPx.toFixed(1)} px · peak{' '}
            {result.peak.toFixed(1)} m · top speed {(result.topSpeed * 3.6).toFixed(0)} km/h
          </p>
          <ul className="label-list">
            {result.cameras.slice(1).map((camera) => (
              <li key={camera.assetId}>
                {camera.label}: clock corrected by {camera.shiftMs > 0 ? '+' : ''}
                {camera.shiftMs} ms from {camera.samples} shared frames
              </li>
            ))}
            {result.bounces.map((bounce, index) => (
              <li key={bounce.t}>
                Bounce {index + 1} at {bounce.t.toFixed(2)} s: {describeSpot(preset, bounce.p)}
              </li>
            ))}
          </ul>
          <FlightView
            preset={preset}
            paths={paths}
            bounces={bounceSpots}
            prediction={prediction}
            cameras={cameraSpots}
          />
          {prediction ? <p className="note">{predictionText(preset, prediction)}</p> : null}
          <p className="muted">
            Gold is where the cameras saw the ball, teal is the Rapier prediction after the take, and the white
            dots are the cameras.
          </p>
        </>
      ) : null}
    </section>
  )
}
