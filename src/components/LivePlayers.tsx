import { useEffect, useRef, useState } from 'react'
import type { CourtCalibration } from '../../shared/contracts.ts'
import { courtPixelSize, mapPixel } from '../vision/court'
import { drawCourtLines } from '../vision/courtMap'
import { liveState, playersNow, type LiveRoster, type LiveState } from '../vision/livePlayers'
import { shotText, type Shot } from '../vision/match'
import { courtFits, feetOnCourt, onCourt, personColor, personName } from '../vision/players'
import { keepScore, pointText, readPoints, scoreLine, type Bounce } from '../vision/score'
import { speed, useUnits, xyz } from '../units'

const MAP_PAD = 48
const TRAIL_SECONDS = 3
const SHOW_SHOTS = 8

function seconds() {
  return performance.now() / 1000
}

function quietFor(value: number) {
  const whole = Math.round(value)
  return whole >= 60 ? `${Math.floor(whole / 60)} min ${whole % 60} s` : `${whole} s`
}

function stateText(state: LiveState, now: number) {
  if (state.kind === 'rally') return `Rally on · ${state.shots} ${state.shots === 1 ? 'shot' : 'shots'}`
  const quiet = quietFor(now - state.since)
  const resting = state.resting ? ', players resting' : ''
  if (state.kind === 'break') return `Break · ${quiet}${resting}`
  if (state.kind === 'gap') return `Between points · ${quiet}${resting}`
  return `Rally over · ball quiet for ${quiet}`
}

const ZONE_NAMES = { baseline: 'at the baseline', mid: 'mid-court', net: 'at the net' } as const

// Where every player stands now on the top-down court, with their last few seconds.
function LiveMap({ roster, court, now }: { roster: LiveRoster; court: CourtCalibration; now: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = courtPixelSize(court.preset)
    canvas.width = size.width + MAP_PAD * 2
    canvas.height = size.height + MAP_PAD * 2
    const context = canvas.getContext('2d')
    if (!context) return
    context.fillStyle = '#161310'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.translate(MAP_PAD, MAP_PAD)
    drawCourtLines(context, court)
    const clamp = (at: { x: number; y: number }) => ({
      x: Math.min(size.width + MAP_PAD - 10, Math.max(10 - MAP_PAD, at.x)),
      y: Math.min(size.height + MAP_PAD - 10, Math.max(10 - MAP_PAD, at.y)),
    })
    const trails = new Map<string, { x: number; y: number }[]>()
    for (const frame of roster.frames) {
      if (now - frame.t > TRAIL_SECONDS) continue
      for (const person of frame.people) {
        const key = person.id ?? person.player
        const feet = key && onCourt(person, court) ? feetOnCourt(person, court, roster.width, roster.height) : null
        if (!key || !feet) continue
        trails.set(key, [...(trails.get(key) ?? []), clamp(mapPixel(court.preset, feet))])
      }
    }
    context.lineWidth = 2
    context.globalAlpha = 0.6
    for (const [key, trail] of trails) {
      context.strokeStyle = personColor(/^[A-H]$/.test(key) ? { id: key } : { player: key })
      context.beginPath()
      trail.forEach((at, index) => (index === 0 ? context.moveTo(at.x, at.y) : context.lineTo(at.x, at.y)))
      context.stroke()
    }
    context.globalAlpha = 1
    context.font = '700 11px "Avenir Next", "Segoe UI", sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const player of playersNow(roster, court, now)) {
      if (!player.feet) continue
      const at = clamp(mapPixel(court.preset, player.feet))
      context.fillStyle = personColor(player.person)
      context.beginPath()
      context.arc(at.x, at.y, 9, 0, Math.PI * 2)
      context.fill()
      context.fillStyle = '#161310'
      context.fillText(player.person.id ?? player.key[0]!.toUpperCase(), at.x, at.y + 0.5)
    }
  }, [roster, court, now])

  return <canvas ref={canvasRef} className="court-flat live-map" aria-label="Where the players stand on the court now" />
}

