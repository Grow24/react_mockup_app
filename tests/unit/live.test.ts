import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PersonPose } from '../../shared/contracts.ts'
import type { Flight } from '../../src/vision/flight.ts'
import { LiveRoster, liveState, mergeShots, playersNow, shotsInWindow } from '../../src/vision/livePlayers.ts'
import type { Shot } from '../../src/vision/match.ts'
import { flight, person, type Arms } from '../helpers/players.ts'
import { behind, courtFor, R } from '../helpers/scene.ts'

const court = courtFor(behind, 640, 360)
// The live clock is the page's, which does not start at zero.
const CLOCK = 1000
const WINDOW = 4

const flights = [
  flight(0, 1, { x: 6, y: -0.5, z: 2.6 }, { x: 3.5, y: 16, z: R }, false, true),
  flight(1, 1.5, { x: 3.5, y: 16, z: R }, { x: 3, y: 22, z: 1 }, true, false),
  flight(1.5, 2.5, { x: 3, y: 22, z: 1 }, { x: 4.5, y: 9, z: 1 }, false, false),
  flight(2.5, 3.4, { x: 4.5, y: 9, z: 1 }, { x: 6, y: 20, z: R }, false, true),
  flight(3.4, 3.9, { x: 6, y: 20, z: R }, { x: 7, y: 25, z: 0.6 }, true, false),
  flight(40, 41, { x: 6, y: -0.5, z: 2.6 }, { x: 7, y: 16, z: R }, false, true),
]

// What the live fit sees of the flights in one window: times from the window's start, and a flight
// cut by the window's start has lost the bounce or hit it began with.
function windowFlights(from: number): Flight[] {
  return flights.flatMap((item) => {
    const start = Math.max(item.from, from)
    const end = Math.min(item.to, from + WINDOW)
    if (end - start < 0.05) return []
    const cut = item.from < from
    return [{
      ...item,
      t0: item.t0 - from,
      from: start - from,
      to: end - from,
      startBounce: cut || item.startBounce == null ? null : item.startBounce - from,
      endBounce: item.to > from + WINDOW || item.endBounce == null ? null : item.endBounce - from,
    }]
  })
}

function scene(t: number): PersonPose[] {
  const arms = (near: boolean): Arms => {
    if (near && (Math.abs(t) < 0.15 || Math.abs(t - 40) < 0.15)) return 'overhead'
    if (near && Math.abs(t - 2.5) < 0.15) return 'backhand-near'
    if (!near && Math.abs(t - 1.5) < 0.15) return 'forehand-far'
    return 'rest'
  }
  const near = t > 2 && t < 3.5 ? person('A', 4.5, 9, arms(true)) : person('A', 6, -0.5, arms(true))
  return [near, person('B', 3, 22, arms(false))]
}

describe('live players and shots', () => {
  it('reads the same shots from sliding live windows as from the whole video', () => {
    const roster = new LiveRoster()
    for (let i = -12; i <= 166; i += 1) roster.add(CLOCK + i / 4, scene(i / 4), null, court, 640, 360)
    let shots: Shot[] = []
    for (let from = -3; from <= 40; from += 0.5) {
      const window = { from: CLOCK + from, duration: WINDOW, fit: { camera: behind, skipped: 0, flights: windowFlights(from) }, court }
      shots = mergeShots(shots, shotsInWindow(window, roster), window)
    }
    assert.deepEqual(
      shots.map((shot) => `${(shot.t - CLOCK).toFixed(1)} ${shot.player} ${shot.kind}`),
      ['0.0 A serve', '1.5 B forehand drive', '2.5 A backhand volley', '40.0 A serve'],
    )
  })

  it('calls an overhead soon after another shot a smash, since one window cannot see the shot before', () => {
    const shot = (t: number, kind: Shot['kind']): Shot => ({ t, p: { x: 5, y: 2, z: 2.5 }, player: 'A', kind, handSpeed: null, twoHanded: false })
    const merged = mergeShots([shot(10, 'forehand drive')], [shot(11.8, 'serve')], { from: 10, duration: WINDOW })
    assert.deepEqual(merged.map((item) => item.kind), ['forehand drive', 'overhead smash'])
  })

  it('tells a rally from a gap and a break, and sees the players resting', () => {
    const roster = new LiveRoster()
    for (let i = 0; i <= 400; i += 1) roster.add(CLOCK + i / 4, scene(50), null, court, 640, 360)
    const shot = (t: number): Shot => ({ t: CLOCK + t, p: { x: 5, y: 2, z: 1 }, player: 'A', kind: 'forehand drive', handSpeed: null, twoHanded: false })
    const shots = [shot(1), shot(2.5), shot(4)]
    assert.deepEqual(liveState(shots, CLOCK + 5, roster, court), { kind: 'rally', shots: 3, since: CLOCK + 1 })
    assert.equal(liveState(shots, CLOCK + 9, roster, court)?.kind, 'over')
    assert.deepEqual(liveState(shots, CLOCK + 20, roster, court), { kind: 'gap', since: CLOCK + 4, resting: true })
    assert.equal(liveState(shots, CLOCK + 90, roster, court)?.kind, 'break')
    assert.equal(liveState([], CLOCK + 9, roster, court), null)
  })

  it('letters players by their clothes and keeps the letters when they swap places in the list', () => {
    const width = 640
    const height = 360
    const pixels = new Uint8ClampedArray(width * height * 4)
    const paint = (who: PersonPose, rgb: [number, number, number]) => {
      for (let y = Math.max(0, Math.floor(who.box.y)); y < Math.min(height, who.box.y + who.box.height); y += 1) {
        for (let x = Math.max(0, Math.floor(who.box.x)); x < Math.min(width, who.box.x + who.box.width); x += 1) {
          pixels.set([...rgb, 255], (y * width + x) * 4)
        }
      }
    }
    const strip = ({ id: _id, ...rest }: PersonPose) => rest
    const near = strip(person('A', 6, 1, 'rest'))
    const far = strip(person('B', 4, 23, 'rest'))
    paint(near, [200, 30, 30])
    paint(far, [30, 60, 210])
    const look = { pixels, width, height, scale: 1 }
    {
      const roster = new LiveRoster()
      for (let i = 0; i < 6; i += 1) {
        const order = i % 2 === 0 ? [near, far] : [far, near]
        const named = roster.add(CLOCK + i / 3, order, look, court, width, height)
        const byColor = Object.fromEntries(named.map((item) => [item === named[order.indexOf(near)] ? 'red' : 'blue', item.id]))
        assert.deepEqual(byColor, { red: 'A', blue: 'B' })
      }
      const now = playersNow(roster, court, CLOCK + 2)
      assert.deepEqual(now.map((item) => [item.key, item.zone]).sort(), [['A', 'baseline'], ['B', 'baseline']])
      const saved = roster.track(CLOCK, CLOCK + 2, 'video')!
      assert.equal(saved.frames[0]!.t, 0)
      assert.equal(saved.assetId, 'video')
      assert.deepEqual(saved.players?.map((item) => item.id), ['A', 'B'])
    }
  })
})
