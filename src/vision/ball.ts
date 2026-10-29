import type { BallPoint, BallTrack, CourtCalibration, CourtPoint, Detection } from '../../shared/contracts.ts'

export type BallCandidate = {
  x: number
  y: number
  radius: number
  score: number
}

export type BallFrame = {
  t: number
  candidates: BallCandidate[]
}

const LOST_AFTER_SECONDS = 0.6
const BOUNCE_GAP_SECONDS = 0.4

export function candidatesFrom(detections: Detection[]): BallCandidate[] {
  return detections.map((detection) => ({
    x: detection.box.x + detection.box.width / 2,
    y: detection.box.y + detection.box.height / 2,
    radius: Math.max(1, (detection.box.width + detection.box.height) / 4),
    score: detection.score,
  }))
}

function strongest(candidates: BallCandidate[]) {
  let best: BallCandidate | undefined
  for (const candidate of candidates) {
    if (!best || candidate.score > best.score) best = candidate
  }
  return best
}

function nearestToPrediction(points: BallPoint[], candidates: BallCandidate[], t: number, diagonal: number) {
  const last = points[points.length - 1]!
  const before = points[points.length - 2]
  const dt = t - last.t
  let vx = 0
  let vy = 0
  if (before && last.t - before.t > 0 && last.t - before.t <= LOST_AFTER_SECONDS) {
    vx = (last.x - before.x) / (last.t - before.t)
    vy = (last.y - before.y) / (last.t - before.t)
  }
  const predictedX = last.x + vx * dt
  const predictedY = last.y + vy * dt
  const gate = diagonal * 0.08 + Math.hypot(vx, vy) * dt * 0.75 + last.radius * 2
  let best: BallCandidate | undefined
  let bestCost = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.x - predictedX, candidate.y - predictedY)
    if (distance > gate) continue
    const cost = distance / gate - candidate.score * 0.5
    if (cost < bestCost) {
      bestCost = cost
      best = candidate
    }
  }
  return best
}

// Image y grows downward, so a bounce is the ball moving down the frame and then back up.
export function markBounces(points: BallPoint[], sourceHeight: number): BallPoint[] {
  const minSpeed = sourceHeight * 0.08
  return points.map((point, index) => {
    const plain: BallPoint = { t: point.t, x: point.x, y: point.y, radius: point.radius, score: point.score }
    const before = points[index - 1]
    const after = points[index + 1]
    if (!before || !after) return plain
    const dtBefore = point.t - before.t
    const dtAfter = after.t - point.t
    if (dtBefore <= 0 || dtAfter <= 0 || dtBefore > BOUNCE_GAP_SECONDS || dtAfter > BOUNCE_GAP_SECONDS) return plain
    const down = (point.y - before.y) / dtBefore
    const up = (after.y - point.y) / dtAfter
    return down > minSpeed && up < -minSpeed ? { ...plain, bounce: true } : plain
  })
}

export function linkBallTrack(frames: BallFrame[], sourceWidth: number, sourceHeight: number): BallPoint[] {
  const diagonal = Math.hypot(sourceWidth, sourceHeight)
  const points: BallPoint[] = []
  for (const frame of frames) {
    if (frame.candidates.length === 0) continue
    const last = points[points.length - 1]
    const choice =
      !last || frame.t - last.t > LOST_AFTER_SECONDS
        ? strongest(frame.candidates)
        : nearestToPrediction(points, frame.candidates, frame.t, diagonal)
    if (!choice) continue
    points.push({ t: frame.t, x: choice.x, y: choice.y, radius: choice.radius, score: choice.score })
  }
  return markBounces(points, sourceHeight)
}

export function trailAt(points: BallPoint[], t: number, seconds = 1) {
  return points.filter((point) => point.t <= t + 1e-3 && point.t >= t - seconds)
}

export function pointAt(points: BallPoint[], t: number, tolerance: number) {
  let best: BallPoint | undefined
  for (const point of points) {
    const gap = Math.abs(point.t - t)
    if (gap <= tolerance && (!best || gap < Math.abs(best.t - t))) best = point
  }
  return best
}

export function courtFitsTrack(track: BallTrack, court: CourtCalibration) {
  const trackAspect = track.sourceWidth / track.sourceHeight
  const courtAspect = court.sourceWidth / court.sourceHeight
  return Math.abs(trackAspect - courtAspect) / courtAspect < 0.02
}

// The bottom of the ball is where it touches the ground, in the court photo's pixels.
export function groundPoints(track: BallTrack, court: CourtCalibration): CourtPoint[] {
  const scaleX = court.sourceWidth / track.sourceWidth
  const scaleY = court.sourceHeight / track.sourceHeight
  return track.points.map((point) => ({ x: point.x * scaleX, y: (point.y + point.radius) * scaleY }))
}
