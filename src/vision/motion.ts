import type { BallTrack, CourtCalibration, MotionTrack, PoseTrack } from '../../shared/contracts.ts'

export type Homography = number[]

export const IDENTITY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1]
// A match with fewer RANSAC inliers than this is not trusted.
export const MIN_INLIERS = 12

export function applyHomography(h: Homography, point: { x: number; y: number }) {
  const w = h[6]! * point.x + h[7]! * point.y + h[8]!
  if (Math.abs(w) < 1e-12) return null
  return { x: (h[0]! * point.x + h[1]! * point.y + h[2]!) / w, y: (h[3]! * point.x + h[4]! * point.y + h[5]!) / w }
}

export function invertHomography(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, k, i] = h as [number, number, number, number, number, number, number, number, number]
  const det = a * (e * i - f * k) - b * (d * i - f * g) + c * (d * k - e * g)
  if (Math.abs(det) < 1e-12) return null
  const inverse = [e * i - f * k, c * k - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * k - e * g, b * g - a * k, a * e - b * d]
  return inverse.map((value) => value / det)
}

export function multiplyHomography(a: Homography, b: Homography): Homography {
  const out: number[] = []
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0
      for (let k = 0; k < 3; k += 1) sum += a[row * 3 + k]! * b[k * 3 + col]!
      out.push(sum)
    }
  }
  return out
}

function normalized(h: Homography) {
  return Math.abs(h[8]!) > 1e-12 ? h.map((value) => value / h[8]!) : h
}

// The camera motion at time t, blended between the two nearest measured frames.
export function motionAt(track: MotionTrack, t: number): Homography | null {
  const frames = track.frames
  if (frames.length === 0) return null
  let after = frames.findIndex((frame) => frame.t >= t)
  if (after < 0) after = frames.length - 1
  const before = Math.max(0, after - 1)
  const a = frames[before]!
  const b = frames[after]!
  if (b.t <= a.t || t <= a.t) return normalized(t <= a.t ? a.h : b.h)
  if (t >= b.t) return normalized(b.h)
  const k = (t - a.t) / (b.t - a.t)
  const ha = normalized(a.h)
  const hb = normalized(b.h)
  return ha.map((value, index) => value + (hb[index]! - value) * k)
}

// The court as it sits in a moved frame: the marked points carried along with the camera.
export function movedCourt(court: CourtCalibration, h: Homography): CourtCalibration {
  return {
    ...court,
    imagePoints: court.imagePoints.map((point) => applyHomography(h, point) ?? point),
  }
}

// A frame point, in pixels of a frame sized width x height, put back where it would be in the court photo's view.
function steady(inverse: Homography, court: CourtCalibration, width: number, height: number, point: { x: number; y: number }) {
  const kx = court.sourceWidth / width
  const ky = court.sourceHeight / height
  const back = applyHomography(inverse, { x: point.x * kx, y: point.y * ky })
  return back ? { x: back.x / kx, y: back.y / ky } : point
}

// The ball as if the camera had not moved, so fits and line calls use the court as marked.
export function steadyBallTrack(track: BallTrack, motion: MotionTrack, court: CourtCalibration): BallTrack {
  return {
    ...track,
    points: track.points.map((point) => {
      const h = motionAt(motion, point.t)
      const inverse = h ? invertHomography(h) : null
      if (!inverse) return point
      const center = steady(inverse, court, track.sourceWidth, track.sourceHeight, point)
      const bottom = steady(inverse, court, track.sourceWidth, track.sourceHeight, { x: point.x, y: point.y + point.radius })
      return { ...point, x: center.x, y: center.y, radius: Math.max(0.5, Math.hypot(bottom.x - center.x, bottom.y - center.y)) }
    }),
  }
}

export function steadyPoseTrack(track: PoseTrack, motion: MotionTrack, court: CourtCalibration): PoseTrack {
  return {
    ...track,
    frames: track.frames.map((frame) => {
      const h = motionAt(motion, frame.t)
      const inverse = h ? invertHomography(h) : null
      if (!inverse) return frame
      const move = (point: { x: number; y: number }) => steady(inverse, court, track.sourceWidth, track.sourceHeight, point)
      return {
        ...frame,
        people: frame.people.map((person) => {
          const keypoints = person.keypoints.slice()
          for (let index = 0; index < keypoints.length; index += 3) {
            const point = move({ x: keypoints[index]!, y: keypoints[index + 1]! })
            keypoints[index] = point.x
            keypoints[index + 1] = point.y
          }
          const corners = [
            move({ x: person.box.x, y: person.box.y }),
            move({ x: person.box.x + person.box.width, y: person.box.y + person.box.height }),
          ]
          const x = Math.min(corners[0]!.x, corners[1]!.x)
          const y = Math.min(corners[0]!.y, corners[1]!.y)
          return { ...person, keypoints, box: { x, y, width: Math.abs(corners[1]!.x - corners[0]!.x), height: Math.abs(corners[1]!.y - corners[0]!.y) } }
        }),
      }
    }),
  }
}

// How far the camera moved: the largest shift of the photo's center, in photo pixels, and its largest turn.
export function motionSummary(track: MotionTrack) {
  const center = { x: track.sourceWidth / 2, y: track.sourceHeight / 2 }
  const right = { x: track.sourceWidth / 2 + 100, y: track.sourceHeight / 2 }
  let shift = 0
  let turn = 0
  let trusted = 0
  for (const frame of track.frames) {
    if (frame.inliers >= MIN_INLIERS) trusted += 1
    const a = applyHomography(frame.h, center)
    const b = applyHomography(frame.h, right)
    if (!a || !b) continue
    shift = Math.max(shift, Math.hypot(a.x - center.x, a.y - center.y))
    turn = Math.max(turn, Math.abs((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI))
  }
  return { shift, turn, trusted, total: track.frames.length }
}

// A CSS matrix3d for a homography that maps frame pixels to the page, with the frame's top-left at the origin.
export function cssMatrix(h: Homography) {
  const n = normalized(h)
  return `matrix3d(${n[0]}, ${n[3]}, 0, ${n[6]}, ${n[1]}, ${n[4]}, 0, ${n[7]}, 0, 0, 1, 0, ${n[2]}, ${n[5]}, 0, ${n[8]})`
}
