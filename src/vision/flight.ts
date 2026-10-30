import { COURT_PRESETS, type BallPoint, type BallTrack, type CourtCalibration, type CourtPreset } from '../../shared/contracts.ts'

export type Vec3 = { x: number; y: number; z: number }

export const GRAVITY = 9.81
export const BALL_RADIUS: Record<CourtPreset, number> = { 'tennis-doubles': 0.033, 'cricket-pitch': 0.036 }
export const RESTITUTION: Record<CourtPreset, number> = { 'tennis-doubles': 0.75, 'cricket-pitch': 0.55 }

const MIN_FLIGHT_POINTS = 4
const MAX_GAP_SECONDS = 0.4
const BOUNCE_WEIGHT = 200
const POOR_FIT_FLOOR_PX = 4
const BEHIND_CAMERA_PX = 1000
const MAX_FLIGHT_SECONDS = 4
// Faster than any tennis serve or cricket delivery.
const MAX_SPEED = 75
const BOUNCE_PRIOR_WEIGHT = 1.5
const BOUNCE_KEEPS_HORIZONTAL = 0.8

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k })
const minus = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const unit = (a: Vec3) => scale(a, 1 / Math.hypot(a.x, a.y, a.z))

export function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length
  const a = matrix.map((row) => row.slice())
  const b = rhs.slice()
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null
    ;[a[col], a[pivot]] = [a[pivot]!, a[col]!]
    ;[b[col], b[pivot]] = [b[pivot]!, b[col]!]
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row]![col]! / a[col]![col]!
      for (let k = col; k < n; k += 1) a[row]![k]! -= factor * a[col]![k]!
      b[row]! -= factor * b[col]!
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row]!
    for (let k = row + 1; k < n; k += 1) sum -= a[row]![k]! * x[k]!
    x[row] = sum / a[row]![row]!
  }
  return x
}

// World meters: x from the left line, y from the near line, z up from the ground.
export function courtCorners(preset: CourtPreset) {
  const { widthMeters: w, lengthMeters: l } = COURT_PRESETS[preset]
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: l },
    { x: 0, y: l },
  ]
}

export function courtHomography(court: CourtCalibration): number[] | null {
  const rows: number[][] = []
  const rhs: number[] = []
  courtCorners(court.preset).forEach((world, index) => {
    const image = court.imagePoints[index]!
    rows.push([world.x, world.y, 1, 0, 0, 0, -image.x * world.x, -image.x * world.y])
    rhs.push(image.x)
    rows.push([0, 0, 0, world.x, world.y, 1, -image.y * world.x, -image.y * world.y])
    rhs.push(image.y)
  })
  const h = solveLinear(rows, rhs)
  return h ? [...h, 1] : null
}

// Maps a point on the ground in the court photo's pixels back to court meters.
export function groundFromImage(court: CourtCalibration) {
  const h = courtHomography(court)
  if (!h) return null
  const [a, b, c, d, e, f, g, k, i] = h as [number, number, number, number, number, number, number, number, number]
  const inverse = [
    e * i - f * k,
    c * k - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * k - e * g,
    b * g - a * k,
    a * e - b * d,
  ]
  return (point: { x: number; y: number }) => {
    const w = inverse[6]! * point.x + inverse[7]! * point.y + inverse[8]!
    if (Math.abs(w) < 1e-12) return null
    return {
      x: (inverse[0]! * point.x + inverse[1]! * point.y + inverse[2]!) / w,
      y: (inverse[3]! * point.x + inverse[4]! * point.y + inverse[5]!) / w,
    }
  }
}

// Lines are part of the court, so a ball touching the line is in.
export function lineCall(preset: CourtPreset, spot: { x: number; y: number }, radius = BALL_RADIUS[preset]): 'in' | 'out' {
  const { widthMeters, lengthMeters } = COURT_PRESETS[preset]
  const inside = spot.x >= -radius && spot.y >= -radius && spot.x <= widthMeters + radius && spot.y <= lengthMeters + radius
  return inside ? 'in' : 'out'
}

export type CourtCamera = {
  focal: number
  cx: number
  cy: number
  rows: [Vec3, Vec3, Vec3]
  translation: Vec3
  position: Vec3
  focalEstimated: boolean
}

