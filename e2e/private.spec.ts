import { expect, test } from '@playwright/test'
import { enableCamera } from './helpers.ts'

test('a session opens only with its key, and the key leaves the address bar', async ({ page, browser }) => {
  await page.goto('/')
  await expect(page.locator('.session-line')).toContainText('Private')
  const link = (await page.locator('.session-line a').getAttribute('href'))!
  expect(link).toMatch(/[?&]key=/)
  await enableCamera(page)
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'Capture photo' }).click()
  await expect(page.getByText(/Photo saved/)).toBeVisible()
  await page.waitForTimeout(1000)

  const friend = await (await browser.newContext()).newPage()
  await friend.goto(link)
  await expect.poll(() => friend.url()).not.toContain('key=')
  await friend.getByRole('link', { name: /Results/ }).click()
  const photo = friend.locator('.playback img').first()
  await expect(photo).toBeVisible()
  await expect.poll(() => photo.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)

  const id = new URL(link).searchParams.get('session')!
  const strangerContext = await browser.newContext()
  const stranger = await strangerContext.newPage()
  await stranger.goto(`/results?session=${id}`)
  await expect(stranger.locator('.warn').first()).toContainText('This session is private')
  await expect(stranger.locator('.asset-list button')).toHaveCount(0)
  expect((await strangerContext.request.get(`/api/sessions/${id}`)).status()).toBe(403)
  await stranger.goto(`/results?session=${id}&key=wrong`)
  await expect(stranger.locator('.warn').first()).toContainText('wrong session key')
})
