import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MotionTrack } from '../../shared/contracts.ts'
import { linkBallTrack, type BallFrame } from '../../src/vision/ball.ts'
import { fitFlights, flightBounces, projectPoint, type CourtCamera } from '../../src/vision/flight.ts'
import {
  applyHomography,
  invertHomography,
  motionAt,
  motionSummary,
  movedCourt,
  multiplyHomography,
  steadyBallTrack,
} from '../../src/vision/motion.ts'
import { behind, courtFor, trackOf, truth } from '../helpers/scene.ts'

const court = courtFor(behind, 640, 360)

// A phone turning by yaw and pitch (radians) about its own center: for a pure turn the image
// moves by K R K^-1, which is a homography for every point, near or far.
function turnHomography(camera: CourtCamera, yaw: number, pitch: number) {
  const f = camera.focal
  const k = [f, 0, camera.cx, 0, f, camera.cy, 0, 0, 1]
  const kInverse = invertHomography(k)!
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  const rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp]
  return multiplyHomography(k, multiplyHomography(multiplyHomography(rx, ry), kInverse))
}

function shaking(t: number) {
  return turnHomography(behind, 0.03 * Math.sin(t * 7), 0.02 * Math.cos(t * 5))
}

describe('camera motion', () => {
  it('inverts, blends, and carries the court along', () => {
    const h = shaking(0.4)
    const back = invertHomography(h)!
    const point = { x: 123, y: 210 }
    const round = applyHomography(back, applyHomography(h, point)!)!
    assert.ok(Math.hypot(round.x - point.x, round.y - point.y) < 1e-6)
    const motion: MotionTrack = {
      assetId: 'a',
      referenceId: 'r',
      sourceWidth: 640,
      sourceHeight: 360,
      sampleFps: 10,
      duration: 1,
      createdAt: 0,
      frames: [
        { t: 0, h: [1, 0, 0, 0, 1, 0, 0, 0, 1], inliers: 50 },
        { t: 1, h: [1, 0, 20, 0, 1, -10, 0, 0, 1], inliers: 50 },
      ],
    }
    const halfway = applyHomography(motionAt(motion, 0.5)!, { x: 0, y: 0 })!
    assert.deepEqual(halfway, { x: 10, y: -5 })
    assert.equal(movedCourt(court, motion.frames[1]!.h).imagePoints[0]!.x, court.imagePoints[0]!.x + 20)
    const summary = motionSummary(motion)
    assert.ok(Math.abs(summary.shift - Math.hypot(20, 10)) < 1e-6 && summary.trusted === 2)
  })

  it('finds the true bounce from a shaking phone once the motion is taken out', () => {
    const frames: BallFrame[] = []
    const motionFrames: MotionTrack['frames'] = []
    for (let i = 0; i <= 16; i += 1) {
      const t = i / 10
      const h = shaking(t)
      const seen = applyHomography(h, projectPoint(behind, truth(t))!)!
      frames.push({ t, candidates: [{ x: seen.x, y: seen.y, radius: 4, score: 0.8 }] })
      motionFrames.push({ t, h, inliers: 80 })
    }
    const track = trackOf(linkBallTrack(frames, 640, 360), 1.6)
    const motion: MotionTrack = { assetId: 'scene', referenceId: 'scene', sourceWidth: 640, sourceHeight: 360, sampleFps: 10, duration: 1.6, createdAt: 0, frames: motionFrames }
    const spotOf = (fit: ReturnType<typeof fitFlights>) => flightBounces(fit!.flights.filter((flight) => flight.reliable))[0]?.p
    const shaken = spotOf(fitFlights(track, court))
    const steady = spotOf(fitFlights(steadyBallTrack(track, motion, court), court))!
    assert.ok(Math.hypot(steady.x - 3.5, steady.y - 15) < 0.1, `steady bounce at ${steady.x.toFixed(2)}, ${steady.y.toFixed(2)}`)
    assert.ok(!shaken || Math.hypot(shaken.x - 3.5, shaken.y - 15) > 0.5, 'without the motion the bounce is off')
  })
})