export function cameraFromCourt(court: CourtCalibration): CourtCamera | null {
  const h = courtHomography(court)
  if (!h) return null
  const cx = court.sourceWidth / 2
  const cy = court.sourceHeight / 2
  const column = (index: number): Vec3 => ({
    x: h[index]! - cx * h[6 + index]!,
    y: h[3 + index]! - cy * h[6 + index]!,
    z: h[6 + index]!,
  })
  const c1 = column(0)
  const c2 = column(1)
  const c3 = column(2)

  // With square pixels and a centered principal point, the two rotation columns
  // being orthogonal and equal length gives two equations for 1 / focal².
  const a1 = c1.x * c2.x + c1.y * c2.y
  const b1 = c1.z * c2.z
  const a2 = c1.x * c1.x + c1.y * c1.y - c2.x * c2.x - c2.y * c2.y
  const b2 = c1.z * c1.z - c2.z * c2.z
  const inverseSquared = -(a1 * b1 + a2 * b2) / (a1 * a1 + a2 * a2)
  const longSide = Math.max(court.sourceWidth, court.sourceHeight)
  let focal = inverseSquared > 0 ? 1 / Math.sqrt(inverseSquared) : Number.NaN
  const focalEstimated = Number.isFinite(focal) && focal > longSide * 0.3 && focal < longSide * 10
  if (!focalEstimated) focal = longSide * 0.8

  const k1 = { x: c1.x / focal, y: c1.y / focal, z: c1.z }
  const k2 = { x: c2.x / focal, y: c2.y / focal, z: c2.z }
  const k3 = { x: c3.x / focal, y: c3.y / focal, z: c3.z }
  let lambda = 2 / (Math.hypot(k1.x, k1.y, k1.z) + Math.hypot(k2.x, k2.y, k2.z))
  if (lambda * k3.z < 0) lambda = -lambda
  const r1 = unit(scale(k1, lambda))
  const raw2 = scale(k2, lambda)
  const r2 = unit(minus(raw2, scale(r1, dot(r1, raw2))))
  const r3 = cross(r1, r2)
  const translation = scale(k3, lambda)
  const position = { x: -dot(r1, translation), y: -dot(r2, translation), z: -dot(r3, translation) }
  if (!(position.z > 0)) return null
  const rows: [Vec3, Vec3, Vec3] = [
    { x: r1.x, y: r2.x, z: r3.x },
    { x: r1.y, y: r2.y, z: r3.y },
    { x: r1.z, y: r2.z, z: r3.z },
  ]
  return { focal, cx, cy, rows, translation, position, focalEstimated }
}

// The rows of K [R | t]: u = (m1·P + w1) / (m3·P + w3) and v = (m2·P + w2) / (m3·P + w3).
export function projectionRows(camera: CourtCamera) {
  const { focal, cx, cy, rows, translation } = camera
  return {
    m1: { x: focal * rows[0].x + cx * rows[2].x, y: focal * rows[0].y + cx * rows[2].y, z: focal * rows[0].z + cx * rows[2].z },
    m2: { x: focal * rows[1].x + cy * rows[2].x, y: focal * rows[1].y + cy * rows[2].y, z: focal * rows[1].z + cy * rows[2].z },
    m3: rows[2],
    w1: focal * translation.x + cx * translation.z,
    w2: focal * translation.y + cy * translation.z,
    w3: translation.z,
  }
}

export function projectPoint(camera: CourtCamera, point: Vec3) {
  const x = dot(camera.rows[0], point) + camera.translation.x
  const y = dot(camera.rows[1], point) + camera.translation.y
  const z = dot(camera.rows[2], point) + camera.translation.z
  if (z <= 1e-6) return null
  return { x: (camera.focal * x) / z + camera.cx, y: (camera.focal * y) / z + camera.cy, depth: z }
}

export type Flight = {
  t0: number
  from: number
  to: number
  p0: Vec3
  v0: Vec3
  rmsPx: number
  observed: number
  startBounce: number | null
  endBounce: number | null
  reliable: boolean
}

export function positionAt(flight: Flight, t: number): Vec3 {
  const tau = t - flight.t0
  return {
    x: flight.p0.x + flight.v0.x * tau,
    y: flight.p0.y + flight.v0.y * tau,
    z: flight.p0.z + flight.v0.z * tau - 0.5 * GRAVITY * tau * tau,
  }
}

export function velocityAt(flight: Flight, t: number): Vec3 {
  return { x: flight.v0.x, y: flight.v0.y, z: flight.v0.z - GRAVITY * (t - flight.t0) }
}

export function peakHeight(flight: Flight) {
  const top = flight.t0 + flight.v0.z / GRAVITY
  return positionAt(flight, Math.min(flight.to, Math.max(flight.from, top))).z
}

