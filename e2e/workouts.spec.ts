import { expect, test } from '@playwright/test'
import { newSession } from './helpers.ts'

test('logs a workout, flags a record, and shares it with another phone', async ({ page, browser }) => {
  const session = await newSession(page)
  await page.goto(`/workouts?session=${session.id}`)
  await page.getByRole('button', { name: 'Start a workout' }).click()
  await page.getByPlaceholder('Search by name, muscle, or equipment').fill('squat')
  await page.locator('.pick-list button', { hasText: 'Back squat' }).first().click()
  const squat = page.locator('section.entry[aria-label="Back squat"]')
  const field = (row: number, label: string) => squat.locator('.set-row').nth(row).locator('.set-field', { hasText: new RegExp(`^${label}$`) }).locator('input')
  for (const row of [0, 1]) {
    await field(row, 'kg').fill('100')
    await field(row, 'reps').fill('5')
    await squat.getByLabel(`Set ${row + 1} done`).check()
  }
  await expect(page.locator('.rest-bar')).toContainText('rest after Back squat')
  await squat.getByLabel('Remove set 3').click()
  await page.getByRole('button', { name: 'Finish workout' }).click()

  await page.getByRole('link', { name: 'History', exact: true }).click()
  await expect(page.locator('.history-row').first()).toContainText('1000 kg')
  await page.locator('.history-row .asset').first().click()
  await page.getByRole('button', { name: 'Repeat this workout' }).click()
  await expect(field(0, 'kg')).toHaveValue('100')
  await field(0, 'kg').fill('105')
  await squat.getByLabel('Set 1 done').check()
  await expect(squat.locator('.pr-badge').first()).toContainText('Heaviest 105 kg')
  await page.getByRole('button', { name: 'Finish workout' }).click()

  await page.getByRole('link', { name: '1RM' }).click()
  await expect(page.locator('.max-result')).toContainText('115.5 kg')
  await expect(page.locator('.max-chart')).toHaveAttribute('aria-label', /115\.5 to 121\.3 kg/)

  await page.getByRole('link', { name: 'Timers' }).click()
  const timer = page.locator('[aria-label="Interval timer"]')
  for (const [label, value] of [['Work (s)', '1'], ['Rest (s)', '1'], ['Rounds', '2'], ['Get ready (s)', '1']]) await timer.getByLabel(label).fill(value!)
  await timer.getByRole('button', { name: 'Start' }).click()
  await expect(timer.locator('.timer-big')).toHaveText('Done', { timeout: 10_000 })

  const phone = await browser.newContext()
  const other = await phone.newPage()
  await other.goto(`/workouts/history?session=${session.id}&key=${session.key}`)
  await expect(other.locator('.history-row')).toHaveCount(2)
  await phone.close()
})
