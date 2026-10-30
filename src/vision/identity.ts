import type { PersonPose, PlayerProfile } from '../../shared/contracts.ts'
import { feetOf, JOINTS, keypoint } from './players.ts'

const HUES = 12
const SATURATIONS = 3
const GREYS = 4
const BINS = HUES * SATURATIONS + GREYS
// Each player keeps their histogram up to date as lighting changes across the court.
const LEARN = 0.1
// Matched only below this combined cost; otherwise a new player.
const MATCH_COST = 0.55
const MAX_PLAYERS = 6
// A sprint is about 8 m/s; anything faster between two frames is a different person.
const SPRINT = 8
const RECENT_SECONDS = 1.5
const CLEAR_LOOK = 0.35
export const PLAYER_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

export type Appearance = { histogram: number[]; torso: [number, number, number]; legs: [number, number, number] }

type Box = { x0: number; y0: number; x1: number; y1: number }

function region(person: PersonPose, joints: number[], fallback: [number, number]): Box {
  const points = joints.map((index) => keypoint(person, index)).filter((point): point is { x: number; y: number } => !!point)
  const box = person.box
  if (points.length >= 3) {
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    // Pull in from the joints so the edges of the arms and the background stay out.
    const padX = (x1 - x0) * 0.15
    const padY = (y1 - y0) * 0.1
    return { x0: x0 + padX, y0: y0 + padY, x1: x1 - padX, y1: y1 - padY }
  }
  return {
    x0: box.x + box.width * 0.25,
    y0: box.y + box.height * fallback[0],
    x1: box.x + box.width * 0.75,
    y1: box.y + box.height * fallback[1],
  }
}

function binOf(r: number, g: number, b: number) {
  const top = Math.max(r, g, b)
  const bottom = Math.min(r, g, b)
  const saturation = top === 0 ? 0 : (top - bottom) / top
  if (saturation < 0.18) return HUES * SATURATIONS + Math.min(GREYS - 1, Math.floor((top / 256) * GREYS))
  let hue = 0
  if (top === r) hue = ((g - b) / (top - bottom) + 6) % 6
  else if (top === g) hue = (b - r) / (top - bottom) + 2
  else hue = (r - g) / (top - bottom) + 4
  const hueBin = Math.min(HUES - 1, Math.floor((hue / 6) * HUES))
  const satBin = Math.min(SATURATIONS - 1, Math.floor(((saturation - 0.18) / 0.82) * SATURATIONS))
  return hueBin * SATURATIONS + satBin
}

function describe(pixels: ArrayLike<number>, width: number, height: number, box: Box, scale: number, histogram: number[], offset: number) {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  const x0 = Math.max(0, Math.floor(box.x0 * scale))
  const x1 = Math.min(width - 1, Math.ceil(box.x1 * scale))
  const y0 = Math.max(0, Math.floor(box.y0 * scale))
  const y1 = Math.min(height - 1, Math.ceil(box.y1 * scale))
  const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 24))
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const at = (y * width + x) * 4
      const pr = pixels[at]!
      const pg = pixels[at + 1]!
      const pb = pixels[at + 2]!
      histogram[offset + binOf(pr, pg, pb)]! += 1
      r += pr
      g += pg
      b += pb
      count += 1
    }
  }
  if (count === 0) return null
  for (let index = 0; index < BINS; index += 1) histogram[offset + index]! /= count
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)] as [number, number, number]
}

// The colors of a person's shirt and shorts or skirt, from the frame's RGBA pixels. scale maps the
// person's coordinates onto the pixel grid.
export function appearanceOf(pixels: ArrayLike<number>, width: number, height: number, person: PersonPose, scale = 1): Appearance | null {
  const j = JOINTS
  const histogram = new Array<number>(BINS * 2).fill(0)
  const torso = describe(pixels, width, height, region(person, [j.leftShoulder, j.rightShoulder, j.leftHip, j.rightHip], [0.2, 0.5]), scale, histogram, 0)
  const legs = describe(pixels, width, height, region(person, [j.leftHip, j.rightHip, j.leftKnee, j.rightKnee], [0.5, 0.75]), scale, histogram, BINS)
  if (!torso || !legs) return null
  return { histogram, torso, legs }
}

// 0 for the same colors, 1 for nothing in common (one minus the Bhattacharyya coefficient).
export function appearanceDistance(a: number[], b: number[]) {
  let torso = 0
  let legs = 0
  for (let index = 0; index < BINS; index += 1) {
    torso += Math.sqrt(a[index]! * b[index]!)
    legs += Math.sqrt(a[BINS + index]! * b[BINS + index]!)
  }
  return 1 - (torso * 0.6 + legs * 0.4)
}

type Track = PlayerProfile & { lastT: number | null; last: { x: number; y: number } | null }