type Observation = { t: number; u: number; v: number }

export type FlightBreak = { t: number; bounce: boolean }

type Chain = { refs: number[]; params: number[]; rms: number[]; cost: number }

function chainState(chain: { refs: number[]; params: number[] }, index: number, t: number): Vec3 {
  const p = chain.params
  const base = index * 6
  const tau = t - chain.refs[index]!
  return {
    x: p[base]! + p[base + 3]! * tau,
    y: p[base + 1]! + p[base + 4]! * tau,
    z: p[base + 2]! + p[base + 5]! * tau - 0.5 * GRAVITY * tau * tau,
  }
}

function chainClimb(chain: { refs: number[]; params: number[] }, index: number, t: number) {
  return chain.params[index * 6 + 5]! - GRAVITY * (t - chain.refs[index]!)
}

// Each flight is linear in its start position and velocity once gravity is known. Flights are
// linked by a continuous position at every break, and a bounce also pins that point to the ground.
// Rows are reweighted by depth so the residual approximates pixels.
export type BounceModel = { radius: number; restitution: number }

export function solveChain(
  camera: CourtCamera,
  groups: Observation[][],
  breaks: FlightBreak[],
  model: BounceModel,
  passes = 4,
): Chain | null {
  const { m1, m2, m3, w1, w2, w3 } = projectionRows(camera)
  const size = groups.length * 6
  const refs = groups.map((group) => group[0]!.t)
  let depths = groups.map((group) => group.map(() => 1))
  let params: number[] | null = null
  for (let pass = 0; pass < passes; pass += 1) {
    const normal = Array.from({ length: size }, () => new Array<number>(size).fill(0))
    const rhs = new Array<number>(size).fill(0)
    const add = (entries: [number, number][], value: number) => {
      for (const [i, a] of entries) {
        rhs[i]! += a * value
        for (const [j, b] of entries) normal[i]![j]! += a * b
      }
    }
    groups.forEach((group, k) => {
      group.forEach((observation, index) => {
        const tau = observation.t - refs[k]!
        const fall = 0.5 * GRAVITY * tau * tau
        const weight = 1 / depths[k]![index]!
        for (const [m, w, value] of [
          [m1, w1, observation.u],
          [m2, w2, observation.v],
        ] as const) {
          const a = [m.x - value * m3.x, m.y - value * m3.y, m.z - value * m3.z]
          const b = -(w - value * w3)
          add(
            [0, 1, 2, 3, 4, 5].map((c) => [k * 6 + c, (c < 3 ? a[c]! : tau * a[c - 3]!) * weight] as [number, number]),
            (b + a[2]! * fall) * weight,
          )
        }
      })
    })
    breaks.forEach((item, k) => {
      const before = item.t - refs[k]!
      const after = item.t - refs[k + 1]!
      for (let axis = 0; axis < 3; axis += 1) {
        add(
          [
            [k * 6 + axis, BOUNCE_WEIGHT],
            [k * 6 + 3 + axis, BOUNCE_WEIGHT * before],
            [(k + 1) * 6 + axis, -BOUNCE_WEIGHT],
            [(k + 1) * 6 + 3 + axis, -BOUNCE_WEIGHT * after],
          ],
          axis === 2 ? 0.5 * GRAVITY * (before * before - after * after) * BOUNCE_WEIGHT : 0,
        )
      }
      if (item.bounce) {
        add(
          [
            [k * 6 + 2, BOUNCE_WEIGHT],
            [k * 6 + 5, BOUNCE_WEIGHT * before],
          ],
          BOUNCE_WEIGHT * (model.radius + 0.5 * GRAVITY * before * before),
        )
        // A soft bounce model: some horizontal speed is kept and the fall turns into a smaller rise.
        for (const axis of [3, 4]) {
          add(
            [
              [(k + 1) * 6 + axis, BOUNCE_PRIOR_WEIGHT],
              [k * 6 + axis, -BOUNCE_PRIOR_WEIGHT * BOUNCE_KEEPS_HORIZONTAL],
            ],
            0,
          )
        }
        add(
          [
            [(k + 1) * 6 + 5, BOUNCE_PRIOR_WEIGHT],
            [k * 6 + 5, BOUNCE_PRIOR_WEIGHT * model.restitution],
          ],
          BOUNCE_PRIOR_WEIGHT * GRAVITY * (after + model.restitution * before),
        )
      }
    })
    params = solveLinear(normal, rhs)
    if (!params) return null
    const solved = { refs, params }
    depths = groups.map((group, k) =>
      group.map((observation) => Math.max(0.5, dot(m3, chainState(solved, k, observation.t)) + w3)),
    )
  }
  if (!params) return null
  const solved = { refs, params }
  let cost = 0
  const rms: number[] = []
  for (let k = 0; k < groups.length; k += 1) {
    let squared = 0
    for (const observation of groups[k]!) {
      const image = projectPoint(camera, chainState(solved, k, observation.t))
      squared += image ? (image.x - observation.u) ** 2 + (image.y - observation.v) ** 2 : BEHIND_CAMERA_PX ** 2
    }
    cost += squared
    rms.push(Math.sqrt(squared / groups[k]!.length))
  }
  return { refs, params, rms, cost }
}

