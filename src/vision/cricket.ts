import { COURT_PRESETS, type CourtCalibration, type PoseTrack } from '../../shared/contracts.ts'
import { groundFromImage, positionAt, velocityAt, type Flight, type FlightFit, type Vec3 } from './flight.ts'
import { feetOf, frameAt, JOINTS, keypoint } from './players.ts'

const { widthMeters: W, lengthMeters: L } = COURT_PRESETS['cricket-pitch']
const STUMPS_X = W / 2
const POPPING = 1.22
// Half the width of the three stumps, and their height, plus the ball's radius.
const STUMPS_HALF_WIDTH = 0.1143 + 0.036
const STUMPS_HEIGHT = 0.711 + 0.036
// A delivery leaves the hand within this of a bowling crease, this high, this fast down the pitch.
const RELEASE_ZONE = 4
const RELEASE_HEIGHT = { low: 1.2, high: 2.8 }
const MIN_PACE = 12
// Flights closer than this in time are one ball's path.
const JOINED = 0.3
// The bat meets the ball within this of the batter's stumps.
const BAT_REACH = 4
// The ankle sits a little in front of the heel, which may still be behind the line.
const HEEL = 0.1

export type End = 'near' | 'far'
export type LengthName = 'yorker' | 'full' | 'good length' | 'back of a length' | 'short'

export type Delivery = {
  t: number
  from: End
  release: { p: Vec3; speed: number }
  // Where it pitched, how far from the batter's stumps, and how far right of the middle stump as the bowler sees it.
  pitch: { t: number; p: Vec3; fromStumps: number; length: LengthName; line: number } | null
  // Where the ball passes, or would have passed, the batter's stumps.
  atStumps: { across: number; height: number; hitting: boolean } | null
  // The batter's shot: speed off the bat and its direction from straight back past the bowler,
  // positive to the bowler's right.
  shot: { t: number; speed: number; angle: number } | null
  // The bowler's front foot at release against the popping crease: meters behind it (negative is over).
  frontFoot: number | null
}

export function lengthName(fromStumps: number): LengthName {
  if (fromStumps <= 2) return 'yorker'
  if (fromStumps <= 6) return 'full'
  if (fromStumps <= 8) return 'good length'
  if (fromStumps <= 10) return 'back of a length'
  return 'short'
}

// When the flight reaches the line across the pitch at y, if it does while it lasts or soon after.
function reachAt(flight: Flight, y: number) {
  const v = flight.v0.y
  if (Math.abs(v) < 1e-6) return null
  const t = flight.t0 + (y - flight.p0.y) / v
  return t >= flight.from - 0.05 && t <= flight.to + 1 ? t : null
}

// The bowler's front foot at the moment of release, from the nearest person's ankles.
function frontFootAt(track: PoseTrack, court: CourtCalibration, t: number, release: Vec3, from: End) {
  const frame = frameAt(track, t)
  if (!frame) return null
  const toCourt = groundFromImage(court)
  if (!toCourt) return null
  const kx = court.sourceWidth / track.sourceWidth
  const ky = court.sourceHeight / track.sourceHeight
  const ground = (point: { x: number; y: number }) => toCourt({ x: point.x * kx, y: point.y * ky })
  let best: { distance: number; ankles: { x: number; y: number }[] } | null = null
  for (const person of frame.people) {
    const feet = ground(feetOf(person))
    if (!feet) continue
    const distance = Math.hypot(feet.x - release.x, feet.y - release.y)
    if (distance > 2.5 || (best && distance >= best.distance)) continue
    const ankles = [JOINTS.leftAnkle, JOINTS.rightAnkle]
      .map((joint) => keypoint(person, joint))
      .flatMap((point) => {
        const spot = point ? ground(point) : null
        return spot ? [spot] : []
      })
    if (ankles.length > 0) best = { distance, ankles }
  }
  if (!best) return null
  // The front foot is the one further down the pitch; its distance behind this end's popping crease.
  return from === 'near'
    ? POPPING + HEEL - Math.max(...best.ankles.map((ankle) => ankle.y))
    : Math.min(...best.ankles.map((ankle) => ankle.y)) - (L - POPPING - HEEL)
}

