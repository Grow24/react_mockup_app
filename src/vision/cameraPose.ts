import type { CourtCalibration, CourtPoint } from '../../shared/contracts.ts'
import { courtLines, courtWorldPoints } from '../../shared/court.ts'
import { courtHomography, projectPoint, solveLinear, type CourtCamera, type Vec3 } from './flight.ts'
import { length, type Units } from '../units.ts'

const DEG = 180 / Math.PI
// A phone's main 1x camera covers about 70 degrees across its long side.
const TYPICAL_FOCAL_SHARE = 0.75
const LEVEL_FIT_LIMIT_PX = 3

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })

export type CameraPose = {
  position: Vec3
  // Degrees the camera looks below the horizon.
  pitch: number
  // Degrees the view is turned from the court's length, to the right when positive.
  yaw: number
  // Degrees the image is tipped; 0 when the phone is held level.
  roll: number
}

export function describeCamera(camera: CourtCamera): CameraPose {
  const right = camera.rows[0]
  const forward = camera.rows[2]
  return {
    position: camera.position,
    pitch: Math.asin(Math.max(-1, Math.min(1, -forward.z))) * DEG,
    yaw: Math.atan2(forward.x, forward.y) * DEG,
    roll: Math.asin(Math.max(-1, Math.min(1, right.z))) * DEG,
  }
}

// Whole degrees, without a "-0".
const degrees = (value: number) => String(Math.round(value) || 0)

export function cameraText(camera: CourtCamera, units: Units) {
  const pose = describeCamera(camera)
  const { x, y, z } = pose.position
  const along = y < 0 ? `${length(-y, units)} behind the near baseline` : `${length(y, units)} in front of the near baseline`
  const turn = Math.abs(pose.yaw) < 1 ? 'facing straight down the court' : `turned ${degrees(Math.abs(pose.yaw))}° ${pose.yaw > 0 ? 'right' : 'left'}`
  return `Camera at x ${length(x, units)}, ${along}, ${length(z, units)} high · looking ${degrees(pose.pitch)}° down · ${turn} · roll ${degrees(pose.roll)}°`
}

function levelRotation(yaw: number, pitch: number) {
  const forward = { x: Math.sin(yaw) * Math.cos(pitch), y: Math.cos(yaw) * Math.cos(pitch), z: -Math.sin(pitch) }
  const right = { x: Math.cos(yaw), y: -Math.sin(yaw), z: 0 }
  return { right, down: cross(forward, right), forward }
}

// With the orientation and focal length fixed, each image point is two linear equations in the
// camera's position, so only yaw, pitch, and focal length are searched.
function levelTry(world: CourtPoint[], image: CourtPoint[], width: number, height: number, yaw: number, pitch: number, logFocal: number) {
  const cx = width / 2
  const cy = height / 2
  const focal = Math.max(width, height) * Math.exp(logFocal)
  const { right, down, forward } = levelRotation(yaw, pitch)
  const normal = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const rhs = [0, 0, 0]
  world.forEach((point, index) => {
    const w = { x: point.x, y: point.y, z: 0 }
    const du = image[index]!.x - cx
    const dv = image[index]!.y - cy
    for (const axis of [right, down]) {
      const shift = axis === right ? du : dv
      const a = [focal * axis.x - shift * forward.x, focal * axis.y - shift * forward.y, focal * axis.z - shift * forward.z]
      const b = a[0]! * w.x + a[1]! * w.y + a[2]! * w.z
      for (let i = 0; i < 3; i += 1) {
        rhs[i]! += a[i]! * b
        for (let j = 0; j < 3; j += 1) normal[i]![j]! += a[i]! * a[j]!
      }
    }
  })
  const solved = solveLinear(normal, rhs)
  if (!solved) return null
  const position = { x: solved[0]!, y: solved[1]!, z: solved[2]! }
  if (!(position.z > 0.2) || Math.hypot(position.x, position.y, position.z) > 300) return null
  const camera: CourtCamera = {
    focal,
    cx,
    cy,
    rows: [right, down, forward],
    translation: { x: -dot(right, position), y: -dot(down, position), z: -dot(forward, position) },
    position,
    focalEstimated: true,
  }
  const residuals: number[] = []
  for (let index = 0; index < world.length; index += 1) {
    const projected = projectPoint(camera, { x: world[index]!.x, y: world[index]!.y, z: 0 })
    if (!projected || projected.depth < 0.5) return null
    residuals.push(projected.x - image[index]!.x, projected.y - image[index]!.y)
  }
  const squared = residuals.reduce((sum, value) => sum + value * value, 0)
  // Several cameras can fit three points exactly; the one with a phone-like lens is the likely one.
  const lensPenalty = (logFocal - Math.log(TYPICAL_FOCAL_SHARE)) ** 2
  return { camera, residuals, rmsPx: Math.sqrt(squared / world.length), score: squared / world.length + lensPenalty }
}

