import { COURT_PRESETS, type CourtCalibration, type PersonPose, type PoseTrack } from '../../shared/contracts.ts'
import { positionAt, velocityAt, type CourtCamera, type Flight, type FlightFit, type Vec3 } from './flight.ts'
import { feetOnCourt, frameAt, JOINTS, keypoint, playerPaths } from './players.ts'

// Shots closer together than this belong to one rally.
const RALLY_GAP = 4
// A quiet stretch at least this long is a gap between points; this long or more, a break.
const GAP_SECONDS = 6
const BREAK_SECONDS = 60
// Nobody further than this from the ball when it was struck is taken for the hitter.
const REACH = 3
// Players walking slower than this on average are resting.
const RESTING_SPEED = 0.6

export type ShotKind = 'serve' | 'overhead smash' | 'forehand volley' | 'backhand volley' | 'forehand drive' | 'backhand drive' | 'shot'

export type Shot = {
  t: number
  p: Vec3
  // The player's letter, or their side when they have none, or null when nobody was close enough.
  player: string | null
  kind: ShotKind
  // How fast the hitting hand moved at contact, meters per second.
  handSpeed: number | null
  twoHanded: boolean
}

export type MatchSegment =
  | { kind: 'rally'; from: number; to: number; shots: Shot[] }
  | { kind: 'gap' | 'break'; from: number; to: number; resting: boolean }

export type MatchSummary = { shots: Shot[]; segments: MatchSegment[]; hands: Record<string, 'left' | 'right'> }

// A point in the image placed on an upright plane through the feet, facing the camera.
function liftPoint(camera: CourtCamera, feet: { x: number; y: number }, image: { x: number; y: number }): Vec3 | null {
  const c = camera.position
  const toward = { x: feet.x - c.x, y: feet.y - c.y }
  const size = Math.hypot(toward.x, toward.y)
  if (size < 1e-6) return null
  const n = { x: toward.x / size, y: toward.y / size }
  const [r0, r1, r2] = camera.rows
  const u = (image.x - camera.cx) / camera.focal
  const v = (image.y - camera.cy) / camera.focal
  const d = { x: r0.x * u + r1.x * v + r2.x, y: r0.y * u + r1.y * v + r2.y, z: r0.z * u + r1.z * v + r2.z }
  const facing = n.x * d.x + n.y * d.y
  if (facing <= 1e-6) return null
  const s = (n.x * toward.x + n.y * toward.y) / facing
  return { x: c.x + s * d.x, y: c.y + s * d.y, z: c.z + s * d.z }
}

const keyOf = (person: PersonPose) => person.id ?? person.player ?? null

// Moments the ball changed flight without touching the ground: a racquet hit it.
export function findHits(fit: FlightFit) {
  const flights = fit.flights.filter((flight) => flight.reliable)
  const hits: { t: number; incoming: Flight | null; outgoing: Flight }[] = []
  flights.forEach((flight, index) => {
    const previous = flights[index - 1]
    if (previous && previous.endBounce == null && Math.abs(flight.from - previous.to) < 0.3) {
      hits.push({ t: flight.from, incoming: previous, outgoing: flight })
    } else if (!previous || flight.from - previous.to >= 0.3) {
      // The first flight seen, or one after the ball was lost: it was struck just before.
      hits.push({ t: flight.from, incoming: null, outgoing: flight })
    }
  })
  return hits
}

// Which hand holds the racquet, by what was seen through the video. Right when never seen.
export function racketHands(track: PoseTrack) {
  const votes = new Map<string, { left: number; right: number }>()
  for (const frame of track.frames) {
    for (const person of frame.people) {
      const key = keyOf(person)
      if (!key || !person.racket) continue
      const vote = votes.get(key) ?? { left: 0, right: 0 }
      vote[person.racket.hand] += 1
      votes.set(key, vote)
    }
  }
  const hands: Record<string, 'left' | 'right'> = {}
  for (const [key, vote] of votes) hands[key] = vote.left > vote.right ? 'left' : 'right'
  return hands
}

