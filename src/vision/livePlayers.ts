import {
  COURT_PRESETS,
  PEOPLE_MODEL_ID,
  POSE_TRACK_LIMIT,
  type CourtCalibration,
  type PersonPose,
  type PlayerProfile,
  type PoseFrame,
  type PoseTrack,
} from '../../shared/contracts.ts'
import type { FlightFit } from './flight.ts'
import { appearanceOf, PlayerIdentifier } from './identity.ts'
import { BREAK_SECONDS, GAP_SECONDS, RALLY_GAP, readMatch, RESTING_SPEED, SERVE_PAUSE, type Shot } from './match.ts'
import { courtFits, courtZone, feetOnCourt, identitySpot, onCourt as standsOn, playerPaths } from './players.ts'

const KEEP_SECONDS = 15 * 60
// A shot is settled only by a window that also saw the ball coming to it, from its last bounce or
// hit, and a little of its way out; nearer the ends, another window reads it.
const START_EDGE = 1.5
const END_EDGE = 0.4
const SAME_SHOT_SECONDS = 0.3
// Enough for a long session's score.
const KEEP_SHOTS = 3000
// A player last seen longer ago than this is no longer on the map.
const SEEN_SECONDS = 1
const RESTING_WINDOW = 6

export type FramePixels = { pixels: ArrayLike<number>; width: number; height: number; scale: number }

// One fitted window of the live ball, on the device clock.
export type LiveFit = { from: number; duration: number; fit: FlightFit; court: CourtCalibration }

// The live preview's players over the last minutes: each lettered by their clothes, with their
// joints and racquet, on the same clock as the live ball.
export class LiveRoster {
  frames: PoseFrame[] = []
  width = 0
  height = 0
  private seeds: PlayerProfile[]
  private onCourt = false
  private identifier: PlayerIdentifier

  constructor(seeds: PlayerProfile[] = []) {
    this.seeds = seeds
    this.identifier = new PlayerIdentifier(seeds, false)
  }

  // Letters from the session's videos; taken only while nobody has been lettered live.
  seed(seeds: PlayerProfile[]) {
    if (this.identifier.profiles().length > 0) return
    this.seeds = seeds
    this.identifier = new PlayerIdentifier(seeds, this.onCourt)
  }

  profiles() {
    return this.identifier.profiles()
  }

  // courts are the ones this camera watches; people are placed on the one they stand on.
  add(t: number, people: PersonPose[], look: FramePixels | null, courtOrCourts: CourtCalibration | CourtCalibration[] | null, width: number, height: number) {
    const listed = Array.isArray(courtOrCourts) ? courtOrCourts : courtOrCourts ? [courtOrCourts] : []
    const courts = listed.filter((court) => courtFits(court, width, height))
    if (width !== this.width || height !== this.height) {
      this.frames = []
      this.width = width
      this.height = height
    }
    // Feet are in court meters with a matching court and in pixels without, so a change starts the letters afresh.
    const onCourt = courts.length > 0
    if (onCourt !== this.onCourt) {
      this.onCourt = onCourt
      this.identifier = new PlayerIdentifier(this.seeds, onCourt)
    }
    let named = people
    if (look && people.length > 0) {
      const appearances = people.map((person) => appearanceOf(look.pixels, look.width, look.height, person, look.scale))
      const spots = people.map((person) => identitySpot(person, courts, width, height))
      named = this.identifier.assign(people, appearances, spots, t)
    }
    this.frames.push({ t, people: named })
    while (this.frames.length > 0 && t - this.frames[0]!.t > KEEP_SECONDS) this.frames.shift()
    return named
  }

  // The frames between from and to as a pose track whose clock starts at from.
  track(from: number, to: number, assetId = ''): PoseTrack | null {
    const inside = this.frames.filter((frame) => frame.t >= from && frame.t <= to).slice(-POSE_TRACK_LIMIT)
    if (inside.length === 0 || this.width < 2) return null
    const duration = Math.max(0, to - from)
    const players = this.identifier.profiles(2)
    const kept = new Set(players.map((player) => player.id))
    const flickers = new Set(this.identifier.profiles().filter((player) => !kept.has(player.id)).map((player) => player.id))
    const frames = inside.map((frame) => ({
      t: frame.t - from,
      people: frame.people.map((person) => {
        if (!person.id || !flickers.has(person.id)) return person
        const { id: _flicker, ...rest } = person
        return rest
      }),
    }))
    return {
      assetId,
      modelId: PEOPLE_MODEL_ID,
      sourceWidth: this.width,
      sourceHeight: this.height,
      sampleFps: Math.min(60, Math.max(1, Math.round(frames.length / Math.max(duration, 1e-3)))),
      duration,
      createdAt: Date.now(),
      frames,
      players,
    }
  }
}

