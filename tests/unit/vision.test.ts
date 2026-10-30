import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { candidatesFrom, courtFitsTrack, linkBallTrack, type BallFrame } from '../../src/vision/ball.ts'
import {
  cameraFromCourt,
  fitFlights,
  flightBounces,
  groundFromImage,
  lineCall,
  peakHeight,
  projectPoint,
  type Vec3,
} from '../../src/vision/flight.ts'
import { NO_AIR, predictFlight } from '../../src/vision/physics.ts'
import { completingLandmark, LANDMARK_SETS, landmarksProblem } from '../../shared/court.ts'
import { courtImageLines, describeCamera, levelCamera } from '../../src/vision/cameraPose.ts'
import { length, xyz } from '../../src/units.ts'
import { ballisticEnd, triangulateTake, type TakeView } from '../../src/vision/triangulate.ts'
import { behind, corner, courtFor, L, lookAtCamera, noise, R, trackOf, truth, W } from '../helpers/scene.ts'

const court = courtFor(behind, 640, 360)

function framesFor(motion: (t: number) => Vec3, end: number, shift = 0, hold = 0, jitter = 0) {
  const wobble = noise(11)
  const frames: BallFrame[] = []
  for (let i = 0; i * 0.1 <= end + 1e-9; i += 1) {
    const t = i / 10
    const image = projectPoint(behind, motion(Math.max(0, t - hold + shift)))!
    frames.push({ t, candidates: [{ x: image.x + wobble(jitter), y: image.y + wobble(jitter), radius: 16, score: 0.8 }] })
  }
  return frames
}

describe('ball tracking', () => {
  it('follows the ball past a stronger decoy and finds the bounce', () => {
    const frames: BallFrame[] = []
    for (let i = 0; i <= 20; i += 1) {
      const t = i / 10
      const y = 300 - Math.abs(t - 1) * 200
      const ball = { label: 'sports ball', score: 0.6, box: { x: 50 + t * 200 - 8, y: y - 8, width: 16, height: 16 } }
      const decoy = { label: 'sports ball', score: 0.9, box: { x: 600, y: 20, width: 16, height: 16 } }
      frames.push({ t, candidates: i === 0 ? candidatesFrom([ball]) : i === 5 ? [] : candidatesFrom([ball, decoy]) })
    }
    const points = linkBallTrack(frames, 640, 360)
    assert.equal(points.length, 20)
    assert.equal(points.filter((point) => point.x > 500).length, 0)
    assert.deepEqual(points.filter((point) => point.bounce).map((point) => point.t), [1])
  })
})

