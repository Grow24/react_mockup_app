import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PoseTrack } from '../../shared/contracts.ts'
import type { FlightFit } from '../../src/vision/flight.ts'
import { readMatch } from '../../src/vision/match.ts'
import { flight, person } from '../helpers/players.ts'
import { behind, courtFor, R } from '../helpers/scene.ts'

const court = courtFor(behind, 640, 360)

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
