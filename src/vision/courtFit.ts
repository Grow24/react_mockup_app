import { COURT_PRESETS, type CourtPoint } from '../../shared/contracts.ts'
import { courtLines, LANDMARK_SETS, landmarkById } from '../../shared/court.ts'
import { solveLinear } from './flight.ts'

// A line in the image as a x + b y = c with a² + b² = 1, and how much painted line supports it.
export type ImageLine = { a: number; b: number; c: number; length: number }
export type Segment = [number, number, number, number]

const { widthMeters: W, lengthMeters: L } = COURT_PRESETS['tennis-doubles']
const SINGLES = 1.37
const SERVICE = L / 2 - 6.4
// Lines across the court (baselines, service lines) and along it (sidelines), as model coordinates.
const ACROSS = [0, SERVICE, L - SERVICE, L]
const ALONG = [0, SINGLES, W - SINGLES, W]
const STRONGEST = 12
const MIN_HIT_RATE = 0.6

function lineOf([x1, y1, x2, y2]: Segment): ImageLine | null {
  const length = Math.hypot(x2 - x1, y2 - y1)
  if (length < 1) return null
  const a = -(y2 - y1) / length
  const b = (x2 - x1) / length
  const sign = a < 0 || (a === 0 && b < 0) ? -1 : 1
  return { a: a * sign, b: b * sign, c: (a * x1 + b * y1) * sign, length }
}

// Segments of the same painted line, found piece by piece by Hough, merge into one line.
export function mergeSegments(segments: Segment[], diagonal: number): ImageLine[] {
  const lines = segments.map(lineOf).filter((line): line is ImageLine => !!line).sort((p, q) => q.length - p.length)
  const merged: ImageLine[] = []
  for (const line of lines) {
    const same = merged.find((other) => {
      const dot = Math.abs(line.a * other.a + line.b * other.b)
      return dot > Math.cos((2 * Math.PI) / 180) && Math.abs(line.c - other.c * Math.sign(line.a * other.a + line.b * other.b || 1)) < diagonal * 0.008
    })
    if (same) same.length += line.length
    else merged.push({ ...line })
  }
  return merged.filter((line) => line.length > diagonal * 0.05)
}

function meet(p: ImageLine, q: ImageLine) {
  const det = p.a * q.b - p.b * q.a
  if (Math.abs(det) < 1e-9) return null
  return { x: (p.c * q.b - p.b * q.c) / det, y: (p.a * q.c - p.c * q.a) / det }
}

export function homographyFrom(world: CourtPoint[], image: CourtPoint[]): number[] | null {
  const rows: number[][] = []
  const rhs: number[] = []
  world.forEach((w, index) => {
    const p = image[index]!
    rows.push([w.x, w.y, 1, 0, 0, 0, -p.x * w.x, -p.x * w.y])
    rhs.push(p.x)
    rows.push([0, 0, 0, w.x, w.y, 1, -p.y * w.x, -p.y * w.y])
    rhs.push(p.y)
  })
  const h = solveLinear(rows, rhs)
  return h ? [...h, 1] : null
}

export function project(h: number[], x: number, y: number) {
  const w = h[6]! * x + h[7]! * y + h[8]!
  if (Math.abs(w) < 1e-9) return null
  return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w, w }
}

type Mask = { data: Uint8Array; width: number; height: number }

const SEGMENTS = courtLines('tennis-doubles').filter((line) => !line.dashed)

// A court that collapses to a sliver or folds over cannot be the real one.
function sensible(h: number[], mask: Mask) {
  const corners = [
    [0, 0],
    [W, 0],
    [W, L],
    [0, L],
  ].map(([x, y]) => project(h, x!, y!))
  if (corners.some((point) => !point)) return false
  const side = Math.sign(corners[0]!.w)
  if (corners.some((point) => Math.sign(point!.w) !== side)) return false
  let area = 0
  let turn = 0
  for (let index = 0; index < 4; index += 1) {
    const a = corners[index]!
    const b = corners[(index + 1) % 4]!
    const c = corners[(index + 2) % 4]!
    area += a.x * b.y - b.x * a.y
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    turn += Math.sign(cross)
  }
  return Math.abs(turn) === 4 && Math.abs(area) / 2 >= mask.width * mask.height * 0.02
}