// Levenberg-Marquardt on yaw, pitch, and log focal length; the exact fit lies along a narrow valley.
function refineLevel(
  world: CourtPoint[],
  image: CourtPoint[],
  width: number,
  height: number,
  start: [number, number, number],
) {
  let params = start
  let current = levelTry(world, image, width, height, ...params)
  if (!current) return null
  let damping = 1e-3
  for (let iteration = 0; iteration < 80 && current.rmsPx > 1e-6; iteration += 1) {
    const r = current.residuals
    const jacobian: number[][] = r.map(() => [0, 0, 0])
    let usable = true
    for (let dim = 0; dim < 3; dim += 1) {
      const step = 1e-6
      const moved = params.slice() as [number, number, number]
      moved[dim] += step
      const trial = levelTry(world, image, width, height, ...moved)
      if (!trial) {
        usable = false
        break
      }
      trial.residuals.forEach((value, row) => (jacobian[row]![dim] = (value - r[row]!) / step))
    }
    if (!usable) break
    const normal = [0, 1, 2].map((i) => [0, 1, 2].map((j) => jacobian.reduce((sum, row) => sum + row[i]! * row[j]!, 0)))
    const gradient = [0, 1, 2].map((i) => -jacobian.reduce((sum, row, k) => sum + row[i]! * r[k]!, 0))
    let accepted = false
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const damped = normal.map((row, i) => row.map((value, j) => (i === j ? value * (1 + damping) + 1e-12 : value)))
      const delta = solveLinear(damped, gradient)
      if (!delta) break
      const next: [number, number, number] = [params[0] + delta[0]!, params[1] + delta[1]!, params[2] + delta[2]!]
      const trial = levelTry(world, image, width, height, ...next)
      if (trial && trial.rmsPx < current.rmsPx) {
        params = next
        current = trial
        damping = Math.max(1e-9, damping / 3)
        accepted = true
        break
      }
      damping *= 4
    }
    if (!accepted) break
  }
  return { ...current, params }
}

