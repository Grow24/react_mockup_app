import { expect, test } from '@playwright/test'

// Court photos drawn from known cameras, with grain, a chain-link fence, and two players in the way.
test('finds the court in photos from behind, the corner, and high on the side', async ({ page }) => {
  await page.goto('/')
  const results = await page.evaluate(async () => {
    const scene = await import('/tests/helpers/scene.ts' as string)
    const flight = await import('/src/vision/flight.ts' as string)
    const court = await import('/shared/court.ts' as string)
    const { detectCourt } = await import('/src/vision/courtDetect.ts' as string)
    const { W, L, behind, corner, lookAtCamera, courtFor, noise } = scene
    const cameras = [
      ['behind', behind, 640, 360],
      ['corner', corner, 640, 360],
      ['high right', lookAtCamera({ x: W + 3, y: -3.05, z: 4.57 }, { x: W / 2, y: L / 2, z: 0 }, 900, 1280, 720), 1280, 720],
    ] as const
    const lines = court.courtLines('tennis-doubles').filter((line: { dashed?: boolean }) => !line.dashed)
    const onLine = (x: number, y: number) =>
      lines.some((line: { from: { x: number; y: number }; to: { x: number; y: number } }) => {
        const dx = line.to.x - line.from.x
        const dy = line.to.y - line.from.y
        const k = Math.max(0, Math.min(1, ((x - line.from.x) * dx + (y - line.from.y) * dy) / (dx * dx + dy * dy)))
        return Math.hypot(x - (line.from.x + k * dx), y - (line.from.y + k * dy)) <= 0.05
      })
    const out = []
    for (const [name, camera, width, height] of cameras) {
      const toCourt = flight.groundFromImage(courtFor(camera, width, height))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')!
      const image = context.createImageData(width, height)
      const grain = noise(9)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const spot = toCourt({ x: x + 0.5, y: y + 0.5 })
          let rgb = [60, 66, 74]
          if (spot && spot.x > -4 && spot.x < W + 4 && spot.y > -6 && spot.y < L + 6) rgb = [52, 110, 160]
          if (spot && spot.x >= 0 && spot.x <= W && spot.y >= 0 && spot.y <= L) rgb = [44, 120, 82]
          if (spot && onLine(spot.x, spot.y)) rgb = [232, 232, 226]
          const fence = (x % 23 < 1.2 || (x + y) % 23 < 1.2) && y > height * 0.15
          if (fence) rgb = rgb.map((value) => value * 0.55)
          const index = (y * width + x) * 4
          image.data[index] = rgb[0]! + grain(8)
          image.data[index + 1] = rgb[1]! + grain(8)
          image.data[index + 2] = rgb[2]! + grain(8)
          image.data[index + 3] = 255
        }
      }
      context.putImageData(image, 0, 0)
      // Two players standing on the court.
      for (const [px, py] of [
        [4, -1],
        [6, L - 2],
      ]) {
        const feet = flight.projectPoint(camera, { x: px, y: py, z: 0 })
        const head = flight.projectPoint(camera, { x: px, y: py, z: 1.8 })
        if (!feet || !head) continue
        context.fillStyle = '#c43d2f'
        const tall = feet.y - head.y
        context.fillRect(feet.x - tall * 0.15, head.y, tall * 0.3, tall)
      }
      const started = performance.now()
      const found = await detectCourt(canvas, width, height)
      const ms = performance.now() - started
      if (!found) {
        out.push({ name, error: Number.POSITIVE_INFINITY, ms, hitRate: 0, set: '' })
        continue
      }
      let error = 0
      found.landmarks.forEach((id: string, index: number) => {
        const world = court.landmarkById('tennis-doubles', id)
        const truth = flight.projectPoint(camera, { x: world.x, y: world.y, z: 0 })
        error = Math.max(error, Math.hypot(truth.x - found.imagePoints[index].x, truth.y - found.imagePoints[index].y))
      })
      const truths = found.landmarks.map((id: string) => {
        const world = court.landmarkById('tennis-doubles', id)
        const t = flight.projectPoint(camera, { x: world.x, y: world.y, z: 0 })
        return `${t.x.toFixed(0)},${t.y.toFixed(0)}`
      })
      out.push({ name, error, ms, hitRate: found.hitRate, set: found.landmarks.join(','), found: found.imagePoints.map((q: { x: number; y: number }) => `${q.x.toFixed(0)},${q.y.toFixed(0)}`).join(' '), truth: truths.join(' ') })
    }
    return out
  })
  for (const result of results) expect(result.error, JSON.stringify(result)).toBeLessThan(4)
})