function classify(
  hit: ReturnType<typeof findHits>[number],
  person: PersonPose,
  feet: { x: number; y: number },
  camera: CourtCamera,
  track: PoseTrack,
  court: CourtCalibration,
  hand: 'left' | 'right',
  sinceLastShot: number,
) {
  const kx = court.sourceWidth / track.sourceWidth
  const ky = court.sourceHeight / track.sourceHeight
  const lift = (index: number) => {
    const point = keypoint(person, index)
    return point ? liftPoint(camera, feet, { x: point.x * kx, y: point.y * ky }) : null
  }
  const lengthMeters = COURT_PRESETS[court.preset].lengthMeters
  const wristJoint = hand === 'right' ? JOINTS.rightWrist : JOINTS.leftWrist
  const otherWrist = lift(hand === 'right' ? JOINTS.leftWrist : JOINTS.rightWrist)
  const wrist = lift(wristJoint)
  const nose = lift(JOINTS.nose)
  const hips = [lift(JOINTS.leftHip), lift(JOINTS.rightHip)].filter((point): point is Vec3 => !!point)
  const racket = person.racket
    ? liftPoint(camera, feet, { x: (person.racket.x + person.racket.width / 2) * kx, y: (person.racket.y + person.racket.height / 2) * ky })
    : null
  const contact = racket ?? wrist
  const body = hips.length ? { x: hips.reduce((sum, p) => sum + p.x, 0) / hips.length, y: hips.reduce((sum, p) => sum + p.y, 0) / hips.length } : feet
  // Facing the net, a player's right is +x at the near end and -x at the far end.
  const facing = feet.y < lengthMeters / 2 ? 1 : -1
  const onRight = contact ? (contact.x - body.x) * facing > 0 : null
  const forehand = onRight == null ? null : onRight === (hand === 'right')
  const twoHanded = !!(wrist && otherWrist && Math.hypot(wrist.x - otherWrist.x, wrist.y - otherWrist.y, wrist.z - otherWrist.z) < 0.25)
  const overhead = !!(wrist && nose && wrist.z > nose.z + 0.1)
  const nearBaseline = Math.min(Math.abs(feet.y), Math.abs(feet.y - lengthMeters)) < 1.5
  // The flight coming in started either at a bounce (a drive) or at the other player's racquet
  // (a volley). Without it, being at the net is the best guess.
  const volley = hit.incoming ? hit.incoming.startBounce == null : Math.abs(feet.y - lengthMeters / 2) <= 4.5
  let kind: ShotKind
  if (overhead && sinceLastShot > 2.5 && nearBaseline) kind = 'serve'
  else if (overhead) kind = 'overhead smash'
  else if (forehand == null) kind = 'shot'
  else if (volley) kind = forehand ? 'forehand volley' : 'backhand volley'
  else kind = forehand ? 'forehand drive' : 'backhand drive'
  return { kind, twoHanded: twoHanded && forehand === false }
}

function handSpeed(track: PoseTrack, key: string, joint: number, t: number, camera: CourtCamera, court: CourtCalibration) {
  const dt = 1 / track.sampleFps
  const at = (time: number) => {
    const frame = frameAt(track, time)
    const person = frame?.people.find((candidate) => keyOf(candidate) === key)
    const feet = person ? feetOnCourt(person, court, track.sourceWidth, track.sourceHeight) : null
    const point = person ? keypoint(person, joint) : null
    return feet && point
      ? liftPoint(camera, feet, { x: (point.x * court.sourceWidth) / track.sourceWidth, y: (point.y * court.sourceHeight) / track.sourceHeight })
      : null
  }
  const before = at(t - dt)
  const after = at(t + dt)
  if (!before || !after) return null
  return Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) / (2 * dt)
}