// How many pixels along the court's lines are painted, among those in view. Each pixel counts once,
// so a court squeezed onto a few bright pixels scores nothing.
function scoreOf(h: number[], mask: Mask, step: number) {
  if (!sensible(h, mask)) return null
  const hits = new Set<number>()
  const misses = new Set<number>()
  let total = 0
  for (const line of SEGMENTS) {
    const meters = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y)
    const count = Math.max(4, Math.round(meters / step))
    for (let k = 0; k <= count; k += 1) {
      total += 1
      const p = project(h, line.from.x + ((line.to.x - line.from.x) * k) / count, line.from.y + ((line.to.y - line.from.y) * k) / count)
      if (!p) continue
      const px = Math.round(p.x)
      const py = Math.round(p.y)
      if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) continue
      const index = py * mask.width + px
      if (mask.data[index]) hits.add(index)
      else misses.add(index)
    }
  }
  if (hits.size + misses.size < total * 0.1) return null
  return { hits: hits.size, misses: misses.size, score: hits.size - 0.5 * misses.size }
}

// Of the court's two mirror images, the one where the near baseline is nearer the camera
// (lower in the image) and left is left as seen from that end.
function canonical(h: number[]) {
  const flips = [
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    [-1, 0, W, 0, 1, 0, 0, 0, 1],
    [1, 0, 0, 0, -1, L, 0, 0, 1],
    [-1, 0, W, 0, -1, L, 0, 0, 1],
  ]
  for (const flip of flips) {
    const next = multiply(h, flip)
    const nearLeft = project(next, 0, 0)
    const nearRight = project(next, W, 0)
    const near = project(next, W / 2, 0)
    const far = project(next, W / 2, L)
    if (nearLeft && nearRight && near && far && nearLeft.x < nearRight.x && near.y > far.y) return next
  }
  return h
}

function multiply(a: number[], b: number[]) {
  const out: number[] = []
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0
      for (let k = 0; k < 3; k += 1) sum += a[row * 3 + k]! * b[k * 3 + col]!
      out.push(sum)
    }
  }
  return out
}

export type CourtFound = { h: number[]; hitRate: number; score: number }

// Least squares over any number of point pairs.
function homographyThrough(world: CourtPoint[], image: CourtPoint[]) {
  const normal = Array.from({ length: 8 }, () => new Array<number>(8).fill(0))
  const rhs = new Array<number>(8).fill(0)
  const add = (row: number[], value: number) => {
    for (let i = 0; i < 8; i += 1) {
      rhs[i]! += row[i]! * value
      for (let j = 0; j < 8; j += 1) normal[i]![j]! += row[i]! * row[j]!
    }
  }
  world.forEach((w, index) => {
    const p = image[index]!
    add([w.x, w.y, 1, 0, 0, 0, -p.x * w.x, -p.x * w.y], p.x)
    add([0, 0, 0, w.x, w.y, 1, -p.y * w.x, -p.y * w.y], p.y)
  })
  const h = solveLinear(normal, rhs)
  return h ? [...h, 1] : null
}

// Model lines as infinite lines: across the court at y, along it at x.
const POLISH_ACROSS = ACROSS
const POLISH_ALONG = [...ALONG, W / 2]

