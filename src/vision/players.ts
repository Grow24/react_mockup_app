import { COURT_PRESETS, type CourtCalibration, type PersonPose, type PoseFrame, type PoseTrack } from '../../shared/contracts.ts'
import { groundFromImage } from './flight.ts'

const KEYPOINT_SCORE = 0.3
// How far outside the lines a player can still be: behind the baseline and in the side run-off.
const COURT_MARGIN = { 'tennis-doubles': { side: 5, end: 8 }, 'cricket-pitch': { side: 15, end: 12 } } as const

export const JOINTS = {
  nose: 0,
  leftShoulder: 5,
  rightShoulder: 6,
  leftElbow: 7,
  rightElbow: 8,
  leftWrist: 9,
  rightWrist: 10,
  leftHip: 11,
  rightHip: 12,
  leftKnee: 13,
  rightKnee: 14,
  leftAnkle: 15,
  rightAnkle: 16,
} as const

// Lines between COCO keypoints that draw a skeleton.
export const PERSON_BONES: readonly [number, number][] = [
  [5, 6],
  [5, 7],
  [7, 9],
  [6, 8],
  [8, 10],
  [5, 11],
  [6, 12],
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [0, 5],
  [0, 6],
]

export function keypoint(person: PersonPose, index: number) {
  const score = person.keypoints[index * 3 + 2] ?? 0
  if (score < KEYPOINT_SCORE) return null
  return { x: person.keypoints[index * 3]!, y: person.keypoints[index * 3 + 1]! }
}

// Where the person stands, in image pixels: between the ankles, or the bottom of the box.
export function feetOf(person: PersonPose) {
  const left = keypoint(person, JOINTS.leftAnkle)
  const right = keypoint(person, JOINTS.rightAnkle)
  if (left && right) return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }
  if (left || right) return left ?? right!
  return { x: person.box.x + person.box.width / 2, y: person.box.y + person.box.height }
}

function courtFits(court: CourtCalibration | null, width: number, height: number) {
  return !!court && Math.abs(court.sourceWidth / court.sourceHeight - width / height) / (width / height) <= 0.02
}

// The person's feet in court meters, when this frame matches the marked court.
export function feetOnCourt(person: PersonPose, court: CourtCalibration | null, width: number, height: number) {
  if (!court || !courtFits(court, width, height)) return null
  const toCourt = groundFromImage(court)
  const feet = feetOf(person)
  return toCourt?.({ x: (feet.x * court.sourceWidth) / width, y: (feet.y * court.sourceHeight) / height }) ?? null
}

// Names each player by the side of the net they stand on. With a court, people well outside it
// (umpire, ball kids, spectators) are dropped; without one, the two biggest people are the players.
export function assignPlayers(people: PersonPose[], court: CourtCalibration | null, width: number, height: number): PersonPose[] {
  const area = (person: PersonPose) => person.box.width * person.box.height
  const placed = people.map((person) => ({ person, spot: feetOnCourt(person, court, width, height) }))
  if (court && courtFits(court, width, height)) {
    const { widthMeters, lengthMeters } = COURT_PRESETS[court.preset]
    const margin = COURT_MARGIN[court.preset]
    const sides: Record<'near' | 'far', PersonPose[]> = { near: [], far: [] }
    for (const { person, spot } of placed) {
      if (!spot) continue
      if (spot.x < -margin.side || spot.x > widthMeters + margin.side || spot.y < -margin.end || spot.y > lengthMeters + margin.end) continue
      sides[spot.y < lengthMeters / 2 ? 'near' : 'far'].push(person)
    }
    return (['near', 'far'] as const).flatMap((side) =>
      sides[side]
        .sort((a, b) => area(b) - area(a))
        .slice(0, 2)
        .map((person, index) => ({ ...person, player: index === 0 ? side : `${side}-2` })),
    )
  }
  const biggest = people.slice().sort((a, b) => area(b) - area(a)).slice(0, 2)
  const byDepth = biggest.sort((a, b) => feetOf(b).y - feetOf(a).y)
  return byDepth.map((person, index) => ({ ...person, player: index === 0 ? 'near' : 'far' }))
}

export function playerName(player: string | undefined) {
  if (player === 'near') return 'Near player'
  if (player === 'far') return 'Far player'
  if (player === 'near-2') return 'Near partner'
  if (player === 'far-2') return 'Far partner'
  return 'Person'
}

export const PLAYER_COLORS: Record<string, string> = {
  near: '#7fd8cf',
  far: '#e0603c',
  'near-2': '#b8e6a0',
  'far-2': '#f3a37a',
}

// The angle at joint b between a and c, in degrees. Measured in the image, so it reads true only
// when the limb faces the camera.
function angleAt(person: PersonPose, a: number, b: number, c: number) {
  const pa = keypoint(person, a)
  const pb = keypoint(person, b)
  const pc = keypoint(person, c)
  if (!pa || !pb || !pc) return null
  const v1 = { x: pa.x - pb.x, y: pa.y - pb.y }
  const v2 = { x: pc.x - pb.x, y: pc.y - pb.y }
  const size = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)
  if (size < 1e-6) return null
  return (Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / size))) * 180) / Math.PI
}

export function jointAngles(person: PersonPose) {
  const j = JOINTS
  return {
    leftKnee: angleAt(person, j.leftHip, j.leftKnee, j.leftAnkle),
    rightKnee: angleAt(person, j.rightHip, j.rightKnee, j.rightAnkle),
    leftElbow: angleAt(person, j.leftShoulder, j.leftElbow, j.leftWrist),
    rightElbow: angleAt(person, j.rightShoulder, j.rightElbow, j.rightWrist),
    leftHip: angleAt(person, j.leftShoulder, j.leftHip, j.leftKnee),
    rightHip: angleAt(person, j.rightShoulder, j.rightHip, j.rightKnee),
  }
}

export function frameAt(track: PoseTrack, t: number): PoseFrame | null {
  let best: PoseFrame | null = null
  for (const frame of track.frames) {
    if (Math.abs(frame.t - t) <= 0.75 / track.sampleFps && (!best || Math.abs(frame.t - t) < Math.abs(best.t - t))) best = frame
  }
  return best
}

// Each named player's feet path on the court, and how far they moved.
export function playerPaths(track: PoseTrack, court: CourtCalibration | null) {
  const paths = new Map<string, { t: number; x: number; y: number }[]>()
  for (const frame of track.frames) {
    for (const person of frame.people) {
      if (!person.player) continue
      const spot = feetOnCourt(person, court, track.sourceWidth, track.sourceHeight)
      if (!spot) continue
      const list = paths.get(person.player) ?? []
      list.push({ t: frame.t, ...spot })
      paths.set(person.player, list)
    }
  }
  const summary = new Map<string, { meters: number; seen: number }>()
  for (const [player, path] of paths) {
    let meters = 0
    for (let index = 1; index < path.length; index += 1) {
      const step = Math.hypot(path[index]!.x - path[index - 1]!.x, path[index]!.y - path[index - 1]!.y)
      // A jump faster than a sprint is a misplaced foot, not movement.
      if (step / Math.max(1e-3, path[index]!.t - path[index - 1]!.t) < 10) meters += step
    }
    summary.set(player, { meters, seen: path.length })
  }
  return { paths, summary }
}
