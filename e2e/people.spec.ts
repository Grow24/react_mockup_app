import { expect, test } from '@playwright/test'
import type { PersonPose } from '../shared/contracts.ts'

type Detector = { detectPeople: (source: CanvasImageSource, width: number, height: number) => Promise<{ people: PersonPose[] } | null> }

test('YOLOv8n-pose finds several people with their joints in a photo', async ({ page }) => {
  await page.goto('/')
  // The page imports the app's own detector module from the dev server.
  const people = await page.evaluate(async (modulePath) => {
    const { detectPeople } = (await import(modulePath)) as Detector
    const image = new Image()
    image.src = '/e2e/.cache/bus.jpg'
    await image.decode()
    const reading = await detectPeople(image, image.naturalWidth, image.naturalHeight)
    return reading?.people ?? []
  }, '/src/vision/onnxDetector.ts')
  expect(people.length).toBeGreaterThanOrEqual(3)
  for (const person of people) {
    expect(person.keypoints).toHaveLength(51)
    const box = person.box
    const visible = []
    for (let index = 0; index < 17; index += 1) {
      if (person.keypoints[index * 3 + 2] < 0.5) continue
      visible.push({ x: person.keypoints[index * 3], y: person.keypoints[index * 3 + 1] })
    }
    expect(visible.length, 'confident joints').toBeGreaterThan(5)
    for (const point of visible) {
      expect(point.x).toBeGreaterThan(box.x - 30)
      expect(point.x).toBeLessThan(box.x + box.width + 30)
      expect(point.y).toBeGreaterThan(box.y - 30)
      expect(point.y).toBeLessThan(box.y + box.height + 30)
    }
  }
})