// Sub-pixel finish: the painted pixels next to each projected court line are fitted with a straight
// line, and the court is redone through every crossing of those lines.
function polish(h: number[], sharp: Mask) {
  const fitted = new Map<string, ImageLine>()
  const sample = (key: string, from: CourtPoint, to: CourtPoint) => {
    const points: CourtPoint[] = []
    const meters = Math.hypot(to.x - from.x, to.y - from.y)
    const count = Math.max(10, Math.round(meters / 0.1))
    for (let k = 1; k < count; k += 1) {
      const x = from.x + ((to.x - from.x) * k) / count
      const y = from.y + ((to.y - from.y) * k) / count
      const a = project(h, x, y)
      const b = project(h, x + (to.x - from.x) * 0.01, y + (to.y - from.y) * 0.01)
      if (!a || !b) continue
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      if (length < 1e-6) continue
      const nx = -(b.y - a.y) / length
      const ny = (b.x - a.x) / length
      // Only the painted run nearest the projected line: far away, the doubles and singles
      // sidelines are a few pixels apart and must not be averaged together.
      const painted = (d: number) => {
        const px = Math.round(a.x + nx * d)
        const py = Math.round(a.y + ny * d)
        return px >= 0 && py >= 0 && px < sharp.width && py < sharp.height && sharp.data[py * sharp.width + px] === 255
      }
      let start: number | null = null
      for (let r = 0; r <= 3 && start == null; r += 0.5) {
        if (painted(r)) start = r
        else if (painted(-r)) start = -r
      }
      if (start == null) continue
      let low = start
      let high = start
      while (low - 0.5 >= start - 3 && painted(low - 0.5)) low -= 0.5
      while (high + 0.5 <= start + 3 && painted(high + 0.5)) high += 0.5
      const middle = (low + high) / 2
      points.push({ x: a.x + nx * middle, y: a.y + ny * middle })
    }
    if (points.length < 10) return
    let mx = 0
    let my = 0
    for (const point of points) {
      mx += point.x
      my += point.y
    }
    mx /= points.length
    my /= points.length
    let xx = 0
    let yy = 0
    let xy = 0
    for (const point of points) {
      xx += (point.x - mx) ** 2
      yy += (point.y - my) ** 2
      xy += (point.x - mx) * (point.y - my)
    }
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
    const a = -Math.sin(angle)
    const b = Math.cos(angle)
    fitted.set(key, { a, b, c: a * mx + b * my, length: points.length })
  }
  for (const y of POLISH_ACROSS) {
    const inner = y !== 0 && y !== L
    sample(`y${y}`, { x: inner ? SINGLES : 0, y }, { x: inner ? W - SINGLES : W, y })
  }
  for (const x of POLISH_ALONG) {
    if (x === W / 2) sample(`x${x}`, { x, y: SERVICE }, { x, y: L - SERVICE })
    else sample(`x${x}`, { x, y: 0 }, { x, y: L })
  }
  const world: CourtPoint[] = []
  const image: CourtPoint[] = []
  for (const y of POLISH_ACROSS) {
    for (const x of POLISH_ALONG) {
      if (x === W / 2 && (y === 0 || y === L)) continue
      const across = fitted.get(`y${y}`)
      const along = fitted.get(`x${x}`)
      const crossing = across && along ? meet(across, along) : null
      if (!crossing) continue
      world.push({ x, y })
      image.push(crossing)
    }
  }
  return world.length >= 6 ? homographyThrough(world, image) : null
}

// Painted pixels that no court line passes near: a court shifted onto the wrong lines leaves some
// of the real lines unexplained.
function unexplained(h: number[], sharp: Mask) {
  const near = new Uint8Array(sharp.width * sharp.height)
  for (const line of SEGMENTS) {
    const meters = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y)
    const count = Math.max(8, Math.round(meters / 0.05))
    for (let k = 0; k <= count; k += 1) {
      const p = project(h, line.from.x + ((line.to.x - line.from.x) * k) / count, line.from.y + ((line.to.y - line.from.y) * k) / count)
      if (!p) continue
      const px = Math.round(p.x)
      const py = Math.round(p.y)
      for (let dy = -3; dy <= 3; dy += 1) {
        for (let dx = -3; dx <= 3; dx += 1) {
          const x = px + dx
          const y = py + dy
          if (x >= 0 && y >= 0 && x < sharp.width && y < sharp.height) near[y * sharp.width + x] = 1
        }
      }
    }
  }
  let count = 0
  for (let index = 0; index < near.length; index += 1) if (sharp.data[index] && !near[index]) count += 1
  return count
}

const angleBetween = (p: ImageLine, q: ImageLine) => (Math.acos(Math.min(1, Math.abs(p.a * q.a + p.b * q.b))) * 180) / Math.PI

type Candidate = { world: CourtPoint[]; image: CourtPoint[]; h: number[]; score: number }

