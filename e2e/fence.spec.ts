import { expect, test } from '@playwright/test'

type Fence = {
  FenceRemover: {
    create: (width: number, height: number, thickness?: string) => Promise<{
      useSingle: (source: CanvasImageSource) => void
      learn: (source: CanvasImageSource) => void
      coverage: () => number
      clean: (source: CanvasImageSource, target: HTMLCanvasElement) => void
      dispose: () => void
    }>
  }
}

// A dark chain-link fence drawn over a street photo is painted out, and the picture behind it comes back.
test('paints a chain-link fence out of a photo', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (modulePath) => {
    const { FenceRemover } = (await import(modulePath)) as Fence
    const image = new Image()
    image.src = '/e2e/.cache/bus.jpg'
    await image.decode()
    const width = 480
    const height = 640
    const draw = (fence: boolean) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0, width, height)
      if (fence) {
        context.strokeStyle = '#2b2f33'
        context.lineWidth = 2
        for (let k = -height; k < width + height; k += 26) {
          context.beginPath()
          context.moveTo(k, 0)
          context.lineTo(k + height, height)
          context.moveTo(k, 0)
          context.lineTo(k - height, height)
          context.stroke()
        }
      }
      return canvas
    }
    const clean = draw(false)
    const fenced = draw(true)
    const remover = await FenceRemover.create(width, height, 'thin')
    remover.useSingle(fenced)
    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    remover.clean(fenced, out)
    const pixels = (canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(0, 0, width, height).data
    const a = pixels(clean)
    const b = pixels(fenced)
    const c = pixels(out)
    let fenceBefore = 0
    let fenceAfter = 0
    let fencePixels = 0
    let restBefore = 0
    let restAfter = 0
    let restPixels = 0
    for (let index = 0; index < a.length; index += 4) {
      const before = Math.abs(a[index]! - b[index]!) + Math.abs(a[index + 1]! - b[index + 1]!) + Math.abs(a[index + 2]! - b[index + 2]!)
      const after = Math.abs(a[index]! - c[index]!) + Math.abs(a[index + 1]! - c[index + 1]!) + Math.abs(a[index + 2]! - c[index + 2]!)
      if (before > 60) {
        fenceBefore += before
        fenceAfter += after
        fencePixels += 1
      } else {
        restBefore += before
        restAfter += after
        restPixels += 1
      }
    }
    const shot = document.createElement('canvas')
    shot.id = 'shot'
    shot.width = width * 3
    shot.height = height
    const context = shot.getContext('2d')!
    context.drawImage(clean, 0, 0)
    context.drawImage(fenced, width, 0)
    context.drawImage(out, width * 2, 0)
    document.body.replaceChildren(shot)
    const coverage = remover.coverage()
    remover.dispose()
    return {
      fenceBefore: fenceBefore / fencePixels / 3,
      fenceAfter: fenceAfter / fencePixels / 3,
      restBefore: restBefore / restPixels / 3,
      restAfter: restAfter / restPixels / 3,
      coverage,
    }
  }, '/src/vision/fence.ts')
  await page.locator('#shot').screenshot({ path: 'test-results/fence.png' })
  expect(result.fenceAfter, JSON.stringify(result)).toBeLessThan(result.fenceBefore * 0.4)
  expect(result.restAfter, JSON.stringify(result)).toBeLessThan(14)
})