describe('single-camera 3D flight', () => {
  it('recovers the camera from four court corners', () => {
    const camera = cameraFromCourt(court)!
    assert.ok(Math.abs(camera.focal - 475) < 1)
    assert.ok(Math.hypot(camera.position.x - behind.position.x, camera.position.y - behind.position.y, camera.position.z - behind.position.z) < 0.05)
  })

  it('places the camera from any four court points that span the ground', () => {
    for (const set of LANDMARK_SETS['tennis-doubles']) {
      const marked = courtFor(behind, 640, 360, set.landmarks)
      const camera = cameraFromCourt(marked)!
      const off = Math.hypot(camera.position.x - behind.position.x, camera.position.y - behind.position.y, camera.position.z - behind.position.z)
      assert.ok(off < 0.05, `${set.label}: camera ${off.toFixed(3)} m off`)
      const far = groundFromImage(marked)!(projectPoint(behind, { x: 9.6, y: 23.77, z: 0 })!)!
      assert.ok(Math.hypot(far.x - 9.6, far.y - 23.77) < 1e-6, `${set.label}: far corner`)
    }
    assert.match(landmarksProblem('tennis-doubles', ['doubles-near-left', 'center-mark-near', 'doubles-near-right', 'tee-far'])!, /one line/)
    assert.match(landmarksProblem('tennis-doubles', ['tee-near', 'tee-near', 'tee-far', 'doubles-far-left'])!, /different/)
    assert.equal(landmarksProblem('cricket-pitch', LANDMARK_SETS['cricket-pitch'][2]!.landmarks), null)
  })

  const cases: [string, (t: number) => Vec3, number, number, number][] = [
    ['a bounce on a frame', truth, 0, 0, 1.6],
    ['a bounce between frames', truth, 0.05, 0, 1.6],
    ['a ball held before the shot', truth, 0.03, 0.6, 2.2],
  ]
  for (const [name, motion, shift, hold, end] of cases) {
    it(`fits ${name}`, () => {
      const points = linkBallTrack(framesFor(motion, end, shift, hold), 640, 360)
      const fit = fitFlights(trackOf(points, end), court)!
      const flights = fit.flights.filter((flight) => flight.reliable)
      const bounce = flightBounces(flights)[0]
      assert.ok(bounce, 'a bounce is found')
      assert.ok(Math.abs(bounce.t - (1 + hold - shift)) < 0.02, `bounce time ${bounce.t}`)
      assert.ok(Math.hypot(bounce.p.x - 3.5, bounce.p.y - 15) < 0.1, `bounce at ${bounce.p.x}, ${bounce.p.y}`)
      assert.ok(Math.abs(peakHeight(flights.find((flight) => flight.endBounce != null)!) - 1.79) < 0.05)
    })
  }

  it('splits a racket hit after the bounce', () => {
    const rally = (t: number) => {
      if (t <= 1.4) return truth(t)
      const at = truth(1.4)
      const s = t - 1.4
      return { x: at.x - 0.5 * s, y: at.y - 16 * s, z: at.z + 2.5 * s - 4.905 * s * s }
    }
    const points = linkBallTrack(framesFor(rally, 1.9, 0.04), 640, 360)
    const flights = fitFlights(trackOf(points, 1.9), court)!.flights.filter((flight) => flight.reliable)
    assert.equal(flights.length, 3)
    assert.equal(flightBounces(flights).length, 1, 'the hit is not a bounce')
  })

  it('stays close with pixel noise', () => {
    const points = linkBallTrack(framesFor(truth, 1.6, 0.05, 0, 1.5), 640, 360)
    const bounce = flightBounces(fitFlights(trackOf(points, 1.6), court)!.flights.filter((flight) => flight.reliable))[0]
    assert.ok(bounce && Math.hypot(bounce.p.x - 3.5, bounce.p.y - 15) < 0.6)
  })

  it('keeps the bounce of a far, short flight that one camera cannot place on its own', () => {
    const far = lookAtCamera({ x: W / 2, y: -6, z: 4 }, { x: W / 2, y: L / 2, z: 0 }, 1000, 1280, 720)
    const farCourt = courtFor(far, 1280, 720)
    let found = 0
    for (let seed = 1; seed <= 8; seed += 1) {
      const wobble = noise(seed * 7919)
      const vx = wobble(2)
      const vy = 14 + wobble(4)
      const z0 = 0.8 + Math.abs(wobble(0.5))
      const tb = 0.4 + Math.abs(wobble(0.1))
      const vz = (R - z0 + 4.905 * tb * tb) / tb
      const at = (t: number): Vec3 => {
        if (t <= tb) return { x: 4 + vx * t, y: 12 + vy * t, z: z0 + vz * t - 4.905 * t * t }
        const s = t - tb
        const up = 0.75 * (9.81 * tb - vz)
        return { x: 4 + vx * tb + 0.8 * vx * s, y: 12 + vy * tb + 0.8 * vy * s, z: R + up * s - 4.905 * s * s }
      }
      const points = []
      for (let i = 0; i / 30 <= tb + 0.45; i += 1) {
        const image = projectPoint(far, at(i / 30))!
        points.push({ t: i / 30, x: image.x + wobble(3), y: image.y + wobble(3), radius: 4, score: 0.8 })
      }
      const fit = fitFlights({ ...trackOf(points, tb + 0.45), sourceWidth: 1280, sourceHeight: 720 }, farCourt)!
      const bounce = flightBounces(fit.flights.filter((flight) => flight.reliable)).find((item) => Math.abs(item.t - tb) < 0.06)
      if (bounce && Math.hypot(bounce.p.x - at(tb).x, bounce.p.y - at(tb).y) < 0.5) found += 1
    }
    assert.ok(found >= 7, `${found} of 8 far bounces found`)
  })

  it('places a level camera from three corners and finds the fourth, even outside the frame', () => {
    const high = lookAtCamera({ x: W + 3, y: -3.05, z: 4.57 }, { x: W / 2, y: L / 2, z: 0 }, 900, 1280, 720)
    const corners = [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: L },
      { x: 0, y: L },
    ]
    for (const [camera, width, height] of [
      [behind, 640, 360],
      [high, 1280, 720],
    ] as const) {
      for (let missing = 0; missing < 4; missing += 1) {
        const world = corners.filter((_, index) => index !== missing)
        const image = world.map((point) => projectPoint(camera, { ...point, z: 0 })!)
        const fit = levelCamera(world, image, width, height)!
        const off = Math.hypot(fit.camera.position.x - camera.position.x, fit.camera.position.y - camera.position.y, fit.camera.position.z - camera.position.z)
        assert.ok(off < 0.05, `camera ${off.toFixed(2)} m off without corner ${missing}`)
        const truth4 = projectPoint(camera, { ...corners[missing]!, z: 0 })!
        const found = projectPoint(fit.camera, { ...corners[missing]!, z: 0 })!
        assert.ok(Math.hypot(truth4.x - found.x, truth4.y - found.y) < 1, 'the estimated corner')
      }
    }
    const pose = describeCamera(high)
    assert.ok(Math.abs(pose.roll) < 1e-6 && pose.pitch > 5 && pose.pitch < 30 && pose.yaw < 0)
    assert.equal(landmarksProblem('tennis-doubles', ['doubles-near-left', 'doubles-near-right', 'doubles-far-right'], true), null)
    assert.equal(completingLandmark('tennis-doubles', ['doubles-near-left', 'doubles-near-right', 'doubles-far-right'])!.id, 'doubles-far-left')
  })

  it('draws court lines past the edge of the frame and shows coordinates in feet', () => {
    const close = lookAtCamera({ x: W / 2, y: -2, z: 2 }, { x: W / 2, y: 8, z: 0 }, 500, 640, 360)
    const lines = courtImageLines(courtFor(close, 640, 360))
    const points = lines.flat()
    assert.ok(points.some((point) => point.x < 0 || point.x > 640), 'some lines run out of the frame')
    assert.ok(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
    assert.equal(length(3.048, 'ft'), '10.0 ft')
    assert.equal(xyz({ x: 0, y: 0, z: 4.572 }, 'ft'), 'x 0.0 · y 0.0 · z 15.0 ft')
  })

  it('maps image points back to court meters and calls lines', () => {
    const toCourt = groundFromImage(court)!
    const spot = toCourt(projectPoint(behind, { x: 3.5, y: 15, z: 0 })!)!
    assert.ok(Math.hypot(spot.x - 3.5, spot.y - 15) < 1e-6)
    assert.equal(lineCall('tennis-doubles', { x: 0, y: 0 }), 'in')
    assert.equal(lineCall('tennis-doubles', { x: -0.3, y: 12 }), 'out')
    assert.equal(lineCall('tennis-doubles', { x: 0.8, y: 12 }, 'singles'), 'out', 'the doubles alley is out in singles')
    assert.equal(lineCall('tennis-doubles', { x: 1.35, y: 12 }, 'singles'), 'in', 'touching the singles line')
    assert.equal(lineCall('tennis-doubles', { x: 7, y: 8 }, 'serve-near-deuce'), 'in')
    assert.equal(lineCall('tennis-doubles', { x: 4, y: 8 }, 'serve-near-deuce'), 'out', 'the ad box')
    assert.equal(lineCall('tennis-doubles', { x: 7, y: 4 }, 'serve-near-deuce'), 'out', 'long')
    assert.equal(lineCall('tennis-doubles', { x: 4, y: 15 }, 'serve-far-deuce'), 'in')
    assert.ok(courtFitsTrack(trackOf([], 1), court))
  })
})

