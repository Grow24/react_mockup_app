import { COURT_PRESETS, type CourtCalibration } from '../../shared/contracts.ts'
import { lineCall } from './flight.ts'
import { GAP_SECONDS, hitterName, RALLY_GAP, type Shot } from './match.ts'

export type Side = 'near' | 'far'
export type Team = 0 | 1
export type Bounce = { t: number; p: { x: number; y: number } }

// How the point was decided, from the side of the shot that decided it.
export type PointEnd = 'ace' | 'winner' | 'out' | 'net' | 'double fault'

export type PointResult = {
  from: number
  to: number
  winner: Side
  end: PointEnd
  // The shot that won or lost the point.
  shot: Shot
  // The side that served, when the serve was seen.
  server: Side | null
  // Missed serves before this point was played.
  faults: number
  // The lettered players seen in the point and the side of the net they hit from.
  players: { id: string; side: Side }[]
}

export type Unscored = { from: number; to: number; why: string }
export type Fault = { t: number; shot: Shot; box: string; intoNet: boolean }

// After a player's last shot, the ball has this long to land before the point is left unscored.
const LAND_SECONDS = 4
// A ball struck within this of a baseline, after a quiet spell, starts a point.
const SERVE_DEPTH = 2
const SECOND_SERVE_SECONDS = 1

function sideOf(y: number, lengthMeters: number): Side {
  return y < lengthMeters / 2 ? 'near' : 'far'
}

const other = (side: Side): Side => (side === 'near' ? 'far' : 'near')

// The service box diagonally across from where the server struck the ball. Facing the net, the near
// end's right is +x and the far end's right is -x; the deuce court is on the server's right.
export function serviceBox(server: Side, x: number, widthMeters: number) {
  const right = server === 'near' ? x > widthMeters / 2 : x < widthMeters / 2
  return `serve-${other(server)}-${right ? 'deuce' : 'ad'}`
}

// The bounces strictly between from and to, out of a list sorted by time.
function between(ordered: Bounce[], from: number, to: number) {
  let low = 0
  let high = ordered.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (ordered[middle]!.t <= from) low = middle + 1
    else high = middle
  }
  const found: Bounce[] = []
  for (let index = low; index < ordered.length && ordered[index]!.t < to; index += 1) found.push(ordered[index]!)
  return found
}

function rallies(shots: Shot[]) {
  const groups: Shot[][] = []
  for (const shot of shots) {
    const last = groups.at(-1)
    if (last && shot.t - last.at(-1)!.t <= RALLY_GAP) last.push(shot)
    else groups.push([shot])
  }
  return groups
}

