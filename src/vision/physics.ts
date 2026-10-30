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
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(start.p.x, start.p.y, Math.max(radius, start.p.z))
        .setLinvel(start.v.x, start.v.y, start.v.z)
        .setCcdEnabled(true),
    )
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
