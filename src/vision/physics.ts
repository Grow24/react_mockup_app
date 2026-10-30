import { COURT_PRESETS, type CourtPreset } from '../../shared/contracts.ts'
import { BALL_RADIUS, GRAVITY, RESTITUTION, type Vec3 } from './flight.ts'

type Rapier = typeof import('@dimforge/rapier3d-compat')

export type PredictedBounce = { t: number; p: Vec3 }

export type Prediction = {
  path: { t: number; p: Vec3 }[]
  bounces: PredictedBounce[]
  obstacle: { t: number; p: Vec3; name: 'net' | 'stumps' } | null
}

const STEP_SECONDS = 1 / 240
const SAMPLE_EVERY = 4
const AIR_DENSITY = 1.2
const BALL_MASS: Record<CourtPreset, number> = { 'tennis-doubles': 0.057, 'cricket-pitch': 0.16 }
const DRAG_COEFFICIENT: Record<CourtPreset, number> = { 'tennis-doubles': 0.55, 'cricket-pitch': 0.5 }
// About 2500 rpm for a topspin drive and 1500 rpm for a slice.
const SPIN_RATE = { topspin: 262, slice: 157 }

export type Spin = 'none' | 'topspin' | 'slice'
export type Air = { drag: boolean; spin: Spin }
export const NO_AIR: Air = { drag: false, spin: 'none' }
export const STILL_AIR: Air = { drag: true, spin: 'none' }

export function airText(air: Air) {
  if (!air.drag && air.spin === 'none') return 'No air drag or spin is modeled.'
  const parts = [air.drag ? 'air drag' : '', air.spin === 'none' ? '' : `${air.spin} (Magnus lift and the kick off the bounce)`]
  return `The prediction includes ${parts.filter(Boolean).join(' and ')}.`
}

let loading: Promise<Rapier> | null = null

export function loadRapier() {
  if (!loading) {
    loading = import('@dimforge/rapier3d-compat')
      .then(async (module) => {
        const rapier = (module as Rapier & { default?: Rapier }).default ?? module
        await rapier.init()
        return rapier
      })
      .catch((error: unknown) => {
        loading = null
        throw error
      })
  }
  return loading
}

export async function predictFlight(
  preset: CourtPreset,
  start: { t: number; p: Vec3; v: Vec3 },
  seconds = 2,
  air: Air = STILL_AIR,
): Promise<Prediction> {
  const RAPIER = await loadRapier()
  const { widthMeters: width, lengthMeters: length } = COURT_PRESETS[preset]
  const restitution = RESTITUTION[preset]
  const radius = BALL_RADIUS[preset]
  const world = new RAPIER.World({ x: 0, y: 0, z: -GRAVITY })
  world.timestep = STEP_SECONDS
  const queue = new RAPIER.EventQueue(true)
  try {
    const ground = world.createCollider(
      RAPIER.ColliderDesc.cuboid(width + 20, length + 20, 0.5)
        .setTranslation(width / 2, length / 2, -0.5)
        .setRestitution(restitution)
        .setFriction(0.4),
    )
    const obstacles = new Map<number, 'net' | 'stumps'>()
    if (preset === 'tennis-doubles') {
      const net = world.createCollider(
        RAPIER.ColliderDesc.cuboid(width / 2 + 0.914, 0.01, 0.457)
          .setTranslation(width / 2, length / 2, 0.457)
          .setRestitution(0.1),
      )
      obstacles.set(net.handle, 'net')
    } else {
      for (const y of [0, length]) {
        const stumps = world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.114, 0.02, 0.356).setTranslation(width / 2, y, 0.356).setRestitution(0.3),
        )
        obstacles.set(stumps.handle, 'stumps')
      }
    }
    const across = Math.hypot(start.v.x, start.v.y)
    // Topspin turns the ball over in the direction it travels, like rolling; slice turns it back.
    const spinRate = air.spin === 'none' || across < 0.1 ? 0 : air.spin === 'topspin' ? SPIN_RATE.topspin : -SPIN_RATE.slice
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(start.p.x, start.p.y, Math.max(radius, start.p.z))
        .setLinvel(start.v.x, start.v.y, start.v.z)
        .setAngvel({ x: (-start.v.y / (across || 1)) * spinRate, y: (start.v.x / (across || 1)) * spinRate, z: 0 })
        .setCcdEnabled(true),
    )
    const area = Math.PI * radius * radius
    const dragPerSpeed2 = air.drag ? (0.5 * AIR_DENSITY * DRAG_COEFFICIENT[preset] * area) / BALL_MASS[preset] : 0
    const liftPerSpeed2 = (0.5 * AIR_DENSITY * area) / BALL_MASS[preset]
    const pushAir = () => {
      const v = body.linvel()
      const speed = Math.hypot(v.x, v.y, v.z)
      if (speed < 0.1) return
      let ax = -dragPerSpeed2 * speed * v.x
      let ay = -dragPerSpeed2 * speed * v.y
      let az = -dragPerSpeed2 * speed * v.z
      const w = body.angvel()
      const rate = Math.hypot(w.x, w.y, w.z)
      if (spinRate !== 0 && rate > 1) {
        const ratio = (radius * rate) / speed
        const lift = (liftPerSpeed2 * speed * speed * ratio) / (2.022 * ratio + 0.981)
        const cx = w.y * v.z - w.z * v.y
        const cy = w.z * v.x - w.x * v.z
        const cz = w.x * v.y - w.y * v.x
        const size = Math.hypot(cx, cy, cz)
        if (size > 1e-9) {
          ax += (lift * cx) / size
          ay += (lift * cy) / size
          az += (lift * cz) / size
        }
      }
      const kick = body.mass() * STEP_SECONDS
      body.applyImpulse({ x: ax * kick, y: ay * kick, z: az * kick }, true)
    }
    const ball = world.createCollider(
      RAPIER.ColliderDesc.ball(radius)
        .setRestitution(restitution)
        .setFriction(0.4)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    )

    const prediction: Prediction = { path: [{ t: start.t, p: start.p }], bounces: [], obstacle: null }
    const steps = Math.round(seconds / STEP_SECONDS)
    for (let index = 1; index <= steps; index += 1) {
      if (dragPerSpeed2 > 0 || spinRate !== 0) pushAir()
      world.step(queue)
      const t = start.t + index * STEP_SECONDS
      const at = body.translation()
      const p = { x: at.x, y: at.y, z: at.z }
      queue.drainCollisionEvents((first, second, started) => {
        if (!started) return
        const other = first === ball.handle ? second : first
        if (other === ground.handle) prediction.bounces.push({ t, p })
        const name = obstacles.get(other)
        if (name && !prediction.obstacle) prediction.obstacle = { t, p, name }
      })
      if (index % SAMPLE_EVERY === 0) prediction.path.push({ t, p })
      if (prediction.bounces.length >= 3) break
    }
    return prediction
  } finally {
    queue.free()
    world.free()
  }
}
