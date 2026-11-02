import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Shot } from '../../src/vision/match.ts'
import { faultText, keepScore, pointText, readPoints, scoreLine, serviceBox, type PointResult, type Side } from '../../src/vision/score.ts'
import { behind, courtFor, W } from '../helpers/scene.ts'

const court = courtFor(behind, 640, 360)

function shot(t: number, player: string, x: number, y: number, kind: Shot['kind']): Shot {
  return { t, p: { x, y, z: 1 }, player, kind, handSpeed: null, twoHanded: false }
}

const bounce = (t: number, x: number, y: number) => ({ t, p: { x, y } })

describe('reading points from shots and bounces', () => {
  it('picks the service box across from the server', () => {
    assert.equal(serviceBox('near', 7, W), 'serve-far-deuce')
    assert.equal(serviceBox('near', 4, W), 'serve-far-ad')
    assert.equal(serviceBox('far', 4, W), 'serve-near-deuce')
    assert.equal(serviceBox('far', 7, W), 'serve-near-ad')
  })

  it('calls outs, faults, aces, double faults, the net, and a ball not returned', () => {
    const shots = [
      // A serves to the deuce box, B drives it back, A volleys it long.
      shot(0, 'A', 7, -0.3, 'serve'), shot(1.5, 'B', 3, 22, 'forehand drive'), shot(2.5, 'A', 4.5, 9, 'backhand volley'),
      // A misses the first serve wide and aces the second.
      shot(20, 'A', 4, -0.3, 'serve'), shot(35, 'A', 4, -0.3, 'serve'),
      // A serves into the net, then long.
      shot(60, 'A', 7, -0.3, 'serve'), shot(75, 'A', 7, -0.3, 'serve'),
      // B returns, A's drive bounces twice past B.
      shot(100, 'A', 4, -0.3, 'serve'), shot(101, 'B', 8, 23, 'backhand drive'), shot(102.2, 'A', 6, 2, 'forehand drive'),
      // B hits the return into the net.
      shot(130, 'A', 7, -0.3, 'serve'), shot(131, 'B', 3, 23, 'forehand drive'),
      // A's last shot is never seen landing.
      shot(160, 'A', 4, -0.3, 'serve'), shot(161, 'B', 8, 23, 'forehand drive'),
    ]
    const bounces = [
      bounce(0.8, 3.5, 16), bounce(2.2, 5, 5), bounce(3.3, 6, 26),
      bounce(20.8, 3, 16),
      bounce(35.8, 7, 15),
      bounce(60.4, 6, 8),
      bounce(75.8, 3, 19.5),
      bounce(100.8, 7, 16), bounce(101.8, 4, 6), bounce(103, 5, 18), bounce(103.6, 5, 22),
      bounce(130.8, 3, 15), bounce(131.5, 4, 20),
      bounce(160.8, 7, 15),
    ]
    const { points, unscored, faults } = readPoints(shots, bounces, court)
    assert.deepEqual(faults.map(faultText), [
      'Fault: Player A\'s serve out of the ad box',
      'Fault: Player A\'s serve into the net',
      'Fault: Player A\'s serve out of the deuce box',
    ])
    assert.deepEqual(points.map((point) => `${point.winner} ${pointText(point)}`), [
      "far Player A's backhand volley out",
      'near Player A ace on the second serve',
      'far Player A double fault',
      "near Player A's forehand drive not returned",
      "near Player B's forehand drive into the net",
    ])
    assert.equal(points[0]!.server, 'near')
    assert.deepEqual(points[0]!.players, [{ id: 'A', side: 'near' }, { id: 'B', side: 'far' }])
    assert.equal(unscored.length, 1)
    assert.match(unscored[0]!.why, /Player B's forehand drive/)
  })
})

function point(winner: Side, players: { id: string; side: Side }[] = [], server: Side | null = null): PointResult {
  return { from: 0, to: 0, winner, end: 'winner', shot: shot(0, 'A', 5, 1, 'forehand drive'), server, faults: 0, players }
}

describe('keeping the score', () => {
  it('counts points to games, changes ends after odd games, and passes the serve', () => {
    const score = keepScore([point('near', [{ id: 'A', side: 'near' }, { id: 'B', side: 'far' }], 'near'), point('near'), point('far'), point('near'), point('near')])
    assert.deepEqual(score.after, ['15–0', '30–0', '30–15', '40–15', 'Game'])
    assert.deepEqual(score.games, [1, 0])
    assert.equal(score.nearTeam, 1, 'the teams changed ends after the first game')
    assert.equal(score.server, 1)
    assert.equal(scoreLine(score), 'games 1–0 · 0–0 · Player B serving')
  })

  it('plays deuce and advantage', () => {
    const score = keepScore(['near', 'near', 'near', 'far', 'far', 'far', 'near', 'far', 'far'].map((side) => point(side as Side)))
    assert.deepEqual(score.after.slice(5), ['Deuce', 'Advantage server', 'Deuce', 'Advantage receiver'])
  })

  it('goes to a tiebreak at 6–6 and wins the set and the match', () => {
    // Team 0 wins every point it serves, so the games go with the serve to 6–6. The near team changes
    // with the ends, so points are given by team, not by end.
    const results: PointResult[] = []
    let near = 0
    let server = 0
    let games = 0
    const win = (team: number) => results.push(point(team === near ? 'near' : 'far'))
    for (let game = 0; game < 12; game += 1) {
      for (let k = 0; k < 4; k += 1) win(server)
      games += 1
      server = 1 - server
      if (games % 2 === 1) near = 1 - near
    }
    const before = keepScore(results)
    assert.deepEqual(before.games, [6, 6])
    assert.equal(before.tiebreak, true)
    for (let k = 0; k < 7; k += 1) {
      win(0)
      if ((k + 1) % 6 === 0) near = 1 - near
    }
    const set = keepScore(results)
    assert.deepEqual(set.sets, [[7, 6]])
    assert.deepEqual(set.games, [0, 0])
  })

  it('trusts a lettered player over the change-of-ends rule', () => {
    const results = [point('near', [{ id: 'A', side: 'near' }, { id: 'B', side: 'far' }])]
    // A game was missed: A is still at the near end after what the rule would have swapped.
    for (let k = 0; k < 4; k += 1) results.push(point('far'))
    results.push(point('near', [{ id: 'A', side: 'near' }]))
    const score = keepScore(results)
    assert.equal(score.nearTeam, 0)
    assert.deepEqual(score.points, [1, 0], 'the point went to A, who is at the near end')
  })

  it('names the teams by their letters', () => {
    const score = keepScore([point('near', [{ id: 'A', side: 'near' }, { id: 'C', side: 'near' }, { id: 'B', side: 'far' }, { id: 'D', side: 'far' }])])
    assert.deepEqual(score.letters, [['A', 'C'], ['B', 'D']])
  })
})
