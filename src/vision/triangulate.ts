import type { BallPoint, BallTrack, CourtCalibration } from '../../shared/contracts.ts'
import { BALL_RADIUS, cameraFromCourt, GRAVITY, projectionRows, projectPoint, solveLinear, type CourtCamera, type Vec3 } from './flight.ts'

export type TakeView = {
  assetId: string
  label: string
  track: BallTrack
  court: CourtCalibration
  startedAt: number
}

export type TriangulatedPoint = { t: number; p: Vec3; errorPx: number; views: number }

export type TakeCamera = { assetId: string; label: string; position: Vec3; shiftMs: number; samples: number }

export type TakeTriangulation = {
  cameras: TakeCamera[]
  points: TriangulatedPoint[]
  medianErrorPx: number
  bounces: { t: number; p: Vec3 }[]
  peak: number
  topSpeed: number
}

const MAX_SAMPLE_GAP = 0.25
const SHIFT_REACH = 0.3
const MIN_SHARED = 6
const BOUNCE_HEIGHT = 0.35
const LOW_POINT_HEIGHT = 0.7
const ARC_SECONDS = 0.45
const CORNER_SECONDS = 0.06
const SPEED_CHORD_SECONDS = 0.15

type Ray = { rows: ReturnType<typeof projectionRows>; camera: CourtCamera }
type Prepared = { view: TakeView; ray: Ray; points: { t: number; u: number; v: number }[]; offset: number }

function sampleAt(points: Prepared['points'], t: number) {
  let low = 0
  let high = points.length - 1
  if (high < 0 || t < points[0]!.t - 1e-6 || t > points[high]!.t + 1e-6) return null
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (points[middle]!.t <= t) low = middle
    else high = middle
  }
  const a = points[low]!
  const b = points[high]!
  if (Math.abs(a.t - t) < 1e-6) return a
  if (Math.abs(b.t - t) < 1e-6) return b
  if (b.t - a.t > MAX_SAMPLE_GAP || t < a.t || t > b.t) return null
  const k = (t - a.t) / (b.t - a.t)
  return { t, u: a.u + (b.u - a.u) * k, v: a.v + (b.v - a.v) * k }
}

// Linear triangulation from two or more cameras, reweighted by depth so the residual is in pixels.
export function triangulate(rays: Ray[], samples: { u: number; v: number }[]) {
  let depths = rays.map(() => 1)
  let point: Vec3 | null = null
  for (let pass = 0; pass < 3; pass += 1) {
    const normal = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]
    const rhs = [0, 0, 0]
    rays.forEach((ray, index) => {
      const { m1, m2, m3, w1, w2, w3 } = ray.rows
      const sample = samples[index]!
      for (const [m, w, value] of [
        [m1, w1, sample.u],
        [m2, w2, sample.v],
      ] as const) {
        const weight = 1 / depths[index]!
        const a = [(m.x - value * m3.x) * weight, (m.y - value * m3.y) * weight, (m.z - value * m3.z) * weight]
        const b = -(w - value * w3) * weight
        for (let i = 0; i < 3; i += 1) {
          rhs[i]! += a[i]! * b
          for (let j = 0; j < 3; j += 1) normal[i]![j]! += a[i]! * a[j]!
        }
      }
    })
    const solved = solveLinear(normal, rhs)
    if (!solved) return null
    point = { x: solved[0]!, y: solved[1]!, z: solved[2]! }
    const at = point
    depths = rays.map((ray) => Math.max(0.5, ray.rows.m3.x * at.x + ray.rows.m3.y * at.y + ray.rows.m3.z * at.z + ray.rows.w3))
  }
  if (!point) return null
  let worst = 0
  rays.forEach((ray, index) => {
    const image = projectPoint(ray.camera, point!)
    const sample = samples[index]!
    worst = Math.max(worst, image ? Math.hypot(image.x - sample.u, image.y - sample.v) : Number.POSITIVE_INFINITY)
  })
  return { p: point, errorPx: worst }
}

function median(values: number[]) {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[sorted.length >> 1]!
}