function permutations(count: number, slots: number): number[][] {
  if (count === 0) return [[]]
  const out: number[][] = []
  const walk = (prefix: number[]) => {
    if (prefix.length === count) {
      out.push(prefix)
      return
    }
    for (let slot = -1; slot < slots; slot += 1) {
      if (slot >= 0 && prefix.includes(slot)) continue
      walk([...prefix, slot])
    }
  }
  walk([])
  return out
}

// Gives each player a letter that stays with them: by their colors first, then by where they
// last stood. Seeds carry the letters over from other videos of the same session.
export class PlayerIdentifier {
  private readonly tracks: Track[]
  // Meters on the court, or pixels when no court is marked.
  private readonly reach: (dt: number) => number

  constructor(seeds: PlayerProfile[] = [], onCourt = true) {
    this.tracks = seeds.map((seed) => ({ ...seed, histogram: seed.histogram.slice(), frames: 0, lastT: null, last: null }))
    this.reach = onCourt ? (dt) => SPRINT * dt + 1.5 : (dt) => 400 * dt + 40
  }

  // spots are each person's feet: court meters with a court, image pixels without.
  assign(people: PersonPose[], appearances: (Appearance | null)[], spots: ({ x: number; y: number } | null)[], t: number) {
    const named = people.map((person) => ({ ...person }))
    const usable = people.map((_, index) => index).filter((index) => appearances[index]).slice(0, 5)
    const cost = (person: number, track: Track) => {
      const look = appearanceDistance(appearances[person]!.histogram, track.histogram)
      const spot = spots[person]
      if (track.lastT == null || !track.last || !spot) return look
      const dt = Math.max(1e-3, t - track.lastT)
      const moved = Math.hypot(spot.x - track.last.x, spot.y - track.last.y)
      if (dt < 2 && moved > this.reach(dt) * 2) return Number.POSITIVE_INFINITY
      return look + 0.4 * Math.min(1, moved / this.reach(dt))
    }
    let best: { total: number; plan: number[] } | null = null
    for (const plan of permutations(usable.length, this.tracks.length)) {
      let total = 0
      for (let k = 0; k < plan.length; k += 1) {
        const slot = plan[k]!
        total += slot < 0 ? MATCH_COST : cost(usable[k]!, this.tracks[slot]!)
      }
      if (!best || total < best.total) best = { total, plan }
    }
    const order = usable
      .map((person, k) => ({ person, slot: best?.plan[k] ?? -1 }))
      // New players are lettered nearest the camera first, like the near team before the far one.
      .sort((a, b) => feetOf(people[b.person]!).y - feetOf(people[a.person]!).y)
    const taken = new Set<Track>()
    for (const { slot } of order) if (slot >= 0) taken.add(this.tracks[slot]!)
    for (const { person, slot } of order) {
      let track = slot >= 0 && cost(person, this.tracks[slot]!) < MATCH_COST ? this.tracks[slot]! : null
      // Crossing another player hides part of the clothes; someone right where a player just was
      // is that player, even when the colors are off for a moment.
      if (!track) {
        const spot = spots[person]
        track =
          this.tracks.find(
            (candidate) =>
              (!taken.has(candidate) || candidate === this.tracks[slot]) &&
              candidate.lastT != null &&
              candidate.last &&
              spot &&
              t - candidate.lastT <= RECENT_SECONDS &&
              Math.hypot(spot.x - candidate.last.x, spot.y - candidate.last.y) <= this.reach(Math.max(0.05, t - candidate.lastT)),
          ) ?? null
      }
      if (!track) {
        if (this.tracks.length >= MAX_PLAYERS) continue
        const look = appearances[person]!
        track = { id: PLAYER_IDS[this.tracks.length]!, histogram: look.histogram.slice(), torso: look.torso, legs: look.legs, frames: 0, lastT: null, last: null }
        this.tracks.push(track)
      }
      taken.add(track)
      const look = appearances[person]!
      // Colors seen while half hidden would blur the player's own; only clear looks are learned.
      if (appearanceDistance(look.histogram, track.histogram) <= CLEAR_LOOK) {
        track.histogram = track.histogram.map((value, index) => value * (1 - LEARN) + look.histogram[index]! * LEARN)
        track.torso = look.torso
        track.legs = look.legs
      }
      track.frames += 1
      track.lastT = t
      track.last = spots[person] ?? track.last
      named[person]!.id = track.id
    }
    return named
  }

  // Players seen in only a handful of frames were flickers or passers-by and are dropped.
  profiles(minFrames = 1): PlayerProfile[] {
    return this.tracks
      .filter((track) => track.frames >= minFrames)
      .map(({ id, histogram, torso, legs, frames }) => ({ id, histogram: histogram.map((value) => Math.round(value * 1000) / 1000), torso, legs, frames }))
  }
}