function splitOnGaps(points: BallPoint[]) {
  const pieces: BallPoint[][] = []
  let current: BallPoint[] = []
  for (const point of points) {
    const last = current[current.length - 1]
    if (last && point.t - last.t > MAX_GAP_SECONDS) {
      pieces.push(current)
      current = []
    }
    current.push(point)
  }
  if (current.length > 0) pieces.push(current)
  return pieces
}

// A ball racing along the camera's line of sight can explain almost any still image point,
// so a flight also has to be a speed and height a real ball can have.
function physical(chain: Chain, index: number, from: number, to: number) {
  const v = { x: chain.params[index * 6 + 3]!, y: chain.params[index * 6 + 4]!, z: chain.params[index * 6 + 5]! }
  if (Math.hypot(v.x, v.y, v.z) > MAX_SPEED) return false
  const low = Math.min(chainState(chain, index, from).z, chainState(chain, index, to).z)
  const top = Math.max(chainState(chain, index, from).z, chainState(chain, index, to).z)
  return low > -0.5 && top < 40
}

function freeCost(camera: CourtCamera, observations: Observation[]) {
  const chain = solveChain(camera, [observations], [], { radius: 0, restitution: 0 }, 2)
  if (!chain || !physical(chain, 0, observations[0]!.t, observations[observations.length - 1]!.t)) {
    return Number.POSITIVE_INFINITY
  }
  return chain.cost
}

type Segment = { observations: Observation[]; flight: boolean }

// Bounces and racket or bat hits both break a gravity fit. The cheapest set of flights wins,
// where each extra flight pays for its six unknowns. A held, rolling, or misdetected stretch can be
// set aside at a flat cost per frame so it does not bend the real flights around it.
function segment(camera: CourtCamera, observations: Observation[], targetPx: number, limitPx: number): Segment[] {
  const count = observations.length
  const penalty = targetPx * targetPx * 12
  const asideCost = limitPx * limitPx
  const best = new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY)
  const from = new Array<number>(count + 1).fill(-1)
  const kind = new Array<boolean>(count + 1).fill(false)
  best[0] = 0
  for (let end = 1; end <= count; end += 1) {
    for (let start = end - 1; start >= 0; start -= 1) {
      if (observations[end - 1]!.t - observations[start]!.t > MAX_FLIGHT_SECONDS) break
      const length = end - start
      const aside = best[start]! + asideCost * length + penalty
      if (aside < best[end]!) {
        best[end] = aside
        from[end] = start
        kind[end] = false
      }
      if (length < MIN_FLIGHT_POINTS) continue
      const flight = best[start]! + freeCost(camera, observations.slice(start, end)) + penalty
      if (flight < best[end]!) {
        best[end] = flight
        from[end] = start
        kind[end] = true
      }
    }
  }
  const segments: Segment[] = []
  for (let end = count; end > 0; end = from[end]!) {
    const previous = segments[0]
    const piece = { observations: observations.slice(from[end]!, end), flight: kind[end]! }
    if (previous && !previous.flight && !piece.flight) previous.observations.unshift(...piece.observations)
    else segments.unshift(piece)
  }
  return segments
}