describe('Rapier prediction', () => {
  it('lands where the exact flight lands', async () => {
    const result = await predictFlight('tennis-doubles', { t: 0, p: { x: 2, y: 1, z: 1 }, v: { x: 1.5, y: 14, z: R - 1 + 4.905 } }, 2, NO_AIR)
    const first = result.bounces[0]!
    assert.ok(Math.abs(first.t - 1) < 0.01 && Math.hypot(first.p.x - 3.5, first.p.y - 15) < 0.05)
  })

  it('shortens a fast drive with air drag, more with topspin, and floats a slice', async () => {
    const start = { t: 0, p: { x: 5.5, y: 0.5, z: 1 }, v: { x: 0, y: 30, z: 4 } }
    const landing = async (air: Parameters<typeof predictFlight>[3]) => (await predictFlight('tennis-doubles', start, 3, air)).bounces[0]!.p.y
    const vacuum = await landing(NO_AIR)
    const drag = await landing({ drag: true, spin: 'none' })
    const topspin = await landing({ drag: true, spin: 'topspin' })
    const slice = await landing({ drag: true, spin: 'slice' })
    assert.ok(vacuum > L + 5, `without air the drive flies ${vacuum.toFixed(1)} m`)
    assert.ok(drag < vacuum - 4, `drag ${drag.toFixed(1)} m`)
    assert.ok(topspin < drag - 2 && topspin < L, `topspin ${topspin.toFixed(1)} m lands in`)
    assert.ok(slice > drag + 2, `slice ${slice.toFixed(1)} m floats`)
  })

  it('stops a low shot in the net', async () => {
    const result = await predictFlight('tennis-doubles', { t: 0, p: { x: 5, y: 2, z: 0.5 }, v: { x: 0, y: 15, z: 0.5 } }, 2)
    assert.equal(result.obstacle?.name, 'net')
    assert.ok(Math.abs(result.obstacle!.p.y - L / 2) < 0.3)
  })
})