// Three known ground points place a camera that is held level (no roll): six equations for
// position, yaw, pitch, and focal length. Some layouts fit two cameras exactly; both come back.
export function levelCamera(world: CourtPoint[], image: CourtPoint[], width: number, height: number) {
  if (world.length !== 3 || image.length !== 3) return null
  type Seed = { rmsPx: number; yaw: number; pitch: number; logFocal: number }
  const seeds: Seed[] = []
  for (let yaw = -Math.PI; yaw < Math.PI; yaw += Math.PI / 18) {
    for (let pitch = 0.03; pitch < 1.5; pitch += 0.07) {
      for (let logFocal = Math.log(0.3); logFocal <= Math.log(4); logFocal += 0.25) {
        const trial = levelTry(world, image, width, height, yaw, pitch, logFocal)
        if (trial) seeds.push({ rmsPx: trial.rmsPx, yaw, pitch, logFocal })
      }
    }
  }
  seeds.sort((a, b) => a.rmsPx - b.rmsPx)
  const fits: NonNullable<ReturnType<typeof refineLevel>>[] = []
  for (const seed of seeds.slice(0, 16)) {
    const refined = refineLevel(world, image, width, height, [seed.yaw, seed.pitch, seed.logFocal])
    if (!refined || refined.rmsPx > LEVEL_FIT_LIMIT_PX) continue
    const same = fits.find((fit) => distance(fit.camera.position, refined.camera.position) < 0.5)
    if (!same) fits.push(refined)
    else if (refined.score < same.score) fits[fits.indexOf(same)] = refined
  }
  fits.sort((a, b) => a.score - b.score)
  if (fits.length === 0) return null
  return { camera: fits[0]!.camera, rmsPx: fits[0]!.rmsPx, others: fits.slice(1).map((fit) => fit.camera) }
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

const NUDGES = [
  [1.5, 0, -1.5, 0, 0, 1.5],
  [-1.5, 0, 0, 1.5, 1.5, 0],
  [0, 1.5, 1.5, 0, -1.5, 0],
  [0, -1.5, 0, -1.5, 0, -1.5],
]

// How far the estimated point and the camera move when each click is off by a pixel and a half.
export function levelSpread(world: CourtPoint[], image: CourtPoint[], width: number, height: number, estimated: CourtPoint) {
  const base = levelCamera(world, image, width, height)
  if (!base) return null
  const at = projectPoint(base.camera, { x: estimated.x, y: estimated.y, z: 0 })
  let pixels = 0
  let meters = 0
  for (const nudge of NUDGES) {
    const moved = image.map((point, index) => ({ x: point.x + nudge[index * 2]!, y: point.y + nudge[index * 2 + 1]! }))
    const fit = levelCamera(world, moved, width, height)
    if (!fit) return { pixels: Number.POSITIVE_INFINITY, meters: Number.POSITIVE_INFINITY }
    const next = projectPoint(fit.camera, { x: estimated.x, y: estimated.y, z: 0 })
    if (at && next) pixels = Math.max(pixels, Math.hypot(next.x - at.x, next.y - at.y))
    meters = Math.max(meters, distance(fit.camera.position, base.camera.position))
  }
  return { pixels, meters }
}

function imageMapper(court: CourtCalibration) {
  const h = courtHomography(court)
  if (!h) return null
  const facing = (x: number, y: number) => h[6]! * x + h[7]! * y + h[8]!
  // Ground points in front of the camera share the sign of a marked point; the rest are past the horizon.
  const marked = courtWorldPoints(court)[0]!
  const side = Math.sign(facing(marked.x, marked.y)) || 1
  return (x: number, y: number) => {
    const w = facing(x, y)
    if (w * side <= 1e-6) return null
    return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w }
  }
}

// Every court line in the court photo's pixels, including parts outside the frame. Stretches
// beyond the horizon are dropped.
export function courtImageLines(court: CourtCalibration): CourtPoint[][] {
  const toImage = imageMapper(court)
  if (!toImage) return []
  const limit = 6 * Math.max(court.sourceWidth, court.sourceHeight)
  const polylines: CourtPoint[][] = []
  for (const line of courtLines(court.preset)) {
    let current: CourtPoint[] = []
    const pieces = 32
    for (let index = 0; index <= pieces; index += 1) {
      const k = index / pieces
      const point = toImage(line.from.x + (line.to.x - line.from.x) * k, line.from.y + (line.to.y - line.from.y) * k)
      if (!point || Math.abs(point.x) > limit || Math.abs(point.y) > limit) {
        if (current.length > 1) polylines.push(current)
        current = []
        continue
      }
      current.push(point)
    }
    if (current.length > 1) polylines.push(current)
  }
  return polylines
}

// Where (0, 0, 0) and one meter along each axis land in the court photo.
export function originAxes(court: CourtCalibration, camera: CourtCamera | null) {
  const toImage = imageMapper(court)
  if (!toImage) return null
  const origin = toImage(0, 0)
  const x = toImage(1, 0)
  const y = toImage(0, 1)
  const up = camera ? projectPoint(camera, { x: 0, y: 0, z: 1 }) : null
  if (!origin || !x || !y) return null
  return { origin, x, y, z: up ? { x: up.x, y: up.y } : null }
}