// Every shot with who hit it and how, the rallies they make up, and the quiet stretches between.
export function readMatch(fit: FlightFit, track: PoseTrack | null, court: CourtCalibration, duration: number): MatchSummary {
  const hits = findHits(fit)
  const hands = track ? racketHands(track) : {}
  const lengthMeters = COURT_PRESETS[court.preset].lengthMeters
  const shots: Shot[] = []
  for (const hit of hits) {
    const p = positionAt(hit.outgoing, hit.t)
    let player: string | null = null
    let kind: ShotKind = 'shot'
    let speed: number | null = null
    let twoHanded = false
    const frame = track ? frameAt(track, hit.t) : null
    if (track && frame) {
      let best: { person: PersonPose; feet: { x: number; y: number }; distance: number } | null = null
      for (const person of frame.people) {
        const key = keyOf(person)
        const feet = feetOnCourt(person, court, track.sourceWidth, track.sourceHeight)
        if (!key || !feet || feet.y < lengthMeters / 2 !== p.y < lengthMeters / 2) continue
        const distance = Math.hypot(feet.x - p.x, feet.y - p.y)
        if (distance <= REACH && (!best || distance < best.distance)) best = { person, feet, distance }
      }
      if (best) {
        player = keyOf(best.person)
        const hand = hands[player!] ?? 'right'
        const since = hit.t - (shots.at(-1)?.t ?? Number.NEGATIVE_INFINITY)
        const read = classify(hit, best.person, best.feet, fit.camera, track, court, hand, since)
        kind = read.kind
        twoHanded = read.twoHanded
        speed = handSpeed(track, player!, hand === 'right' ? JOINTS.rightWrist : JOINTS.leftWrist, hit.t, fit.camera, court)
      }
    }
    // Without the players, a ball struck from near a baseline after a pause is still most likely a serve.
    if (!player && shots.length === 0 && Math.min(Math.abs(p.y), Math.abs(p.y - lengthMeters)) < 2 && velocityAt(hit.outgoing, hit.t).z > -2) kind = 'serve'
    shots.push({ t: hit.t, p, player, kind, handSpeed: speed, twoHanded })
  }

  const segments: MatchSegment[] = []
  const busy: { from: number; to: number; shots: Shot[] }[] = []
  for (const shot of shots) {
    const last = busy.at(-1)
    if (last && shot.t - last.shots.at(-1)!.t <= RALLY_GAP) {
      last.shots.push(shot)
      last.to = shot.t
    } else busy.push({ from: shot.t, to: shot.t, shots: [shot] })
  }
  // A rally lasts until the last ball it struck lands for good.
  for (const rally of busy) {
    const after = fit.flights.filter((flight) => flight.reliable && flight.from >= rally.to - 0.05 && flight.from <= rally.to + RALLY_GAP)
    rally.to = Math.max(rally.to, ...after.map((flight) => flight.to))
  }
  const paths = track ? playerPaths(track, court).paths : new Map()
  const moving = (from: number, to: number) => {
    let meters = 0
    let seconds = 0
    for (const path of paths.values()) {
      const inside = path.filter((spot: { t: number }) => spot.t >= from && spot.t <= to)
      for (let index = 1; index < inside.length; index += 1) {
        meters += Math.hypot(inside[index]!.x - inside[index - 1]!.x, inside[index]!.y - inside[index - 1]!.y)
        seconds += inside[index]!.t - inside[index - 1]!.t
      }
    }
    return seconds > 0 ? meters / seconds : null
  }
  let cursor = 0
  const quiet = (from: number, to: number) => {
    if (to - from < GAP_SECONDS) return
    const speed = moving(from, to)
    segments.push({ kind: to - from >= BREAK_SECONDS ? 'break' : 'gap', from, to, resting: speed != null && speed < RESTING_SPEED })
  }
  for (const rally of busy) {
    quiet(cursor, rally.from)
    segments.push({ kind: 'rally', from: rally.from, to: rally.to, shots: rally.shots })
    cursor = rally.to
  }
  quiet(cursor, duration)
  return { shots, segments, hands }
}
