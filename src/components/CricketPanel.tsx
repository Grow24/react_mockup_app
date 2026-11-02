import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { BallTrack, CourtCalibration, PoseTrack } from '../../shared/contracts.ts'
import { courtFitsTrack } from '../vision/ball'
import { readDeliveries, shotDirection, type Delivery } from '../vision/cricket'
import type { FlightFit } from '../vision/flight'
import { sharedFlightFit } from '../vision/flightFit'
import { length, speed, useUnits, type Units } from '../units'

function clock(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`
}

function side(meters: number, units: Units) {
  if (Math.abs(meters) < 0.02) return 'in line with the middle stump'
  return `${length(Math.abs(meters), units, 2)} ${meters > 0 ? 'right' : 'left'} of the middle stump`
}

function deliveryText(delivery: Delivery, units: Units) {
  const parts = [`from the ${delivery.from} end`, speed(delivery.release.speed, units)]
  if (delivery.pitch) {
    parts.push(`pitched ${length(delivery.pitch.fromStumps, units)} from the stumps (${delivery.pitch.length}), ${side(delivery.pitch.line, units)}`)
  } else {
    parts.push('full toss')
  }
  if (delivery.atStumps) {
    parts.push(
      delivery.atStumps.hitting
        ? 'going on to hit the stumps'
        : `passing the stumps ${side(delivery.atStumps.across, units)}, ${length(Math.max(0, delivery.atStumps.height), units, 2)} high`,
    )
  }
  if (delivery.shot) parts.push(`hit at ${speed(delivery.shot.speed, units)} ${shotDirection(delivery.shot.angle)}`)
  else parts.push('not hit')
  if (delivery.frontFoot != null) {
    parts.push(
      delivery.frontFoot < 0
        ? `front foot ${length(-delivery.frontFoot, units, 2)} over the popping crease: no ball?`
        : `front foot ${length(delivery.frontFoot, units, 2)} behind the popping crease`,
    )
  }
  return parts.join(' · ')
}

// Every ball bowled in the video, read from the ball's 3D flight on the marked pitch.
export function CricketPanel({
  videoRef,
  ballTrack,
  poseTrack,
  court,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  ballTrack: BallTrack | null
  poseTrack: PoseTrack | null
  court: CourtCalibration | null
}) {
  const units = useUnits()
  const usable = ballTrack && court && court.preset === 'cricket-pitch' && courtFitsTrack(ballTrack, court) ? court : null
  const [fit, setFit] = useState<{ track: BallTrack; fit: FlightFit | null } | null>(null)

  useEffect(() => {
    if (!ballTrack || !usable) return
    let current = true
    sharedFlightFit(ballTrack, usable)
      .then((next) => {
        if (current) setFit({ track: ballTrack, fit: next })
      })
      .catch((caught) => console.error(caught))
    return () => {
      current = false
    }
  }, [ballTrack, usable])

  const fitted = fit && fit.track === ballTrack ? fit.fit : null
  const deliveries = useMemo(() => (fitted && usable ? readDeliveries(fitted, usable, poseTrack) : null), [fitted, usable, poseTrack])
  const seek = (t: number) => {
    const video = videoRef.current
    if (video) video.currentTime = Math.max(0, t - 0.5)
  }

  if (!ballTrack || !usable) {
    return (
      <section className="still-pose ball-panel" aria-label="Deliveries">
        <h4>Deliveries</h4>
        <p className="muted">Mark the pitch&apos;s creases and track the ball to read each delivery: pace, length, line, the stumps, and the shot.</p>
      </section>
    )
  }

  const paces = deliveries?.map((delivery) => delivery.release.speed) ?? []
  const lengths = new Map<string, number>()
  for (const delivery of deliveries ?? []) {
    const name = delivery.pitch?.length ?? 'full toss'
    lengths.set(name, (lengths.get(name) ?? 0) + 1)
  }

  return (
    <section className="still-pose ball-panel" aria-label="Deliveries">
      <h4>Deliveries</h4>
      <p className="muted">
        A delivery is a ball that leaves the hand high near one crease and travels fast down the pitch. It is followed
        through its bounce to the batter&apos;s stumps, and a change of flight there without a bounce is the shot. Click a
        delivery to jump the video there.
      </p>
      {!deliveries ? <p className="muted">Fitting the ball&apos;s flight.</p> : null}
      {deliveries && deliveries.length === 0 ? <p className="muted">No delivery was found in the ball&apos;s flight.</p> : null}
      {deliveries && deliveries.length > 0 ? (
        <>
          <p className="note" role="status">
            {deliveries.length} {deliveries.length === 1 ? 'delivery' : 'deliveries'} · average {speed(paces.reduce((sum, value) => sum + value, 0) / paces.length, units)} ·
            fastest {speed(Math.max(...paces), units)} · {[...lengths.entries()].map(([name, count]) => `${count} ${name}`).join(', ')}
          </p>
          <ul className="label-list">
            {deliveries.map((delivery, index) => (
              <li key={delivery.t}>
                <button type="button" className="text-button" onClick={() => seek(delivery.t)}>
                  Ball {index + 1} · {clock(delivery.t)}
                </button>{' '}
                · {deliveryText(delivery, units)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="muted">
        Lengths are measured from the batter&apos;s stumps: up to 2 m a yorker, 6 m full, 8 m a good length, 10 m back of a
        length, then short. Left and right are as the bowler sees them. The front foot is read from the players&apos; poses,
        so track the players too; it is a hint, not an umpire&apos;s call.
      </p>
    </section>
  )
}