describe('two-camera triangulation', () => {
  it('finds the 3D path, the bounce, and a clock error', () => {
    const start = 1_800_000_000_000
    const wobble = noise(5)
    const view = (camera: typeof behind, startedAt: number, reported: number, id: string): TakeView => {
      const points = []
      for (let i = 0; i <= 17; i += 1) {
        const t = i / 10
        const image = projectPoint(camera, truth((startedAt - start) / 1000 + t))!
        points.push({ t, x: image.x + wobble(1.5), y: image.y + wobble(1.5), radius: 6, score: 0.8 })
      }
      return { assetId: id, label: id, track: trackOf(points, 1.7), court: courtFor(camera, 640, 360), startedAt: reported }
    }
    const result = triangulateTake([view(behind, start, start, 'a'), view(corner, start + 37, start + 62, 'b')])!
    assert.ok(result.medianErrorPx < 1.5)
    assert.ok(Math.abs(result.peak - 1.79) < 0.1)
    assert.ok(Math.abs(result.cameras[1]!.shiftMs + 25) < 20, `clock shift ${result.cameras[1]!.shiftMs}`)
    const bounce = result.bounces[0]!
    assert.ok(Math.hypot(bounce.p.x - 3.5, bounce.p.y - 15) < 0.4)
    const end = ballisticEnd(result.points)!
    const want = truth(end.t)
    assert.ok(Math.hypot(end.p.x - want.x, end.p.y - want.y, end.p.z - want.z) < 0.5)
  })
})