// Every ball bowled: released high near one end and sent fast down the pitch, followed through
// its bounce to the batter's end.
export function readDeliveries(fit: FlightFit, court: CourtCalibration, track: PoseTrack | null = null): Delivery[] {
  const flights = fit.flights.filter((flight) => flight.reliable).sort((a, b) => a.from - b.from)
  const deliveries: Delivery[] = []
  let index = 0
  while (index < flights.length) {
    const first = flights[index]!
    const start = positionAt(first, first.from)
    const v = velocityAt(first, first.from)
    const from: End | null = start.y <= RELEASE_ZONE ? 'near' : start.y >= L - RELEASE_ZONE ? 'far' : null
    const down = from === 'near' ? v.y : -v.y
    const released =
      from &&
      first.startBounce == null &&
      start.z >= RELEASE_HEIGHT.low &&
      start.z <= RELEASE_HEIGHT.high &&
      down >= MIN_PACE &&
      (index === 0 || first.from - flights[index - 1]!.to >= JOINED || flights[index - 1]!.endBounce != null)
    if (!released || !from) {
      index += 1
      continue
    }
    const chain = [first]
    while (index + chain.length < flights.length) {
      const next = flights[index + chain.length]!
      if (next.from - chain.at(-1)!.to >= JOINED) break
      chain.push(next)
    }
    const batterY = from === 'near' ? L : 0
    const right = from === 'near' ? 1 : -1
    // The bat: a change of flight without a bounce, near the batter's stumps.
    const hitAt = chain.findIndex(
      (flight, k) => k > 0 && chain[k - 1]!.endBounce == null && Math.abs(positionAt(flight, flight.from).y - batterY) <= BAT_REACH,
    )
    const approach = hitAt > 0 ? chain.slice(0, hitAt) : chain
    const pitched = approach.find((flight) => flight.endBounce != null)
    const pitchP = pitched ? positionAt(pitched, pitched.endBounce!) : null
    const last = approach.at(-1)!
    const crossing = reachAt(last, batterY)
    const atP = crossing != null ? positionAt(last, crossing) : null
    let shot: Delivery['shot'] = null
    if (hitAt > 0) {
      const outgoing = chain[hitAt]!
      const velocity = velocityAt(outgoing, outgoing.from)
      // Straight back past the bowler is toward the bowler's end.
      const back = { x: velocity.x * right, y: -velocity.y * right }
      shot = {
        t: outgoing.from,
        speed: Math.hypot(velocity.x, velocity.y, velocity.z),
        angle: (Math.atan2(back.x, back.y) * 180) / Math.PI,
      }
    }
    deliveries.push({
      t: first.from,
      from,
      release: { p: start, speed: Math.hypot(v.x, v.y, v.z) },
      pitch: pitchP
        ? {
            t: pitched!.endBounce!,
            p: pitchP,
            fromStumps: Math.abs(batterY - pitchP.y),
            length: lengthName(Math.abs(batterY - pitchP.y)),
            line: (pitchP.x - STUMPS_X) * right,
          }
        : null,
      atStumps: atP
        ? {
            across: (atP.x - STUMPS_X) * right,
            height: atP.z,
            hitting: Math.abs(atP.x - STUMPS_X) <= STUMPS_HALF_WIDTH && atP.z >= 0 && atP.z <= STUMPS_HEIGHT,
          }
        : null,
      shot,
      frontFoot: track ? frontFootAt(track, court, first.from, start, from) : null,
    })
    index += chain.length
  }
  return deliveries
}

// A delivery is settled by a live window that saw it leave the hand and a second and a half after.
const LIVE_START_EDGE = 0.2
const LIVE_END_EDGE = 1.5
const SAME_DELIVERY = 0.5

// Puts the deliveries read from one live window, already on the device clock, in place of what
// the running list had for that stretch.
export function mergeDeliveries(list: Delivery[], fresh: Delivery[], window: { from: number; duration: number }) {
  const from = window.from + LIVE_START_EDGE
  const to = window.from + window.duration - LIVE_END_EDGE
  if (to <= from) return list
  const settled = fresh.filter((delivery) => delivery.t >= from && delivery.t <= to)
  const kept = list.filter((delivery) => (delivery.t < from || delivery.t > to) && !settled.some((other) => Math.abs(other.t - delivery.t) <= SAME_DELIVERY))
  return [...kept, ...settled].sort((a, b) => a.t - b.t).slice(-500)
}

// "30° to the bowler's left", "straight", or "behind the stumps".
export function shotDirection(angle: number) {
  const size = Math.abs(angle)
  if (size <= 10) return 'straight back past the bowler'
  if (size >= 150) return 'behind the stumps'
  return `${Math.round(size)}° to the bowler's ${angle > 0 ? 'right' : 'left'}`
}
