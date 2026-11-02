import type { PersonPose } from '../../shared/contracts.ts'
import { GRAVITY, projectPoint, type Flight, type Vec3 } from '../../src/vision/flight.ts'
import { behind, L } from './scene.ts'

export function flight(from: number, to: number, a: Vec3, b: Vec3, startBounce: boolean, endBounce: boolean): Flight {
  const T = to - from
  const v0 = { x: (b.x - a.x) / T, y: (b.y - a.y) / T, z: (b.z - a.z) / T + (GRAVITY * T) / 2 }
  return {
    t0: from, from, to, p0: a, v0, rmsPx: 1, heightSigma: 0.05, observed: 10,
    startBounce: startBounce ? from : null, endBounce: endBounce ? to : null, reliable: true,
  }
}

export type Arms = 'rest' | 'overhead' | 'forehand-far' | 'backhand-near'

// A right-handed player standing at (x, y), drawn through the camera, with the arms placed for a stroke.
export function person(id: string, x: number, y: number, arms: Arms): PersonPose {
  const right = y < L / 2 ? 1 : -1
  const wrist: Vec3 =
    arms === 'overhead'
      ? { x: x + 0.2 * right, y, z: 2.3 }
      : arms === 'forehand-far' || arms === 'backhand-near'
        ? { x: x - 0.6, y, z: 1.0 }
        : { x: x + 0.25 * right, y, z: 0.9 }
  const joints: Vec3[] = [
    { x, y, z: 1.65 }, { x: x - 0.03, y, z: 1.68 }, { x: x + 0.03, y, z: 1.68 }, { x: x - 0.07, y, z: 1.66 }, { x: x + 0.07, y, z: 1.66 },
    { x: x - 0.2 * right, y, z: 1.45 }, { x: x + 0.2 * right, y, z: 1.45 },
    { x: x - 0.25 * right, y, z: 1.15 }, { x: (x + 0.2 * right + wrist.x) / 2, y, z: (1.45 + wrist.z) / 2 },
    { x: x - 0.25 * right, y, z: 0.9 }, wrist,
    { x: x - 0.15 * right, y, z: 0.95 }, { x: x + 0.15 * right, y, z: 0.95 },
    { x: x - 0.15 * right, y, z: 0.5 }, { x: x + 0.15 * right, y, z: 0.5 },
    { x: x - 0.15 * right, y, z: 0.05 }, { x: x + 0.15 * right, y, z: 0.05 },
  ]
  const keypoints = joints.flatMap((joint) => {
    const p = projectPoint(behind, joint)!
    return [p.x, p.y, 0.9]
  })
  const head = projectPoint(behind, { x, y, z: 1.8 })!
  const feet = projectPoint(behind, { x, y, z: 0 })!
  const tall = feet.y - head.y
  const hand = projectPoint(behind, wrist)!
  return {
    box: { x: feet.x - tall * 0.3, y: head.y, width: tall * 0.6, height: tall },
    score: 0.9,
    keypoints,
    id,
    player: y < L / 2 ? 'near' : 'far',
    racket: { x: hand.x - 3, y: hand.y - 6, width: 6, height: 8, score: 0.8, hand: 'right' },
  }
}
