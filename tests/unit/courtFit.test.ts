import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { courtLines, landmarkById } from '../../shared/court.ts'
import { fitCourtModel, landmarksInView, mergeSegments, type Segment } from '../../src/vision/courtFit.ts'
import { projectPoint } from '../../src/vision/flight.ts'
import { behind, corner } from '../helpers/scene.ts'

// The court's painted lines drawn into a mask from a known camera, plus Hough-like segments of them.
function scene(camera: typeof behind, width: number, height: number) {
  const data = new Uint8Array(width * height)
  const segments: Segment[] = []
  for (const line of courtLines('tennis-doubles')) {
    if (line.dashed) continue
    const steps = 400
    for (let k = 0; k <= steps; k += 1) {
      const p = projectPoint(camera, {
        x: line.from.x + ((line.to.x - line.from.x) * k) / steps,
        y: line.from.y + ((line.to.y - line.from.y) * k) / steps,
        z: 0,
      })
      if (!p) continue
      const x = Math.round(p.x)
      const y = Math.round(p.y)
      if (x >= 0 && y >= 0 && x < width && y < height) data[y * width + x] = 255
    }
    const a = projectPoint(camera, { ...line.from, z: 0 })!
    const b = projectPoint(camera, { ...line.to, z: 0 })!
    segments.push([a.x, a.y, b.x, b.y])
  }
  const grown = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let on = 0
      for (let dy = -2; dy <= 2 && !on; dy += 1) for (let dx = -2; dx <= 2 && !on; dx += 1) on = data[(y + dy) * width + x + dx] ?? 0
      grown[y * width + x] = on ? 255 : 0
    }
  }
  return { sharp: { data, width, height }, grown: { data: grown, width, height }, segments }
}

describe('court detection', () => {
  for (const [name, camera] of [
    ['behind', behind],
    ['corner', corner],
  ] as const) {
    it(`fits the court model to painted lines seen from ${name}`, () => {
      const { sharp, grown, segments } = scene(camera, 640, 360)
      const lines = mergeSegments(segments, Math.hypot(640, 360))
      const found = fitCourtModel(lines, grown, sharp)!
      assert.ok(found.hitRate > 0.8)
      const chosen = landmarksInView(found.h, 640, 360)!
      chosen.landmarks.forEach((id, index) => {
        const world = landmarkById('tennis-doubles', id)!
        const truth = projectPoint(camera, { x: world.x, y: world.y, z: 0 })!
        const error = Math.hypot(truth.x - chosen.imagePoints[index]!.x, truth.y - chosen.imagePoints[index]!.y)
        assert.ok(error < 2, `${id} is ${error.toFixed(2)} px off`)
      })
    })
  }
})
