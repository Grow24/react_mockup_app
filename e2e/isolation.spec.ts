import { expect, test } from '@playwright/test'

// Threads need a cross-origin isolated page. require-corp is what Safari understands, so this runs
// in WebKit as well as Chromium: every CDN file still loads, and YOLOv8n gets more than one thread.
test('the page is cross-origin isolated and YOLOv8n runs with threads', async ({ page }) => {
  await page.goto('/ai')
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  await page.getByLabel('Object model').selectOption('yolov8n-coco-onnx')
  await page.getByRole('button', { name: 'Turn AI on' }).click()
  const running = page.getByText(/running in a worker on/)
  await expect(running).toBeVisible({ timeout: 150_000 })
  const text = await running.innerText()
  const threads = Number(text.match(/WASM ×(\d+)/)?.[1] ?? 0)
  expect(text.includes('WebGPU') || threads > 1, text).toBe(true)
})