// Searches one break's time inside a window of neighbouring flights, with the other breaks held.
function bestBreak(
  camera: CourtCamera,
  groups: Observation[][],
  breaks: FlightBreak[],
  index: number,
  bounce: boolean,
  model: BounceModel,
) {
  const before = groups[index]!
  const after = groups[index + 1]!
  const lastSeen = before[before.length - 1]!.t
  const nextSeen = after[0]!.t
  const low = Math.max(before[0]!.t + 0.01, lastSeen - 0.08)
  const high = Math.min(after[after.length - 1]!.t - 0.01, nextSeen + 0.08)
  const found: { best: { t: number; chain: Chain } | null } = { best: null }
  const tryAt = (t: number) => {
    if (t < low || t > high) return
    const trial = breaks.slice()
    trial[index] = { t, bounce }
    const chain = solveChain(camera, groups, trial, model)
    if (chain && (!found.best || chain.cost < found.best.chain.cost)) found.best = { t, chain }
  }
  for (let t = low; t <= high + 1e-9; t += 0.02) tryAt(t)
  const coarse = found.best?.t
  if (coarse != null) for (let t = coarse - 0.02; t <= coarse + 0.02 + 1e-9; t += 0.0025) tryAt(t)
  return found.best
}

// From one camera a short flight fits almost as well either way, so a bounce also has to look like
// one: the ball keeps travelling the same way, loses some speed, and its fall turns into a smaller rise.
function bounceLike(chain: Chain, index: number, t: number) {
  const before = { x: chain.params[index * 6 + 3]!, y: chain.params[index * 6 + 4]!, z: chainClimb(chain, index, t) }
  const after = {
    x: chain.params[(index + 1) * 6 + 3]!,
    y: chain.params[(index + 1) * 6 + 4]!,
    z: chainClimb(chain, index + 1, t),
  }
  if (before.z > -0.5 || after.z < 0.3) return false
  const rebound = after.z / -before.z
  if (rebound < 0.15 || rebound > 1.1) return false
  const speedBefore = Math.hypot(before.x, before.y)
  const speedAfter = Math.hypot(after.x, after.y)
  if (speedBefore < 1) return true
  return before.x * after.x + before.y * after.y > 0 && speedAfter / speedBefore >= 0.3 && speedAfter / speedBefore <= 1.35
}

// A break is a bounce when pinning it to the ground costs little and the ball comes down then goes up.
function classifyBreak(
  camera: CourtCamera,
  groups: Observation[][],
  breaks: FlightBreak[],
  index: number,
  model: BounceModel,
): FlightBreak {
  const hit = bestBreak(camera, groups, breaks, index, false, model)
  const bounce = bestBreak(camera, groups, breaks, index, true, model)
  const count = groups.reduce((sum, group) => sum + group.length, 0)
  if (
    bounce &&
    (!hit || bounce.chain.cost <= hit.chain.cost * 1.25 + count * 0.5) &&
    bounceLike(bounce.chain, index, bounce.t)
  ) {
    return { t: bounce.t, bounce: true }
  }
  const middle = (groups[index]![groups[index]!.length - 1]!.t + groups[index + 1]![0]!.t) / 2
  return { t: hit?.t ?? middle, bounce: false }
}

function classifyBreaks(camera: CourtCamera, run: Observation[][], model: BounceModel) {
  const breaks: FlightBreak[] = []
  const decide = (index: number, last: number) => {
    const low = Math.max(0, index - 1)
    const window = run.slice(low, last + 1)
    const known = breaks.slice(low, last).map(
      (item, offset) => item ?? { t: (run[low + offset]!.at(-1)!.t + run[low + offset + 1]![0]!.t) / 2, bounce: false },
    )
    while (known.length < window.length - 1) {
      const offset = known.length
      known.push({ t: (run[low + offset]!.at(-1)!.t + run[low + offset + 1]![0]!.t) / 2, bounce: false })
    }
    return classifyBreak(camera, window, known, index - low, model)
  }
  const ahead = (index: number) => Math.min(run.length - 1, index + 2)
  for (let index = 0; index < run.length - 1; index += 1) breaks[index] = decide(index, ahead(index))
  refinePairs(camera, run, breaks, model)
  for (let index = 0; index < run.length - 1; index += 1) breaks[index] = decide(index, ahead(index))
  return breaks
}