// Recording start times are only good to tens of milliseconds, so each camera's shift against the
// first is searched for the value where the two cameras agree best on where the ball is.
function pairError(reference: Prepared, other: Prepared, shift: number) {
  const errors: number[] = []
  for (const sample of reference.points) {
    const t = sample.t + reference.offset
    const matched = sampleAt(other.points, t - other.offset - shift)
    if (!matched) continue
    const solved = triangulate([reference.ray, other.ray], [sample, matched])
    if (solved) errors.push(solved.errorPx)
  }
  return errors.length >= MIN_SHARED ? { error: median(errors), shared: errors.length } : null
}

function bestShift(reference: Prepared, other: Prepared) {
  let best = { shift: 0, error: Number.POSITIVE_INFINITY, shared: 0 }
  const tryShift = (shift: number) => {
    const result = pairError(reference, other, shift)
    if (result && result.error < best.error) best = { shift, ...result }
  }
  for (let shift = -SHIFT_REACH; shift <= SHIFT_REACH + 1e-9; shift += 0.01) tryShift(shift)
  const coarse = best.shift
  for (let shift = coarse - 0.01; shift <= coarse + 0.01 + 1e-9; shift += 0.001) tryShift(shift)
  return best
}

function prepare(view: TakeView, start: number): Prepared | null {
  const camera = cameraFromCourt(view.court)
  if (!camera) return null
  const sx = view.court.sourceWidth / view.track.sourceWidth
  const sy = view.court.sourceHeight / view.track.sourceHeight
  return {
    view,
    ray: { camera, rows: projectionRows(camera) },
    points: view.track.points.map((point: BallPoint) => ({ t: point.t, u: point.x * sx, v: point.y * sy })),
    offset: (view.startedAt - start) / 1000,
  }
}

export function triangulateTake(views: TakeView[], limitPx = 8): TakeTriangulation | null {
  const radius = BALL_RADIUS[views[0]?.court.preset ?? 'tennis-doubles']
  if (views.length < 2) return null
  const start = Math.min(...views.map((view) => view.startedAt))
  const prepared = views.map((view) => prepare(view, start)).filter((item): item is Prepared => item !== null)
  if (prepared.length < 2) return null
  const reference = prepared[0]!
  const shifts = prepared.map((item, index) => (index === 0 ? { shift: 0, shared: item.points.length } : bestShift(reference, item)))

  const times = new Set<number>()
  prepared.forEach((item, index) => {
    for (const sample of item.points) times.add(Math.round((sample.t + item.offset + shifts[index]!.shift) * 1000))
  })
  const points: TriangulatedPoint[] = []
  for (const ms of [...times].sort((a, b) => a - b)) {
    const t = ms / 1000
    const rays: Ray[] = []
    const samples: { u: number; v: number }[] = []
    prepared.forEach((item, index) => {
      const sample = sampleAt(item.points, t - item.offset - shifts[index]!.shift)
      if (!sample) return
      rays.push(item.ray)
      samples.push(sample)
    })
    if (rays.length < 2) continue
    const solved = triangulate(rays, samples)
    if (solved && solved.errorPx <= limitPx && solved.p.z > -0.5) {
      points.push({ t, p: solved.p, errorPx: solved.errorPx, views: rays.length })
    }
  }

  const bounces: TakeTriangulation['bounces'] = []
  let peak = 0
  let topSpeed = 0
  points.forEach((point, index) => {
    peak = Math.max(peak, point.p.z)
    // Neighbouring points are only a few hundredths of a second apart, so speed is read over a
    // longer chord to keep pixel noise from turning into speed.
    for (let ahead = index + 1; ahead < points.length; ahead += 1) {
      const later = points[ahead]!
      const dt = later.t - point.t
      if (dt > SPEED_CHORD_SECONDS * 2 || later.t - points[ahead - 1]!.t > MAX_SAMPLE_GAP) break
      if (dt < SPEED_CHORD_SECONDS) continue
      topSpeed = Math.max(topSpeed, Math.hypot(later.p.x - point.p.x, later.p.y - point.p.y, later.p.z - point.p.z) / dt)
      break
    }
  })
  for (const index of lowPoints(points)) {
    const bounce = groundContact(points, index, radius)
    const previous = bounces[bounces.length - 1]
    if (bounce && (!previous || bounce.t - previous.t > 0.2)) bounces.push(bounce)
  }

  return {
    cameras: prepared.map((item, index) => ({
      assetId: item.view.assetId,
      label: item.view.label,
      position: item.ray.camera.position,
      shiftMs: Math.round(shifts[index]!.shift * 1000),
      samples: shifts[index]!.shared,
    })),
    points,
    medianErrorPx: median(points.map((point) => point.errorPx)),
    bounces,
    peak,
    topSpeed,
  }
}

