import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PersonPose, PoseTrack } from '../../shared/contracts.ts'
import { GRAVITY, projectPoint, type Flight, type FlightFit, type Vec3 } from '../../src/vision/flight.ts'
import { readMatch } from '../../src/vision/match.ts'
import { behind, courtFor, L, R } from '../helpers/scene.ts'

const court = courtFor(behind, 640, 360)

function flight(from: number, to: number, a: Vec3, b: Vec3, startBounce: boolean, endBounce: boolean): Flight {
  const T = to - from
  const v0 = { x: (b.x - a.x) / T, y: (b.y - a.y) / T, z: (b.z - a.z) / T + (GRAVITY * T) / 2 }
  return {
    t0: from, from, to, p0: a, v0, rmsPx: 1, heightSigma: 0.05, observed: 10,
    startBounce: startBounce ? from : null, endBounce: endBounce ? to : null, reliable: true,
  }
}

type Arms = 'rest' | 'overhead' | 'forehand-far' | 'backhand-near'

// A right-handed player standing at (x, y), drawn through the camera, with the arms placed for a stroke.
function person(id: string, x: number, y: number, arms: Arms): PersonPose {
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

describe('match reading', () => {
  it('names the shots, who hit them, and the rest between points', () => {
    const fit: FlightFit = {
      camera: behind,
      skipped: 0,
      flights: [
        flight(0, 1, { x: 6, y: -0.5, z: 2.6 }, { x: 3.5, y: 16, z: R }, false, true),
        flight(1, 1.5, { x: 3.5, y: 16, z: R }, { x: 3, y: 22, z: 1 }, true, false),
        flight(1.5, 2.5, { x: 3, y: 22, z: 1 }, { x: 4.5, y: 9, z: 1 }, false, false),
        flight(2.5, 3.4, { x: 4.5, y: 9, z: 1 }, { x: 6, y: 20, z: R }, false, true),
        flight(3.4, 3.9, { x: 6, y: 20, z: R }, { x: 7, y: 25, z: 0.6 }, true, false),
        flight(40, 41, { x: 6, y: -0.5, z: 2.6 }, { x: 7, y: 16, z: R }, false, true),
      ],
    }
    const frames: PoseTrack['frames'] = []
    for (let i = 0; i <= 415; i += 1) {
      const t = i / 10
      const near = (Math.abs(t) < 0.15 || Math.abs(t - 40) < 0.15)
        ? person('A', 6, -0.5, 'overhead')
        : t > 2 && t < 3.5
          ? person('A', 4.5, 9, Math.abs(t - 2.5) < 0.15 ? 'backhand-near' : 'rest')
          : person('A', 6, -0.5, 'rest')
      const far = person('B', 3, 22, Math.abs(t - 1.5) < 0.15 ? 'forehand-far' : 'rest')
      frames.push({ t, people: [near, far] })
    }
    const track: PoseTrack = { assetId: 'v', modelId: 'm', sourceWidth: 640, sourceHeight: 360, sampleFps: 10, duration: 41.5, createdAt: 0, frames }
    const match = readMatch(fit, track, court, 41.5)
    assert.deepEqual(
      match.shots.map((shot) => `${shot.player} ${shot.kind}`),
      ['A serve', 'B forehand drive', 'A backhand volley', 'A serve'],
    )
    assert.deepEqual(match.segments.map((segment) => segment.kind), ['rally', 'gap', 'rally'])
    const gap = match.segments[1]!
    assert.ok(gap.kind === 'gap' && gap.resting, 'the players stood still between points')
    assert.equal(match.hands.A, 'right')
  })
})
