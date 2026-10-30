import { expect, type Page } from '@playwright/test'

// Creates a private session in this browser context; the server answers with its key and a cookie.
export async function newSession(page: Page) {
  const id = crypto.randomUUID()
  const response = await page.request.post('/api/sessions', { data: { id, device: { id: crypto.randomUUID(), label: 'e2e' } } })
  expect(response.ok()).toBeTruthy()
  const body = (await response.json()) as { key: string }
  return { id, key: body.key }
}

export async function enableCamera(page: Page) {
  await page.getByRole('button', { name: 'Enable camera' }).click()
  await expect(page.getByRole('button', { name: 'Capture photo' })).toBeEnabled({ timeout: 20_000 })
}

// Clicks the four court corners on the court photo, in source pixels.
export async function markCourt(page: Page, corners: { x: number; y: number }[]) {
  const image = page.locator('.court-photo img')
  await expect(image).toBeVisible()
  await page.waitForFunction(() => (document.querySelector('.court-photo img') as HTMLImageElement | null)?.naturalWidth)
  const box = (await image.boundingBox())!
  const [width, height] = await image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])
  const scale = Math.min(box.width / width!, box.height / height!)
  const left = box.x + (box.width - width! * scale) / 2
  const top = box.y + (box.height - height! * scale) / 2
  for (const corner of corners) await page.mouse.click(left + corner.x * scale, top + corner.y * scale)
  await expect(page.locator('.court-flat')).toBeVisible()
}