// Position and velocity under gravity at `anchor`, fitted per axis by least squares.
function fitArc(points: TriangulatedPoint[], anchor: number) {
  const axis = (pick: (p: Vec3) => number, fall: number) => {
    let s = 0
    let st = 0
    let stt = 0
    let sy = 0
    let sty = 0
    for (const point of points) {
      const tau = point.t - anchor
      const y = pick(point.p) + fall * 0.5 * GRAVITY * tau * tau
      s += 1
      st += tau
      stt += tau * tau
      sy += y
      sty += tau * y
    }
    const det = s * stt - st * st
    if (Math.abs(det) < 1e-12) return null
    return { at: (sy * stt - st * sty) / det, rate: (s * sty - st * sy) / det }
  }
  const x = axis((p) => p.x, 0)
  const y = axis((p) => p.y, 0)
  const z = axis((p) => p.z, 1)
  if (!x || !y || !z) return null
  return { t: anchor, p: { x: x.at, y: y.at, z: z.at }, v: { x: x.rate, y: y.rate, z: z.rate } }
}

type Arc = NonNullable<ReturnType<typeof fitArc>>

// When an arc of the ball is at height `z`, on the way down or on the way up.
function arcReaches(arc: Arc, z: number, falling: boolean) {
  const a = -0.5 * GRAVITY
  const b = arc.v.z
  const c = arc.p.z - z
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const roots = [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]
  const root = roots.find((tau) => (arc.v.z - GRAVITY * tau < 0) === falling)
  return root == null ? null : arc.t + root
}

function lowPoints(points: TriangulatedPoint[]) {
  const found: number[] = []
  points.forEach((point, index) => {
    if (point.p.z > LOW_POINT_HEIGHT) return
    const near = points.filter((other) => Math.abs(other.t - point.t) <= 0.15)
    if (near.some((other) => other.p.z < point.p.z)) return
    const rises = (side: number) =>
      points.some((other) => side * (other.t - point.t) > 0 && Math.abs(other.t - point.t) <= ARC_SECONDS && other.p.z - point.p.z > 0.25)
    if (rises(-1) && rises(1)) found.push(index)
  })
  return found
}

// Points right next to a bounce are interpolated across the sharp corner in each image, so the
// bounce is where the arcs on either side meet the ground rather than the lowest point seen.
function groundContact(points: TriangulatedPoint[], index: number, radius: number) {
  const center = points[index]!.t
  const before = points.filter((point) => point.t >= center - ARC_SECONDS && point.t <= center - CORNER_SECONDS)
  const after = points.filter((point) => point.t >= center + CORNER_SECONDS && point.t <= center + ARC_SECONDS)
  const raw = points[index]!
  const fallback = raw.p.z < BOUNCE_HEIGHT ? { t: raw.t, p: raw.p } : null
  if (before.length < 3 || after.length < 3) return fallback
  const incoming = fitArc(before, center)
  const outgoing = fitArc(after, center)
  if (!incoming || !outgoing) return fallback
  const down = arcReaches(incoming, radius, true)
  const up = arcReaches(outgoing, radius, false)
  if (down == null || up == null || Math.abs(down - center) > 0.2 || Math.abs(up - center) > 0.2) return fallback
  const t = (down + up) / 2
  const tau = t - incoming.t
  return { t, p: { x: incoming.p.x + incoming.v.x * tau, y: incoming.p.y + incoming.v.y * tau, z: radius } }
}

// Position and velocity at the end of the last stretch of 3D points, to hand to Rapier.
export function ballisticEnd(points: TriangulatedPoint[], count = 8) {
  const tail: TriangulatedPoint[] = []
  for (let index = points.length - 1; index >= 0 && tail.length < count; index -= 1) {
    const point = points[index]!
    const newer = tail[0]
    if (newer && newer.t - point.t > MAX_SAMPLE_GAP) break
    tail.unshift(point)
    const older = points[index - 1]
    const lowest = newer && older && point.p.z < BOUNCE_HEIGHT && point.p.z <= newer.p.z && point.p.z <= older.p.z
    if (lowest && tail.length >= 3) break
  }
  if (tail.length < 3) return null
  return fitArc(tail, tail[tail.length - 1]!.t)
}
