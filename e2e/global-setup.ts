import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { projectPoint } from '../src/vision/flight.ts'
import { behind, L, truth, W } from '../tests/helpers/scene.ts'

const WIDTH = 640
const HEIGHT = 360
const FPS = 30
const LOOP_SECONDS = 3
const HOLD_SECONDS = 0.5
const BALL_RADIUS = 14

export const COURT_CORNERS = [
  [0, 0],
  [W, 0],
  [W, L],
  [0, L],
].map(([x, y]) => projectPoint(behind, { x: x!, y: y!, z: 0 })!)

// Chrome's fake camera plays this clip: the court from behind, and a ball that bounces at (3.5, 15) m.
function writeCourtClip(path: string) {
  const inside = (px: number, py: number) => {
    let hit = false
    for (let i = 0, j = COURT_CORNERS.length - 1; i < COURT_CORNERS.length; j = i++) {
      const a = COURT_CORNERS[i]!
      const b = COURT_CORNERS[j]!
      if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) hit = !hit
    }
    return hit
  }
  const background = new Uint8Array(WIDTH * HEIGHT * 3)
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) background.set(inside(x + 0.5, y + 0.5) ? [47, 122, 79] : [58, 63, 70], (y * WIDTH + x) * 3)
  }
  const file = openSync(path, 'w')
  writeSync(file, `YUV4MPEG2 W${WIDTH} H${HEIGHT} F${FPS}:1 Ip A1:1 C420jpeg\n`)
  for (let frame = 0; frame < LOOP_SECONDS * FPS; frame += 1) {
    const ball = projectPoint(behind, truth(Math.min(1.75, Math.max(0, frame / FPS - HOLD_SECONDS))))!
    const rgb = Uint8Array.from(background)
    for (let y = Math.floor(ball.y - BALL_RADIUS); y <= ball.y + BALL_RADIUS; y += 1) {
      for (let x = Math.floor(ball.x - BALL_RADIUS); x <= ball.x + BALL_RADIUS; x += 1) {
        if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT || Math.hypot(x + 0.5 - ball.x, y + 0.5 - ball.y) > BALL_RADIUS) continue
        const shade = Math.min(1, Math.hypot(x - (ball.x - 4), y - (ball.y - 4)) / BALL_RADIUS)
        const seam = [-1, 1].some((side) => Math.abs(Math.hypot(x + 0.5 - (ball.x + side * BALL_RADIUS * 1.1), y + 0.5 - ball.y) - BALL_RADIUS * 0.8) < 1.1)
        rgb.set(seam ? [248, 248, 240] : [244 - 76 * shade, 255 - 59 * shade, 122 - 94 * shade].map(Math.round), (y * WIDTH + x) * 3)
      }
    }
    const luma = Buffer.alloc(WIDTH * HEIGHT)
    const blue = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2))
    const red = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2))
    for (let i = 0; i < WIDTH * HEIGHT; i += 1) luma[i] = Math.round(0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!)
    for (let y = 0; y < HEIGHT / 2; y += 1) {
      for (let x = 0; x < WIDTH / 2; x += 1) {
        const o = (y * 2 * WIDTH + x * 2) * 3
        const [r, g, b] = [rgb[o]!, rgb[o + 1]!, rgb[o + 2]!]
        blue[y * (WIDTH / 2) + x] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)))
        red[y * (WIDTH / 2) + x] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)))
      }
    }
    writeSync(file, 'FRAME\n')
    writeSync(file, luma)
    writeSync(file, blue)
    writeSync(file, red)
  }
  closeSync(file)
}

export default function globalSetup() {
  mkdirSync('e2e/.cache', { recursive: true })
  if (!existsSync('e2e/.cache/court.y4m')) writeCourtClip('e2e/.cache/court.y4m')
}
