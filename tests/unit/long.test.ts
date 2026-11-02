import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fpsForLength, POSE_TRACK_LIMIT, trackUnfinished, type BallPoint } from '../../shared/contracts.ts'
import { fitFlights, mergeFits, projectPoint, splitForFitting } from '../../src/vision/flight.ts'
import { behind, courtFor, trackOf, truth } from '../helpers/scene.ts'

const court = courtFor(behind, 640, 360)

// The same two-second flight and bounce every six seconds for a few minutes.
function rallies(minutes: number) {
  const points: BallPoint[] = []
  for (let start = 0; start < minutes * 60; start += 6) {
    for (let k = 0; k <= 20; k += 1) {
      const p = projectPoint(behind, truth(k / 10))!
      points.push({ t: start + k / 10, x: p.x, y: p.y, radius: 3, score: 0.8 })
    }
  }
  return points
}

describe('long videos', () => {
  it('fits a long track in pieces to the same flights as in one go', () => {
    const points = rallies(3)
    const whole = fitFlights(trackOf(points, 180), court)!
    const pieces = splitForFitting(points, 4)
    assert.equal(pieces.length, 4)
    assert.equal(pieces.flat().length, points.length)
    for (let index = 1; index < pieces.length; index += 1) {
      assert.ok(pieces[index]![0]!.t - pieces[index - 1]!.at(-1)!.t > 0.4, 'pieces are cut only where the ball was unseen')
    }
    const merged = mergeFits(pieces.map((piece) => fitFlights(trackOf(piece, 180), court)!))!
    assert.equal(merged.flights.length, whole.flights.length)
    merged.flights.forEach((flight, index) => {
      assert.equal(flight.from, whole.flights[index]!.from)
      assert.equal(flight.endBounce, whole.flights[index]!.endBounce)
    })
    assert.equal(merged.skipped, whole.skipped)
  })

  it('does not cut a track that has no long gap', () => {
    const points = Array.from({ length: 100 }, (_, index) => ({ t: index / 10, x: index, y: 1, radius: 3, score: 0.8 }))
    assert.equal(splitForFitting(points, 4).length, 1)
  })

  it('reads an hour of players at fewer frames per second so it fits in one track', () => {
    assert.equal(fpsForLength(120, 30), 30)
    assert.equal(fpsForLength(3600, 30), 10)
    assert.ok(Math.floor(3600 * fpsForLength(3600, 30)) + 1 <= POSE_TRACK_LIMIT)
    assert.equal(fpsForLength(3600, 5), 5)
  })

  it('tells a track read part of the way from a finished one', () => {
    assert.equal(trackUnfinished({ duration: 60, sampleFps: 10, videoDuration: 3000 }), true)
    assert.equal(trackUnfinished({ duration: 2999.95, sampleFps: 10, videoDuration: 3000 }), false)
    assert.equal(trackUnfinished({ duration: 60, sampleFps: 10 }), false)
  })
})
