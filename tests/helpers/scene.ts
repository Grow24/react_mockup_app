import type { BallPoint, BallTrack, CourtCalibration } from '../../shared/contracts.ts'
import { courtWorldPoints } from '../../shared/court.ts'
import { projectPoint, type CourtCamera, type Vec3 } from '../../src/vision/flight.ts'

// A known camera, court, and ball flight, so the vision math can be checked against ground truth.
export const W = 10.97
export const L = 23.77
export const R = 0.033
const RESTITUTION = 0.75

export function lookAtCamera(position: Vec3, target: Vec3, focal: number, width: number, height: number): CourtCamera {
  const sub = (a: Vec3, b: Vec3) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
  const unit = (a: Vec3) => {
    const n = Math.hypot(a.x, a.y, a.z)
    return { x: a.x / n, y: a.y / n, z: a.z / n }
  }
  const cross = (a: Vec3, b: Vec3) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
  const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
  const forward = unit(sub(target, position))
  const right = unit(cross(forward, { x: 0, y: 0, z: 1 }))
  const down = cross(forward, right)
  return {
    focal,
    cx: width / 2,
    cy: height / 2,
    rows: [right, down, forward],
    translation: { x: -dot(right, position), y: -dot(down, position), z: -dot(forward, position) },
    position,
    focalEstimated: true,
  }
}

/** Leaves (2, 1, 1), bounces exactly at t = 1.0 s at (3.5, 15), and rises again. */
export function truth(t: number): Vec3 {
  const v0 = { x: 1.5, y: 14, z: R - 1 + 4.905 }
  if (t <= 1) return { x: 2 + v0.x * t, y: 1 + v0.y * t, z: 1 + v0.z * t - 4.905 * t * t }
  const up = RESTITUTION * (9.81 - v0.z)
  const s = t - 1
  return { x: 3.5 + v0.x * s, y: 15 + v0.y * s, z: R + up * s - 4.905 * s * s }
}

export function courtFor(camera: CourtCamera, width: number, height: number, landmarks?: string[]): CourtCalibration {
  const court: CourtCalibration = { preset: 'tennis-doubles', assetId: 'scene', sourceWidth: width, sourceHeight: height, imagePoints: [] }
  if (landmarks) court.landmarks = landmarks
  court.imagePoints = courtWorldPoints(court).map((world) => {
    const point = projectPoint(camera, { ...world, z: 0 })!
    return { x: point.x, y: point.y }
  })
  return court
}

export const behind = lookAtCamera({ x: W / 2 + 1, y: -9, z: 6 }, { x: W / 2, y: L / 2, z: 0 }, 475, 640, 360)
export const corner = lookAtCamera({ x: W + 16, y: -2, z: 7 }, { x: W / 2, y: L / 2, z: 0.5 }, 330, 640, 360)

// Deterministic noise in [-amount, amount].
export function noise(seed: number) {
  let state = seed
  return (amount: number) => {
    state = (state * 16807) % 2147483647
    return (state / 2147483647 - 0.5) * 2 * amount
  }
}

export function trackOf(points: BallPoint[], duration: number): BallTrack {
  return { assetId: 'scene', modelId: 'test', sourceWidth: 640, sourceHeight: 360, sampleFps: 10, duration, createdAt: 0, points }
}