// Who won each point: each shot is followed to its first bounce. Into the net or out loses the
// point, a second bounce before the reply wins it, and a missed serve is a fault.
export function readPoints(shots: Shot[], bounces: Bounce[], court: CourtCalibration) {
  const { widthMeters, lengthMeters } = COURT_PRESETS[court.preset]
  const playArea = court.callArea === 'singles' ? 'singles' : 'doubles'
  const ordered = bounces.slice().sort((a, b) => a.t - b.t)
  const groups = rallies(shots.slice().sort((a, b) => a.t - b.t))
  const points: PointResult[] = []
  const unscored: Unscored[] = []
  const allFaults: Fault[] = []
  let pending: { side: Side } | null = null

  groups.forEach((group, index) => {
    const before = groups[index - 1]?.at(-1)?.t ?? Number.NEGATIVE_INFINITY
    const nextRally = groups[index + 1]?.[0]?.t ?? Number.POSITIVE_INFINITY
    const first = group[0]!
    const fromBaseline = Math.min(Math.abs(first.p.y), Math.abs(first.p.y - lengthMeters)) <= SERVE_DEPTH
    let serveAt = first.kind === 'serve' || (first.t - before >= GAP_SECONDS && fromBaseline) ? 0 : -1
    let server: Side | null = serveAt === 0 ? sideOf(first.p.y, lengthMeters) : null
    if (pending && server !== pending.side) pending = null
    let faults = pending ? 1 : 0
    const players = new Map<string, Side>()
    let settled = false

    for (let i = 0; i < group.length && !settled; i += 1) {
      const shot = group[i]!
      const side = sideOf(shot.p.y, lengthMeters)
      if (shot.player && /^[A-H]$/.test(shot.player)) players.set(shot.player, side)
      const next = group[i + 1]
      const until = next ? next.t : Math.min(nextRally, shot.t + LAND_SECONDS)
      const landed = between(ordered, shot.t + 0.02, until)
      const serving = i === serveAt
      const finish = (winner: Side, end: PointEnd) => {
        points.push({
          from: group[0]!.t,
          to: landed[0]?.t ?? shot.t,
          winner,
          end,
          shot,
          server,
          faults,
          players: [...players].map(([id, playerSide]) => ({ id, side: playerSide })),
        })
        pending = null
        settled = true
      }
      const bounce = landed[0]
      if (!bounce) {
        // Struck again before landing: a volley.
        if (next) continue
        unscored.push({ from: group[0]!.t, to: shot.t, why: `the ball was lost after ${hitterName(shot.player)}'s ${shot.kind}` })
        settled = true
        break
      }
      const intoNet = sideOf(bounce.p.y, lengthMeters) === side
      const area = serving ? serviceBox(side, shot.p.x, widthMeters) : playArea
      const missed = intoNet || lineCall(court.preset, bounce.p, area) === 'out'
      if (missed && serving) {
        faults += 1
        allFaults.push({ t: shot.t, shot, box: area, intoNet })
        if (faults >= 2) {
          finish(other(side), 'double fault')
          break
        }
        // The second serve may follow quickly enough to sit in the same rally.
        const again = group.findIndex((later, k) => k > i && later.t - shot.t >= SECOND_SERVE_SECONDS && sideOf(later.p.y, lengthMeters) === side)
        if (again < 0) {
          pending = { side }
          settled = true
          break
        }
        serveAt = again
        i = again - 1
        continue
      }
      if (missed) {
        finish(other(side), intoNet ? 'net' : 'out')
        break
      }
      // Bounces are only looked for until the next shot, so two of them means it bounced twice first.
      if (next && landed.length < 2) continue
      finish(side, serving ? 'ace' : 'winner')
    }
  })
  return { points, unscored, faults: allFaults }
}

export function faultText(fault: Fault) {
  const box = fault.box.endsWith('deuce') ? 'deuce box' : 'ad box'
  return `Fault: ${hitterName(fault.shot.player)}'s serve ${fault.intoNet ? 'into the net' : `out of the ${box}`}`
}

export type Score = {
  // Games per finished set, team 0 first.
  sets: [number, number][]
  games: [number, number]
  points: [number, number]
  tiebreak: boolean
  // Who serves the next point, and which team is at the near end.
  server: Team
  nearTeam: Team
  winner: Team | null
  // The letters seen on each team.
  letters: [string[], string[]]
  // The score after each point, as read out, and the team that won it.
  after: string[]
  won: Team[]
}

const CALLS = ['0', '15', '30', '40']

export function pointCall(points: [number, number], tiebreak: boolean, server: Team) {
  if (tiebreak) return `${points[server]}–${points[1 - server]}`
  const [a, b] = server === 0 ? points : [points[1], points[0]]
  if (a >= 3 && b >= 3) return a === b ? 'Deuce' : a > b ? 'Advantage server' : 'Advantage receiver'
  return `${CALLS[Math.min(3, a)]}–${CALLS[Math.min(3, b)]}`
}

