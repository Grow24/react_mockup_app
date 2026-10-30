import { expect, test, type Page } from '@playwright/test'
import { COURT_CORNERS } from './global-setup.ts'
import { enableCamera, markCourt, newSession } from './helpers.ts'

// The fake camera plays e2e/.cache/court.y4m: the court from behind, a ball bouncing at (3.5, 15) m.
async function courtFromCamera(page: Page) {
  await enableCamera(page)
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Capture photo' }).click()
  await expect(page.getByText(/Photo saved/)).toBeVisible()
  await page.getByRole('link', { name: /Results/ }).click()
  await page.locator('.asset-list button', { hasText: 'Photo' }).first().click()
  await markCourt(page, COURT_CORNERS)
}

test('tracks the ball in a recorded video and places the bounce in 3D', async ({ page }) => {
  const session = await newSession(page)
  await page.goto(`/?session=${session.id}`)
  await enableCamera(page)
  await page.getByRole('button', { name: 'Start recording' }).click()
  await page.waitForTimeout(3300)
  await page.getByRole('button', { name: 'Stop recording' }).click()
  await expect(page.getByText(/Video saved/)).toBeVisible()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Capture photo' }).click()
  await page.getByRole('link', { name: /Results/ }).click()
  await page.locator('.asset-list button', { hasText: 'Photo' }).first().click()
  await markCourt(page, COURT_CORNERS)

  await page.locator('.asset-list button', { hasText: 'Video' }).first().click()
  const panel = page.locator('[aria-label="Ball tracking"]')
  await panel.getByRole('button', { name: 'Track the ball' }).click()
  await expect(panel.getByRole('button', { name: 'Track again' })).toBeVisible({ timeout: 150_000 })
  await expect(panel.getByText(/Ball in \d+ of \d+ frames/)).toBeVisible()
  const bounce = panel.getByText(/^3D bounce 1 at/)
  await expect(bounce).toBeVisible({ timeout: 60_000 })
  const [, x, y] = (await bounce.innerText()).match(/: ([\d.]+) m from the left line, ([\d.]+) m from the near line/)!
  expect(Math.hypot(Number(x) - 3.5, Number(y) - 15)).toBeLessThan(1)
  await expect(panel.getByText(/^Rapier:/)).toBeVisible()
})

test('calls a live bounce in on the court marked for this phone', async ({ page }) => {
  const session = await newSession(page)
  await page.goto(`/?session=${session.id}`)
  await courtFromCamera(page)
  await page.getByRole('link', { name: 'Camera', exact: true }).click()
  await enableCamera(page)
  const live = page.locator('.card', { has: page.getByRole('heading', { name: 'Live ball' }) })
  await live.getByRole('button', { name: 'Start live ball' }).click()
  await expect(live.locator('.line-call')).toHaveText('IN', { timeout: 90_000 })
  await expect(live.locator('.line-call-box .muted')).toContainText('m from the left line')
})

test('builds a labeled training set and exports it for YOLO', async ({ page }) => {
  const session = await newSession(page)
  await page.goto(`/?session=${session.id}`)
  await enableCamera(page)
  await page.getByRole('button', { name: 'Start recording' }).click()
  await page.waitForTimeout(3200)
  await page.getByRole('button', { name: 'Stop recording' }).click()
  await expect(page.getByText(/Video saved/)).toBeVisible()
  await page.waitForTimeout(1500)

  await page.getByRole('link', { name: 'Training', exact: true }).click()
  const add = page.locator('[aria-label="Add frames"]')
  await add.getByLabel('One frame every (seconds)').fill('1')
  await add.getByRole('button', { name: 'Add frames from this video' }).click()
  await expect(page.locator('.thumb')).toHaveCount(4, { timeout: 60_000 })
  await page.locator('.thumb').nth(1).click()
  await page.getByRole('button', { name: 'Suggest boxes' }).click()
  await expect(page.getByText(/^Added 1 box/)).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.label-box span')).toHaveText(['ball'])

  await page.keyboard.press('2')
  const layer = (await page.locator('.label-layer').boundingBox())!
  await page.mouse.move(layer.x + layer.width * 0.1, layer.y + layer.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(layer.x + layer.width * 0.2, layer.y + layer.height * 0.6, { steps: 5 })
  await page.mouse.up()
  await expect(page.locator('.label-box span')).toHaveText(['ball', 'player'])
  await page.waitForTimeout(800)

  const archive = await (await page.request.get(`/api/sessions/${session.id}/training/export?labeled=1`)).body()
  const text = archive.toString('latin1')
  expect(text).toContain("0: 'ball'")
  expect(text).toMatch(/\n1 0\.150000 0\.450000 0\.100000 0\.300000/)
})