// The shots read from one fitted window of the live ball, on the device clock.
export function shotsInWindow(window: LiveFit, roster: LiveRoster): Shot[] {
  const track = roster.track(window.from, window.from + window.duration)
  return readMatch(window.fit, track, window.court, window.duration).shots.map((shot) => ({ ...shot, t: shot.t + window.from }))
}

// Puts the settled middle of a new window in place of what the running list had there. A window
// does not see the shots before it, so an overhead soon after one is a smash, not a serve.
export function mergeShots(shots: Shot[], fresh: Shot[], window: { from: number; duration: number }): Shot[] {
  const from = window.from + START_EDGE
  const to = window.from + window.duration - END_EDGE
  if (to <= from) return shots
  const settled = fresh.filter((shot) => shot.t >= from && shot.t <= to)
  const kept = shots.filter((shot) => (shot.t < from || shot.t > to) && !settled.some((other) => Math.abs(other.t - shot.t) <= SAME_SHOT_SECONDS))
  const merged = [...kept, ...settled].sort((a, b) => a.t - b.t)
  return merged
    .map((shot, index) =>
      shot.kind === 'serve' && index > 0 && shot.t - merged[index - 1]!.t <= SERVE_PAUSE ? { ...shot, kind: shot.player ? ('overhead smash' as const) : ('shot' as const) } : shot,
    )
    .slice(-KEEP_SHOTS)
}

// How fast the players walked on average between from and to, meters per second.
export function walkingSpeed(roster: LiveRoster, court: CourtCalibration | null, from: number, to: number) {
  const track = roster.track(from, to)
  if (!track || !court || !courtFits(court, track.sourceWidth, track.sourceHeight)) return null
  const { paths, summary } = playerPaths(track, court)
  let meters = 0
  let seconds = 0
  for (const [key, path] of paths) {
    if (path.length < 2) continue
    meters += summary.get(key)!.meters
    seconds += path.at(-1)!.t - path[0]!.t
  }
  return seconds > 0 ? meters / seconds : null
}

export type LiveState =
  | { kind: 'rally'; shots: number; since: number }
  | { kind: 'over' | 'gap' | 'break'; since: number; resting: boolean | null }

// Whether a rally is on now, and if not, how long the ball has been quiet and whether the players are resting.
export function liveState(shots: Shot[], now: number, roster: LiveRoster, court: CourtCalibration | null): LiveState | null {
  const last = shots.at(-1)
  if (!last) return null
  if (now - last.t <= RALLY_GAP) {
    let first = shots.length - 1
    while (first > 0 && shots[first]!.t - shots[first - 1]!.t <= RALLY_GAP) first -= 1
    return { kind: 'rally', shots: shots.length - first, since: shots[first]!.t }
  }
  const quiet = now - last.t
  const speed = quiet >= GAP_SECONDS ? walkingSpeed(roster, court, now - RESTING_WINDOW, now) : null
  return {
    kind: quiet >= BREAK_SECONDS ? 'break' : quiet >= GAP_SECONDS ? 'gap' : 'over',
    since: last.t,
    resting: speed == null ? null : speed < RESTING_SPEED,
  }
}

export type PlayerNow = {
  key: string
  person: PersonPose
  feet: { x: number; y: number } | null
  zone: ReturnType<typeof courtZone> | null
}

// Each player in the newest frame, with their feet on the court and the part of it they stand in.
export function playersNow(roster: LiveRoster, court: CourtCalibration | null, now: number): PlayerNow[] {
  const frame = roster.frames.at(-1)
  if (!frame || now - frame.t > SEEN_SECONDS) return []
  const lengthMeters = court ? COURT_PRESETS[court.preset].lengthMeters : 0
  return frame.people.flatMap((person) => {
    const key = person.id ?? person.player
    if (!key) return []
    const feet = court && standsOn(person, court) ? feetOnCourt(person, court, roster.width, roster.height) : null
    return [{ key, person, feet, zone: feet && court?.preset === 'tennis-doubles' ? courtZone(feet, lengthMeters) : null }]
  })
}
