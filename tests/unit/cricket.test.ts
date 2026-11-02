import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CourtCalibration, PersonPose, PoseTrack } from '../../shared/contracts.ts'
import { courtWorldPoints } from '../../shared/court.ts'
import { lengthName, mergeDeliveries, readDeliveries, shotDirection, type Delivery } from '../../src/vision/cricket.ts'
import { projectPoint, type FlightFit } from '../../src/vision/flight.ts'
import { flight } from '../helpers/players.ts'
import { lookAtCamera } from '../helpers/scene.ts'

const L = 20.12
const camera = lookAtCamera({ x: 1.7, y: -24, z: 8 }, { x: 1.525, y: 9, z: 0 }, 1500, 1280, 720)
const pitch: CourtCalibration = { preset: 'cricket-pitch', assetId: 'p', sourceWidth: 1280, sourceHeight: 720, imagePoints: [] }
pitch.imagePoints = courtWorldPoints(pitch).map((world) => {
  const point = projectPoint(camera, { ...world, z: 0 })!
  return { x: point.x, y: point.y }
})

// A bowler standing with their ankles at the given spots on the pitch.
function bowler(ankles: { x: number; y: number }[]): PersonPose {
  const keypoints = new Array<number>(51).fill(0)
  const [left, right] = ankles.map((spot) => projectPoint(camera, { ...spot, z: 0 })!)
  keypoints.splice(15 * 3, 3, left!.x, left!.y, 0.9)
  keypoints.splice(16 * 3, 3, right!.x, right!.y, 0.9)
  const head = projectPoint(camera, { x: ankles[0]!.x, y: ankles[0]!.y, z: 1.9 })!
  return { box: { x: left!.x - 20, y: head.y, width: 40, height: left!.y - head.y }, score: 0.9, keypoints }
}

describe('cricket deliveries', () => {
  it('reads pace, length, line, the stumps, and the shot', () => {
    const fit: FlightFit = {
      camera,
      skipped: 0,
      flights: [
        // From the near end: released 2.1 m up, pitches 7 m from the far stumps a little right of middle,
        // and is driven back to the bowler's left.
        flight(0, 0.45, { x: 1.4, y: 0.6, z: 2.1 }, { x: 1.62, y: L - 7, z: 0.036 }, false, true),
        flight(0.45, 0.62, { x: 1.62, y: L - 7, z: 0.036 }, { x: 1.6, y: L - 1.5, z: 0.5 }, true, false),
        flight(0.62, 1.6, { x: 1.6, y: L - 1.5, z: 0.5 }, { x: -6, y: 4, z: 0.036 }, false, true),
        // From the far end: a full toss wide outside off that is left alone.
        flight(30, 30.5, { x: 1.7, y: L - 0.5, z: 2.0 }, { x: 0.4, y: -1, z: 1.0 }, false, false),
        // A throw back to the bowler is not a delivery.
        flight(40, 41, { x: 3, y: 15, z: 1 }, { x: 1.5, y: 1, z: 1 }, false, false),
      ],
    }
    const deliveries = readDeliveries(fit, pitch)
    assert.equal(deliveries.length, 2)
    const [first, second] = deliveries
    assert.equal(first!.from, 'near')
    assert.ok(first!.release.speed * 3.6 > 100 && first!.release.speed * 3.6 < 160, `${first!.release.speed * 3.6} km/h`)
    assert.ok(Math.abs(first!.pitch!.fromStumps - 7) < 0.01)
    assert.equal(first!.pitch!.length, 'good length')
    assert.ok(Math.abs(first!.pitch!.line - 0.095) < 0.01, 'right of middle as the bowler sees it')
    assert.equal(first!.atStumps!.hitting, true, 'it was going on to hit the stumps')
    assert.ok(first!.shot && first!.shot.angle < -10, 'driven to the bowler\'s left')
    assert.match(shotDirection(first!.shot!.angle), /to the bowler's left/)
    assert.equal(second!.from, 'far')
    assert.equal(second!.pitch, null, 'a full toss')
    assert.equal(second!.atStumps!.hitting, false)
    assert.ok(second!.atStumps!.across > 0.5, 'outside the stumps on the far bowler\'s right')
    assert.equal(second!.shot, null)
  })

  it('keeps one copy of each live delivery as the windows slide past it', () => {
    const delivery = (t: number, speed: number): Delivery => ({ t, from: 'near', release: { p: { x: 1.5, y: 0.5, z: 2 }, speed }, pitch: null, atStumps: null, shot: null, frontFoot: null })
    let list: Delivery[] = []
    // The ball leaves the hand at 100.0 s; windows of 4 s every half second read it slightly differently.
    for (let from = 96; from <= 101; from += 0.5) {
      const seen = from <= 100 && from + 4 >= 100 ? [delivery(100 + (from - 98) * 0.01, 35 + from - 98)] : []
      list = mergeDeliveries(list, seen, { from, duration: 4 })
    }
    assert.equal(list.length, 1)
    assert.equal(list[0]!.release.speed, 35 + 99.5 - 98, 'the last window that saw it whole wins')
  })

  it('names the lengths', () => {
    assert.deepEqual([1, 4, 7, 9, 12].map(lengthName), ['yorker', 'full', 'good length', 'back of a length', 'short'])
  })

  it('measures the front foot against the popping crease at release', () => {
    const fit: FlightFit = { camera, skipped: 0, flights: [flight(0, 0.45, { x: 1.4, y: 0.9, z: 2.1 }, { x: 1.6, y: L - 6, z: 0.036 }, false, true)] }
    const track = (frontY: number): PoseTrack => ({
      assetId: 'v', modelId: 'm', sourceWidth: 1280, sourceHeight: 720, sampleFps: 10, duration: 1, createdAt: 0,
      frames: [{ t: 0, people: [bowler([{ x: 1.3, y: frontY - 0.9 }, { x: 1.5, y: frontY }])] }],
    })
    const behindLine = readDeliveries(fit, pitch, track(1.0))[0]!
    assert.ok(Math.abs(behindLine.frontFoot! - 0.32) < 0.02, `${behindLine.frontFoot}`)
    const over = readDeliveries(fit, pitch, track(1.6))[0]!
    assert.ok(over.frontFoot! < 0, 'the front foot landed over the line')
  })
})
