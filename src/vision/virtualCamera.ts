import { COURT_PRESETS, type CourtPreset, type PersonPose } from '../../shared/contracts.ts'
import type { CourtCamera, Vec3 } from './flight.ts'
import { toMeters, type Units } from '../units.ts'

export type ViewSide = 'left' | 'center' | 'right'
export type ViewEnd = 'near' | 'far'

// Where the virtual camera stands: behind one baseline, at a height, on one side. Lengths in meters.
export type ViewSpot = { behind: number; height: number; side: ViewSide; end: ViewEnd }

export const DEFAULT_VIEW: ViewSpot = { behind: 3.048, height: 4.572, side: 'right', end: 'near' }

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)\s*(ft|feet|foot|'|m|meters?|metres?)?`

function readLength(text: string, words: string, units: Units) {
  const match = new RegExp(`${NUMBER}\\s*(?:${words})`, 'i').exec(text)
  if (!match) return null
  const value = Number(match[1]!.replace(',', '.'))
  const unit = match[2]?.toLowerCase()
  const given: Units = !unit ? units : unit.startsWith('m') ? 'm' : 'ft'
  return toMeters(value, given)
}

// Reads a request like "10 feet behind the baseline, 15 feet above, on the right side".
// Lengths without a unit use the units chosen in the header.
export function parseViewCommand(text: string, units: Units, current: ViewSpot = DEFAULT_VIEW): ViewSpot | null {
  const lower = text.toLowerCase()
  const behind = readLength(lower, 'behind|back|from the baseline|peeche|piche', units)
  const height = readLength(lower, 'above|high|up|over|tall|upar|oopar|unchai', units)
  const side: ViewSide | null = /\bright\b|daaye|daye|dayen/.test(lower)
    ? 'right'
    : /\bleft\b|baaye|baye|bayen/.test(lower)
      ? 'left'
      : /\bcent(er|re)\b|\bmiddle\b|beech|bich/.test(lower)
        ? 'center'
        : null
  const end: ViewEnd | null = /\bfar\b|other end|opposite/.test(lower) ? 'far' : /\bnear\b/.test(lower) ? 'near' : null
  if (behind == null && height == null && !side && !end) return null
  return {
    behind: behind ?? current.behind,
    height: height ?? current.height,
    side: side ?? current.side,
    end: end ?? current.end,
  }
}

// Court coordinates for the spot, looking at the middle of the court.
export function viewPose(preset: CourtPreset, spot: ViewSpot) {
  const { widthMeters: w, lengthMeters: l } = COURT_PRESETS[preset]
  // Left and right are as seen by someone standing behind that baseline, facing the court.
  const rightX = spot.end === 'near' ? w : 0
  const leftX = spot.end === 'near' ? 0 : w
  const x = spot.side === 'center' ? w / 2 : spot.side === 'right' ? rightX : leftX
  const y = spot.end === 'near' ? -spot.behind : l + spot.behind
  return { position: { x, y, z: Math.max(0.2, spot.height) }, target: { x: w / 2, y: l / 2, z: 0 } }
}

// Stands a 2D skeleton up in 3D: each joint's camera ray is cut by an upright plane through the
// feet, facing the camera. Heights come out right; depth within the body is flattened.
export function liftPerson(person: PersonPose, camera: CourtCamera, feet: { x: number; y: number }, scaleX: number, scaleY: number) {
  const c = camera.position
  const toward = { x: feet.x - c.x, y: feet.y - c.y }
  const size = Math.hypot(toward.x, toward.y)
  if (size < 1e-6) return null
  const n = { x: toward.x / size, y: toward.y / size }
  const [r0, r1, r2] = camera.rows
  const joints: (Vec3 | null)[] = []
  for (let index = 0; index < person.keypoints.length / 3; index += 1) {
    if ((person.keypoints[index * 3 + 2] ?? 0) < 0.3) {
      joints.push(null)
      continue
    }
    const u = (person.keypoints[index * 3]! * scaleX - camera.cx) / camera.focal
    const v = (person.keypoints[index * 3 + 1]! * scaleY - camera.cy) / camera.focal
    const d = {
      x: r0.x * u + r1.x * v + r2.x,
      y: r0.y * u + r1.y * v + r2.y,
      z: r0.z * u + r1.z * v + r2.z,
    }
    const facing = n.x * d.x + n.y * d.y
    if (facing <= 1e-6) {
      joints.push(null)
      continue
    }
    const s = (n.x * (feet.x - c.x) + n.y * (feet.y - c.y)) / facing
    joints.push({ x: c.x + s * d.x, y: c.y + s * d.y, z: Math.max(0, c.z + s * d.z) })
  }
  return joints
}
