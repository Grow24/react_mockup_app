import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CourtCalibration, PersonPose, PoseTrack } from '../../shared/contracts.ts'
import { courtWorldPoints } from '../../shared/court.ts'
import { projectPoint } from '../../src/vision/flight.ts'
import { assignPlayers, feetOnCourt, jointAngles, personName, playerPaths } from '../../src/vision/players.ts'
import { decodeYoloPose } from '../../src/vision/yolo.ts'
import { behind, courtFor, L, W } from '../helpers/scene.ts'

const court = courtFor(behind, 640, 360)

// A standing person whose ankles touch the court at (x, y), drawn from the camera.
function personAt(x: number, y: number, kneeBend = 0): PersonPose {
  const ground = projectPoint(behind, { x, y, z: 0 })!
  const head = projectPoint(behind, { x, y, z: 1.8 })!
  const tall = ground.y - head.y
  const keypoints: number[] = []
  for (let index = 0; index < 17; index += 1) {
    const level = index <= 4 ? 0 : index <= 6 ? 0.18 : index <= 8 ? 0.33 : index <= 10 ? 0.45 : index <= 12 ? 0.5 : index <= 14 ? 0.75 : 1
    const side = index === 0 ? 0 : index % 2 === 1 ? -0.08 : 0.08
    const bend = index === 13 || index === 14 ? kneeBend : 0
    keypoints.push(ground.x + side * tall + bend * tall, head.y + level * tall, 0.9)
  }
  return { box: { x: ground.x - 0.2 * tall, y: head.y, width: 0.4 * tall, height: tall }, score: 0.9, keypoints }
}

describe('players', () => {
  it('names the near and far players and leaves out people off the court', () => {
    const near = personAt(4, -1)
    const far = personAt(6, L + 1)
    const umpire = personAt(-9, L / 2)
    const named = assignPlayers([umpire, far, near], court, 640, 360)
    assert.deepEqual(named.map((person) => person.player).sort(), ['far', 'near'])
    const spot = feetOnCourt(named.find((person) => person.player === 'near')!, court, 640, 360)!
    assert.ok(Math.hypot(spot.x - 4, spot.y + 1) < 0.05, 'feet in court meters')
    const doubles = assignPlayers([near, personAt(8, 3), far], court, 640, 360)
    assert.deepEqual(doubles.map((person) => person.player).sort(), ['far', 'near', 'near-2'])
  })

  it('places each person on the court they stand on when the camera sees two courts', () => {
    // A second court beside the first, 4 m past its right doubles line.
    const gap = W + 4
    const second: CourtCalibration = {
      ...court,
      slot: 1,
      imagePoints: courtWorldPoints(court).map((world) => {
        const point = projectPoint(behind, { x: world.x + gap, y: world.y, z: 0 })!
        return { x: point.x, y: point.y }
      }),
    }
    const near = personAt(4, 2)
    const far = personAt(gap + 6, L - 2)
    const between = personAt(W + 1, 5)
    const named = assignPlayers([far, between, near], [court, second], 640, 360)
    const where = named.map((person) => `${person.court}:${person.player}`)
    assert.deepEqual(where.sort(), ['0:near', '0:near-2', '1:far'])
    const onSecond = named.find((person) => person.court === 1)!
    const spot = feetOnCourt(onSecond, second, 640, 360)!
    assert.ok(Math.hypot(spot.x - 6, spot.y - (L - 2)) < 0.05, 'feet in the second court\'s own meters')
    assert.equal(personName({ ...onSecond, id: 'C' }), 'Player C (Court 2, far)')
    assert.equal(personName({ id: 'A', player: 'near' }), 'Player A (near)', 'one court keeps the short name')
    const lettered = named.map((person) => ({ ...person, id: person.court === 1 ? 'C' : person.player === 'near' ? 'A' : 'B' }))
    const track: PoseTrack = { assetId: 'v', modelId: 'm', sourceWidth: 640, sourceHeight: 360, sampleFps: 1, duration: 1, createdAt: 0, frames: [{ t: 0, people: lettered }] }
    assert.deepEqual([...playerPaths(track, second).paths.keys()], ['C'], 'the second court counts only its own players')
    assert.deepEqual([...playerPaths(track, court).paths.keys()].sort(), ['A', 'B'])
  })

  it('reads knee angles and how far a player moved', () => {
    assert.ok(Math.abs(jointAngles(personAt(4, 0)).leftKnee! - 180) < 1, 'a straight leg')
    assert.ok(jointAngles(personAt(4, 0, 0.12)).leftKnee! < 160, 'a bent knee')
    const frames = [0, 1, 2].map((t) => ({ t, people: assignPlayers([personAt(2 + t, -1)], court, 640, 360) }))
    const track: PoseTrack = { assetId: 'a', modelId: 'm', sourceWidth: 640, sourceHeight: 360, sampleFps: 1, duration: 2, createdAt: 0, frames }
    const moved = playerPaths(track, court).summary.get('near')!
    assert.equal(moved.seen, 3)
    assert.ok(Math.abs(moved.meters - 2) < 0.05)
  })

  it('decodes a YOLOv8-pose tensor back into source pixels', () => {
    const anchors = 4
    const data = new Float32Array(56 * anchors)
    const set = (channel: number, anchor: number, value: number) => (data[channel * anchors + anchor] = value)
    // A 640x360 frame letterboxes into 640x640 with 140 px of padding above.
    set(0, 1, 320)
    set(1, 1, 140 + 180)
    set(2, 1, 100)
    set(3, 1, 200)
    set(4, 1, 0.9)
    for (let k = 0; k < 17; k += 1) {
      set(5 + k * 3, 1, 300 + k)
      set(6 + k * 3, 1, 140 + 100 + k)
      set(7 + k * 3, 1, 0.8)
    }
    const people = decodeYoloPose(data, [1, 56, anchors], 640, 360, 640)
    assert.equal(people.length, 1)
    assert.deepEqual(people[0]!.box, { x: 270, y: 80, width: 100, height: 200 })
    assert.deepEqual(people[0]!.keypoints.slice(0, 3), [300, 100, 0.8])
  })
})