// Tennis scoring over the points: games to 4 by two, sets to 6 by two with a tiebreak at 6–6, best of
// three sets. Team 0 is the one at the near end for the first point. Ends change after every odd
// game and every six tiebreak points; the serve passes each game and every two tiebreak points.
// Whenever a lettered player or a seen serve shows otherwise, the ends or the server are corrected.
export function keepScore(results: PointResult[], bestOf = 3): Score {
  const score: Score = { sets: [], games: [0, 0], points: [0, 0], tiebreak: false, server: 0, nearTeam: 0, winner: null, letters: [[], []], after: [], won: [] }
  const teamOf = new Map<string, Team>()
  let gameServer: Team | null = null
  let tiebreakFirst: Team = 0
  const teamAt = (side: Side): Team => (side === 'near' ? score.nearTeam : ((1 - score.nearTeam) as Team))
  const totalGames = () => score.sets.reduce((sum, [a, b]) => sum + a + b, 0) + score.games[0] + score.games[1]

  for (const result of results) {
    if (score.winner != null) break
    // Letters already on a team tell which end that team is at now; new letters join the team at their end.
    for (const { id, side } of result.players) {
      const team = teamOf.get(id)
      if (team != null && teamAt(side) !== team) score.nearTeam = side === 'near' ? team : ((1 - team) as Team)
    }
    for (const { id, side } of result.players) {
      if (!teamOf.has(id)) {
        teamOf.set(id, teamAt(side))
        score.letters[teamAt(side)].push(id)
      }
    }
    if (result.server) {
      const seen = teamAt(result.server)
      if (gameServer == null) gameServer = seen
      if (!score.tiebreak) gameServer = seen
      score.server = seen
    } else if (gameServer == null) {
      gameServer = 0
      score.server = 0
    }

    const won = teamAt(result.winner)
    score.won.push(won)
    score.points[won] += 1
    const [a, b] = score.points
    const lead = Math.abs(a - b)
    const target = score.tiebreak ? 7 : 4
    const gameOver = Math.max(a, b) >= target && lead >= 2
    if (!gameOver) {
      if (score.tiebreak) {
        const played = a + b
        if (played % 6 === 0) score.nearTeam = (1 - score.nearTeam) as Team
        // The first tiebreak point is served by one team, then two each in turn.
        score.server = (Math.floor((played + 1) / 2) % 2 === 0 ? tiebreakFirst : 1 - tiebreakFirst) as Team
      }
      score.after.push(pointCall(score.points, score.tiebreak, score.server))
      continue
    }
    score.games[won] += 1
    score.points = [0, 0]
    gameServer = (1 - (gameServer ?? 0)) as Team
    const [ga, gb] = score.games
    const setOver = score.tiebreak || (Math.max(ga, gb) >= 6 && Math.abs(ga - gb) >= 2)
    score.tiebreak = false
    if (setOver) {
      score.sets.push([ga, gb])
      score.games = [0, 0]
      const setsWon = score.sets.filter(([x, y]) => (won === 0 ? x > y : y > x)).length
      if (setsWon > bestOf / 2) score.winner = won
    } else if (ga === 6 && gb === 6) {
      score.tiebreak = true
      tiebreakFirst = gameServer
    }
    if (totalGames() % 2 === 1) score.nearTeam = (1 - score.nearTeam) as Team
    score.server = gameServer
    score.after.push(score.winner != null ? 'Match' : setOver ? 'Set' : 'Game')
  }
  return score
}

export function teamName(score: Score, team: Team) {
  const letters = score.letters[team]
  if (letters.length > 0) return letters.map((id) => `Player ${id}`).join(' & ')
  return team === 0 ? 'Near team' : 'Far team'
}

// "Sets 1–0 · games 3–2 · 30–15", with the server's points first.
export function scoreLine(score: Score) {
  const sets = score.sets.length > 0 ? `Sets ${score.sets.map(([a, b]) => `${a}–${b}`).join(', ')} · ` : ''
  const games = `games ${score.games[0]}–${score.games[1]}`
  if (score.winner != null) return `${sets}${teamName(score, score.winner)} won the match`
  const call = pointCall(score.points, score.tiebreak, score.server)
  return `${sets}${games}${score.tiebreak ? ' · tiebreak' : ''} · ${call} · ${teamName(score, score.server)} serving`
}

export function pointText(result: PointResult) {
  const by = hitterName(result.shot.player)
  const kind = result.shot.kind
  const faults = result.faults === 1 && result.end !== 'double fault' ? ' on the second serve' : ''
  switch (result.end) {
    case 'ace':
      return `${by} ace${faults}`
    case 'winner':
      return `${by}'s ${kind} not returned${faults}`
    case 'out':
      return `${by}'s ${kind} out${faults}`
    case 'net':
      return `${by}'s ${kind} into the net${faults}`
    case 'double fault':
      return `${by} double fault`
  }
}
