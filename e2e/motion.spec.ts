import { expect, test } from '@playwright/test'

type Matcher = {
  MotionMatcher: {
    create: (reference: CanvasImageSource, width: number, height: number, court: null) => Promise<{
      measure: (source: CanvasImageSource) => { h: number[]; inliers: number } | null
      dispose: () => void
    }>
  }
}

// The photo is moved by a known shift, turn, and zoom, as a shaking camera would; the matcher has to find it.
test('measures a camera shift, turn, and zoom against the reference photo', async ({ page }) => {
  await page.goto('/')
  const errors = await page.evaluate(async (modulePath) => {
    const { MotionMatcher } = (await import(modulePath)) as Matcher
    const image = new Image()
    image.src = '/e2e/.cache/bus.jpg'
    await image.decode()
    const width = image.naturalWidth
    const height = image.naturalHeight
    const matcher = await MotionMatcher.create(image, width, height, null)
    const moves = [
      { dx: 0, dy: 0, turn: 0, zoom: 1 },
      { dx: 25, dy: -14, turn: 0, zoom: 1 },
      { dx: -18, dy: 10, turn: 2.5, zoom: 1 },
      { dx: 8, dy: 6, turn: -1.5, zoom: 1.05 },
    ]
    const results: number[] = []
    for (const move of moves) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')!
      context.translate(width / 2 + move.dx, height / 2 + move.dy)
      context.rotate((move.turn * Math.PI) / 180)
      context.scale(move.zoom, move.zoom)
      context.drawImage(image, -width / 2, -height / 2)
      const found = matcher.measure(canvas)
      if (!found) {
        results.push(Number.POSITIVE_INFINITY)
        continue
      }
      const transform = context.getTransform()
      let worst = 0
      for (const [x, y] of [
        [100, 100],
        [width - 100, 200],
        [width / 2, height / 2],
        [150, height - 150],
      ]) {
        const h = found.h
        const w = h[6]! * x! + h[7]! * y! + h[8]!
        const px = (h[0]! * x! + h[1]! * y! + h[2]!) / w
        const py = (h[3]! * x! + h[4]! * y! + h[5]!) / w
        const truth = transform.transformPoint({ x: x! - width / 2, y: y! - height / 2 })
        worst = Math.max(worst, Math.hypot(px - truth.x, py - truth.y))
      }
      results.push(worst)
    }
    matcher.dispose()
    return results
  }, '/src/vision/motionTracker.ts')
  for (const error of errors) expect(error).toBeLessThan(3)
})

type Tracker = {
  trackMotion: (
    videoUrl: string,
    referenceUrl: string,
    court: unknown,
    assetId: string,
    signal: AbortSignal,
    onProgress: () => void,
    fps: number,
  ) => Promise<{ frames: { t: number; h: number[]; inliers: number }[] }>
}

// A recorded video of the photo sliding sideways and back, as a phone panning; the tracker follows it.
test('tracks a panning video against its reference photo', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (modulePath) => {
    const { trackMotion } = (await import(modulePath)) as Tracker
    const image = new Image()
    image.src = '/e2e/.cache/bus.jpg'
    await image.decode()
    const width = 480
    const height = 640
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    const stream = canvas.captureStream(30)
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 6_000_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => chunks.push(event.data)
    const done = new Promise((resolve) => (recorder.onstop = resolve))
    const started = performance.now()
    let biggest = 0
    recorder.start()
    await new Promise<void>((resolve) => {
      const draw = () => {
        const t = (performance.now() - started) / 1000
        const shift = 30 * Math.sin(t * 3)
        biggest = Math.max(biggest, Math.abs(shift))
        context.fillStyle = '#000'
        context.fillRect(0, 0, width, height)
        context.drawImage(image, shift, 0, width, height)
        if (t < 2.2) requestAnimationFrame(draw)
        else resolve()
      }
      draw()
    })
    recorder.stop()
    await done
    const videoUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))
    const still = document.createElement('canvas')
    still.width = width
    still.height = height
    still.getContext('2d')!.drawImage(image, 0, 0, width, height)
    const referenceUrl = still.toDataURL('image/png')
    const court = {
      preset: 'tennis-doubles',
      assetId: crypto.randomUUID(),
      sourceWidth: width,
      sourceHeight: height,
      imagePoints: [
        { x: 40, y: 600 },
        { x: 440, y: 600 },
        { x: 360, y: 380 },
        { x: 120, y: 380 },
      ],
    }
    const motion = await trackMotion(videoUrl, referenceUrl, court, 'video', new AbortController().signal, () => undefined, 10)
    const shifts = motion.frames.map((frame) => frame.h[2]!)
    return {
      biggest,
      measured: Math.max(...shifts.map(Math.abs)),
      matched: motion.frames.filter((frame) => frame.inliers > 0).length,
      total: motion.frames.length,
      vertical: Math.max(...motion.frames.map((frame) => Math.abs(frame.h[5]!))),
    }
  }, '/src/vision/motionTracker.ts')
  expect(result.matched).toBeGreaterThan(result.total * 0.8)
  expect(Math.abs(result.measured - result.biggest)).toBeLessThan(6)
  expect(result.vertical).toBeLessThan(4)
})
