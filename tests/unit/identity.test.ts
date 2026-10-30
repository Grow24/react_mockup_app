import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PersonPose } from '../../shared/contracts.ts'
import { projectPoint } from '../../src/vision/flight.ts'
import { appearanceDistance, appearanceOf, PlayerIdentifier } from '../../src/vision/identity.ts'
import { behind } from '../helpers/scene.ts'

const WIDTH = 640
const HEIGHT = 360

type Outfit = { shirt: [number, number, number]; shorts: [number, number, number] }

// A standing person at (x, y) on the court, with their shirt and shorts painted into the frame.
function personAt(x: number, y: number, outfit: Outfit, pixels: Uint8ClampedArray): PersonPose {
  const ground = projectPoint(behind, { x, y, z: 0 })!
  const head = projectPoint(behind, { x, y, z: 1.8 })!
  const tall = ground.y - head.y
  const at = (level: number, side: number) => [ground.x + side * tall, head.y + level * tall, 0.9]
  const keypoints = [
    at(0, 0), at(0.02, -0.03), at(0.02, 0.03), at(0.03, -0.05), at(0.03, 0.05),
    at(0.18, -0.12), at(0.18, 0.12), at(0.33, -0.15), at(0.33, 0.15), at(0.45, -0.16), at(0.45, 0.16),
    at(0.5, -0.08), at(0.5, 0.08), at(0.75, -0.08), at(0.75, 0.08), at(1, -0.08), at(1, 0.08),
  ].flat()
  const paint = (top: number, bottom: number, rgb: [number, number, number]) => {
    for (let py = Math.round(head.y + top * tall); py <= head.y + bottom * tall; py += 1) {
      for (let px = Math.round(ground.x - 0.14 * tall); px <= ground.x + 0.14 * tall; px += 1) {
        if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) continue
        pixels.set([...rgb, 255], (py * WIDTH + px) * 4)
      }
    }
  }
  paint(0.15, 0.5, outfit.shirt)
  paint(0.5, 0.78, outfit.shorts)
  return { box: { x: ground.x - 0.2 * tall, y: head.y, width: 0.4 * tall, height: tall }, score: 0.9, keypoints }
}

function frame(players: [number, number, Outfit][]) {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4)
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) pixels.set([44, 120, 82, 255], index * 4)
  const people = players.map(([x, y, outfit]) => personAt(x, y, outfit, pixels))
  return { people, pixels }
}

const RED: Outfit = { shirt: [200, 40, 40], shorts: [240, 240, 240] }
const BLUE: Outfit = { shirt: [40, 60, 200], shorts: [20, 20, 20] }
const YELLOW: Outfit = { shirt: [230, 210, 40], shorts: [40, 60, 200] }
const WHITE: Outfit = { shirt: [245, 245, 245], shorts: [245, 245, 245] }

function run(identifier: PlayerIdentifier, frames: [number, number, Outfit][][]) {
  return frames.map((players, index) => {
    const { people, pixels } = frame(players)
    const looks = people.map((person) => appearanceOf(pixels, WIDTH, HEIGHT, person))
    const named = identifier.assign(people, looks, players.map(([x, y]) => ({ x, y })), index * 0.1)
    return named.map((person) => person.id)
  })
}

describe('player letters', () => {
  it('tells players apart by their clothes', () => {
    const { people, pixels } = frame([
      [3, 8, RED],
      [7, 8, BLUE],
    ])
    const [red, blue] = people.map((person) => appearanceOf(pixels, WIDTH, HEIGHT, person)!)
    assert.ok(appearanceDistance(red!.histogram, red!.histogram) < 1e-9)
    assert.ok(appearanceDistance(red!.histogram, blue!.histogram) > 0.5)
    assert.deepEqual(red!.torso, [200, 40, 40])
  })

  it('keeps each letter with the same player as they cross paths', () => {
    // Red walks right and blue walks left past each other at mid-court.
    const frames: [number, number, Outfit][][] = []
    for (let step = 0; step <= 10; step += 1) {
      frames.push([
        [2 + step * 0.7, 9, RED],
        [9 - step * 0.7, 9.4, BLUE],
      ])
    }
    const ids = run(new PlayerIdentifier(), frames)
    const first = ids[0]!
    for (const step of ids) assert.deepEqual(step, first)
  })

  it('letters a doubles match near team first, and keeps letters in the next video', () => {
    const identifier = new PlayerIdentifier()
    const [ids] = run(identifier, [
      [
        [3, -1, RED],
        [7, 3, BLUE],
        [3, 22, YELLOW],
        [8, 19, WHITE],
      ],
    ])
    assert.deepEqual(ids!.slice(0, 2).sort(), ['A', 'B'], 'the near pair')
    assert.deepEqual(ids!.slice(2).sort(), ['C', 'D'], 'the far pair')
    const byOutfit = new Map([RED, BLUE, YELLOW, WHITE].map((outfit, index) => [outfit, ids![index]]))
    // After changing ends, the same people come back in the next video with the same letters.
    const next = new PlayerIdentifier(identifier.profiles())
    const [again] = run(next, [
      [
        [3, -1, YELLOW],
        [7, 3, WHITE],
        [3, 22, RED],
        [8, 19, BLUE],
      ],
    ])
    assert.deepEqual(again, [byOutfit.get(YELLOW), byOutfit.get(WHITE), byOutfit.get(RED), byOutfit.get(BLUE)])
  })
})