export function LivePlayers({
  roster,
  shots,
  bounces,
  court,
  aiOn,
  peopleOn,
  ballOn,
}: {
  roster: LiveRoster
  shots: Shot[]
  // Bounces confirmed on the court, for the score.
  bounces: Bounce[]
  court: CourtCalibration | null
  aiOn: boolean
  peopleOn: boolean
  ballOn: boolean
}) {
  const units = useUnits()
  const [now, setNow] = useState(seconds)
  const running = aiOn && peopleOn

  useEffect(() => {
    if (!running && !ballOn) return
    const timer = window.setInterval(() => setNow(seconds()), 400)
    return () => window.clearInterval(timer)
  }, [running, ballOn])

  const players = running ? playersNow(roster, court, now) : []
  const profiles = new Map(roster.profiles().map((profile) => [profile.id, profile]))
  const placed = court && roster.width > 1 && courtFits(court, roster.width, roster.height) ? court : null
  const state = liveState(shots, now, roster, placed)
  const recent = shots.slice(-SHOW_SHOTS).reverse()
  const scoring = court?.preset === 'tennis-doubles' ? court : null
  // The rally still being played is scored once it is over.
  const playingSince = state?.kind === 'rally' ? state.since : null
  const over = playingSince == null ? shots : shots.filter((shot) => shot.t < playingSince)
  const points = scoring && over.length > 0 ? readPoints(over, bounces, scoring).points : []
  const scored = points.length > 0 ? { points, score: keepScore(points) } : null
  const lastPoint = scored?.points.at(-1)

  return (
    <article className="card" aria-label="Live players">
      <header className="card-head">
        <h3>Live players</h3>
        {state ? <span className="pill">{stateText(state, now)}</span> : null}
      </header>
      <p className="muted">
        Each player gets a letter (A, B, C, D) from the colors of their shirt and shorts, the same letters as in the
        session&apos;s videos. With live ball on, every hit is read from the ball&apos;s flight and the hitter&apos;s pose:
        serve, forehand or backhand drive or volley, and smash.
      </p>
      {!aiOn ? (
        <p className="note">Turn AI on below and pick YOLOv8n-pose as the pose model to see the players.</p>
      ) : !peopleOn ? (
        <p className="note">In the AI card below, set Pose model to &ldquo;YOLOv8n-pose: every person, players named&rdquo;.</p>
      ) : null}
      {running && !placed ? (
        <p className="muted">Mark the court for this phone on Results to place the players and read their shots.</p>
      ) : null}
      {running && placed && !ballOn ? <p className="muted">Start live ball as well to read each shot.</p> : null}
      {running ? (
        <ul className="label-list" aria-label="Players now">
          {players.map((player) => {
            const profile = player.person.id ? profiles.get(player.person.id) : undefined
            return (
              <li key={player.key} className="player-line">
                {profile ? (
                  <span className="player-swatch" title="Shirt and shorts">
                    <span style={{ background: `rgb(${profile.torso.join(', ')})` }} />
                    <span style={{ background: `rgb(${profile.legs.join(', ')})` }} />
                  </span>
                ) : (
                  <span className="player-swatch" style={{ background: personColor(player.person) }} />
                )}
                <span>
                  {personName(player.person)}
                  {player.zone ? ` · ${ZONE_NAMES[player.zone]}` : ''}
                  {player.feet ? ` · ${xyz(player.feet, units)}` : ''}
                  {player.person.racket ? ` · racquet in ${player.person.racket.hand} hand` : ''}
                </span>
              </li>
            )
          })}
          {players.length === 0 ? <li>No player in view.</li> : null}
        </ul>
      ) : null}
      {running && placed ? <LiveMap roster={roster} court={placed} now={now} /> : null}
      {scored ? (
        <div className="note" role="status" aria-label="Live score">
          <strong>Score:</strong> {scoreLine(scored.score)}
          {lastPoint ? <div className="muted">Last point: {pointText(lastPoint)}</div> : null}
        </div>
      ) : null}
      {shots.length > 0 ? (
        <>
          <div className="line-call-box" role="status">
            <strong>{shotText(shots.at(-1)!)}</strong>
            <span className="muted">{Math.max(0, now - shots.at(-1)!.t).toFixed(1)} s ago</span>
          </div>
          <ul className="label-list" aria-label="Recent shots">
            {recent.map((shot) => (
              <li key={shot.t}>
                {shotText(shot)} · {Math.max(0, now - shot.t).toFixed(1)} s ago
                {shot.handSpeed != null ? ` · hand ${speed(shot.handSpeed, units)}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : ballOn && placed ? (
        <p className="muted">No shot yet.</p>
      ) : null}
      <p className="muted">
        Live, the players are read about three times a second, fewer than on a recorded video. A video recorded now keeps
        these players; Track players on Results reads it again at 10 or 30 frames per second.
      </p>
    </article>
  )
}