// Neighbouring breaks pull on the same flight, so their times are searched together.
function refinePairs(camera: CourtCamera, run: Observation[][], breaks: FlightBreak[], model: BounceModel) {
  const reach = 0.04
  for (let index = 0; index + 1 < breaks.length; index += 1) {
    const low = Math.max(0, index - 1)
    const last = Math.min(run.length - 1, index + 3)
    const window = run.slice(low, last + 1)
    const local = breaks.slice(low, last)
    const a = index - low
    const b = a + 1
    const inside = (t: number, k: number) => t > window[k]![0]!.t && t < window[k + 1]!.at(-1)!.t
    let best = { cost: solveChain(camera, window, local, model)?.cost ?? Number.POSITIVE_INFINITY, ta: local[a]!.t, tb: local[b]!.t }
    for (const [span, step] of [
      [reach, 0.01],
      [0.01, 0.0025],
    ] as const) {
      const centerA = best.ta
      const centerB = best.tb
      for (let da = -span; da <= span + 1e-9; da += step) {
        for (let db = -span; db <= span + 1e-9; db += step) {
          const ta = centerA + da
          const tb = centerB + db
          if (!inside(ta, a) || !inside(tb, b) || tb <= ta) continue
          const trial = local.slice()
          trial[a] = { ...trial[a]!, t: ta }
          trial[b] = { ...trial[b]!, t: tb }
          const cost = solveChain(camera, window, trial, model)?.cost ?? Number.POSITIVE_INFINITY
          if (cost < best.cost) best = { cost, ta, tb }
        }
      }
    }
    breaks[index] = { ...breaks[index]!, t: best.ta }
    breaks[index + 1] = { ...breaks[index + 1]!, t: best.tb }
  }
}

export type FlightFit = {
  camera: CourtCamera
  flights: Flight[]
  skipped: number
}

function plausible(flight: Flight, limitPx: number) {
  const lowest = Math.min(positionAt(flight, flight.from).z, positionAt(flight, flight.to).z)
  const v = velocityAt(flight, flight.from)
  return (
    flight.rmsPx <= limitPx && lowest > -0.5 && peakHeight(flight) < 40 && Math.hypot(v.x, v.y, v.z) <= MAX_SPEED
  )
}

export function fitFlights(track: BallTrack, court: CourtCalibration): FlightFit | null {
  const camera = cameraFromCourt(court)
  if (!camera) return null
  const sx = court.sourceWidth / track.sourceWidth
  const sy = court.sourceHeight / track.sourceHeight
  const model = { radius: BALL_RADIUS[court.preset], restitution: RESTITUTION[court.preset] }
  const targetPx = Math.max(2, Math.hypot(court.sourceWidth, court.sourceHeight) * 0.004)
  const limitPx = Math.max(POOR_FIT_FLOOR_PX, targetPx * 2.5)
  const flights: Flight[] = []
  let skipped = 0

  const emit = (groups: Observation[][], breaks: FlightBreak[], chain: Chain) => {
    groups.forEach((group, k) => {
      const previous = breaks[k - 1]
      const next = breaks[k]
      const state = chainState(chain, k, chain.refs[k]!)
      const flight: Flight = {
        t0: chain.refs[k]!,
        from: previous?.t ?? group[0]!.t,
        to: next?.t ?? group[group.length - 1]!.t,
        p0: state,
        v0: { x: chain.params[k * 6 + 3]!, y: chain.params[k * 6 + 4]!, z: chain.params[k * 6 + 5]! },
        rmsPx: chain.rms[k]!,
        observed: group.length,
        startBounce: previous?.bounce ? previous.t : null,
        endBounce: next?.bounce ? next.t : null,
        reliable: false,
      }
      flight.reliable = plausible(flight, limitPx)
      flights.push(flight)
    })
  }

  for (const piece of splitOnGaps(track.points)) {
    if (piece.length < MIN_FLIGHT_POINTS) {
      skipped += 1
      continue
    }
    const observations = piece.map((point) => ({ t: point.t, u: point.x * sx, v: point.y * sy }))
    let run: Observation[][] = []
    const flush = () => {
      if (run.length === 0) return
      const breaks = classifyBreaks(camera, run, model)
      const chain = solveChain(camera, run, breaks, model)
      if (chain) emit(run, breaks, chain)
      else skipped += run.length
      run = []
    }
    for (const part of segment(camera, observations, targetPx, limitPx)) {
      const group = part.observations
      if (!part.flight) {
        flush()
        skipped += 1
        continue
      }
      const alone = solveChain(camera, [group], [], model)
      if (alone && alone.rms[0]! <= limitPx) {
        run.push(group)
        continue
      }
      flush()
      if (alone) emit([group], [], alone)
      else skipped += 1
    }
    flush()
  }
  return { camera, flights, skipped }
}

export function flightBounces(flights: Flight[]) {
  return flights.flatMap((flight) =>
    flight.endBounce == null ? [] : [{ t: flight.endBounce, p: positionAt(flight, flight.endBounce) }],
  )
}