// Nudges the four matched corners a pixel at a time while more of the court's lines land on paint.
function refine(candidate: Candidate, sharp: Mask) {
  let best = { ...candidate, score: scoreOf(candidate.h, sharp, 0.25)?.score ?? Number.NEGATIVE_INFINITY }
  for (const step of [2, 1, 0.5, 0.25]) {
    let improved = true
    while (improved) {
      improved = false
      for (let corner = 0; corner < 4; corner += 1) {
        for (const [dx, dy] of [
          [step, 0],
          [-step, 0],
          [0, step],
          [0, -step],
        ]) {
          const image = best.image.map((point, index) => (index === corner ? { x: point.x + dx!, y: point.y + dy! } : point))
          const h = homographyFrom(best.world, image)
          const score = h ? scoreOf(h, sharp, 0.25)?.score : undefined
          if (h && score != null && score > best.score) {
            best = { world: best.world, image, h, score }
            improved = true
          }
        }
      }
    }
  }
  return best
}

// Tries pairings of two lines across the court and two along it with two of the court's baselines
// or service lines and two of its sidelines, and keeps the court whose lines best cover the
// painted pixels, then fine-tunes it on the unblurred mask.
export function fitCourtModel(all: ImageLine[], mask: Mask, sharp: Mask = mask): CourtFound | null {
  const lines = all.slice(0, STRONGEST)
  const pairs: [ImageLine, ImageLine][] = []
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      if (angleBetween(lines[i]!, lines[j]!) <= 50) pairs.push([lines[i]!, lines[j]!])
    }
  }
  const coarse: Candidate[] = []
  for (const across of pairs) {
    for (const along of pairs) {
      if (along.includes(across[0]) || along.includes(across[1])) continue
      if (Math.min(...across.flatMap((p) => along.map((q) => angleBetween(p, q)))) < 15) continue
      for (const [first, second] of [across, [across[1], across[0]] as const]) {
        const corners = [meet(first, along[0]), meet(first, along[1]), meet(second, along[1]), meet(second, along[0])]
        if (corners.some((point) => !point)) continue
        for (let p = 0; p < ACROSS.length; p += 1) {
          for (let q = p + 1; q < ACROSS.length; q += 1) {
            for (let r = 0; r < ALONG.length; r += 1) {
              for (let s = r + 1; s < ALONG.length; s += 1) {
                const world = [
                  { x: ALONG[r]!, y: ACROSS[p]! },
                  { x: ALONG[s]!, y: ACROSS[p]! },
                  { x: ALONG[s]!, y: ACROSS[q]! },
                  { x: ALONG[r]!, y: ACROSS[q]! },
                ]
                const image = corners as CourtPoint[]
                const h = homographyFrom(world, image)
                if (!h) continue
                const quick = scoreOf(h, mask, 1.5)
                if (quick && quick.hits > 0) coarse.push({ world, image, h, score: quick.score })
              }
            }
          }
        }
      }
    }
  }
  coarse.sort((p, q) => q.score - p.score)
  let best: CourtFound | null = null
  let bestCandidate: Candidate | null = null
  for (const candidate of coarse.slice(0, 60)) {
    const fine = scoreOf(candidate.h, mask, 0.25)
    if (!fine) continue
    const hitRate = fine.hits / Math.max(1, fine.hits + fine.misses)
    const score = fine.score - 0.25 * unexplained(candidate.h, sharp)
    if (!best || score > best.score) {
      best = { h: candidate.h, hitRate, score }
      bestCandidate = candidate
    }
  }
  if (!best || !bestCandidate || best.hitRate < MIN_HIT_RATE) return null
  const tuned = refine(bestCandidate, sharp)
  let finished = tuned.h
  for (let round = 0; round < 3; round += 1) {
    const next = polish(finished, sharp)
    if (!next || !sensible(next, sharp)) break
    finished = next
  }
  return { ...best, h: canonical(finished) }
}

// Four court points to save: the first landmark set whose points are all in the photo.
export function landmarksInView(h: number[], width: number, height: number) {
  for (const set of LANDMARK_SETS['tennis-doubles']) {
    if (set.landmarks.length !== 4) continue
    const imagePoints = set.landmarks.map((id) => {
      const point = landmarkById('tennis-doubles', id)!
      return project(h, point.x, point.y)
    })
    if (imagePoints.every((point) => point && point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height)) {
      return { landmarks: set.landmarks, imagePoints: imagePoints.map((point) => ({ x: point!.x, y: point!.y })) }
    }
  }
  return null
}
