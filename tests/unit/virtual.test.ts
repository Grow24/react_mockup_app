import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { projectPoint } from '../../src/vision/flight.ts'
import { liftPerson, parseViewCommand, viewPose } from '../../src/vision/virtualCamera.ts'
import { behind, corner, L, W } from '../helpers/scene.ts'

describe('virtual camera', () => {
  it('reads where to watch from, in English or Hinglish, feet or meters', () => {
    const spot = parseViewCommand('Show the match from 10 feet behind the baseline, 15 feet above, on the right side', 'm')!
    assert.ok(Math.abs(spot.behind - 3.048) < 1e-3 && Math.abs(spot.height - 4.572) < 1e-3)
    assert.equal(spot.side, 'right')
    assert.deepEqual(parseViewCommand('baseline se 3 m peeche, 5 m upar, left side', 'ft'), { behind: 3, height: 5, side: 'left', end: 'near' })
    assert.equal(parseViewCommand('20 above, far end', 'ft')!.end, 'far')
    assert.equal(parseViewCommand('hello', 'm'), null)
    const pose = viewPose('tennis-doubles', spot)
    assert.deepEqual(pose.position, { x: W, y: -spot.behind, z: spot.height })
    assert.equal(viewPose('tennis-doubles', { ...spot, end: 'far' }).position.x, 0, 'right is from the far end looking back')
  })

  it('stands a player up at the right height from one camera', () => {
    for (const camera of [behind, corner]) {
      const joints = [0, 0.5, 1.1, 1.7].map((z) => projectPoint(camera, { x: 3, y: 18, z })!)
      const person = { box: { x: 0, y: 0, width: 1, height: 1 }, score: 1, keypoints: joints.flatMap((p) => [p.x, p.y, 0.9]) }
      const lifted = liftPerson(person, camera, { x: 3, y: 18 }, 1, 1)!
      lifted.forEach((joint, index) => {
        assert.ok(Math.abs(joint!.z - [0, 0.5, 1.1, 1.7][index]!) < 1e-6)
        assert.ok(Math.hypot(joint!.x - 3, joint!.y - 18) < 1e-6)
      })
    }
    assert.ok(L > 0)
  })
})
