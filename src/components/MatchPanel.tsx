import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { BallTrack, CourtCalibration, PoseTrack } from '../../shared/contracts.ts'
import { courtFitsTrack } from '../vision/ball'
import type { FlightFit } from '../vision/flight'
import { sharedFlightFit } from '../vision/flightFit'
import { readMatch, type MatchSegment, type Shot } from '../vision/match'
import { ID_COLORS, personName } from '../vision/players'
import { speed, useUnits } from '../units'

function clock(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`
}

function who(player: string | null) {
  if (!player) return 'Someone'
  return /^[A-H]$/.test(player) ? `Player ${player}` : personName({ player })
}

function shotText(shot: Shot) {
  const kind = shot.twoHanded ? shot.kind.replace('backhand', 'two-handed backhand') : shot.kind
  return `${who(shot.player)} ${kind}`
}

function gapText(segment: Extract<MatchSegment, { kind: 'gap' | 'break' }>) {
  const seconds = Math.round(segment.to - segment.from)
  return `${seconds} s ${segment.kind === 'break' ? 'break' : 'between points'}${segment.resting ? ', players resting' : ''}`
}

export function MatchPanel({
  videoRef,
  ballTrack,
  poseTrack,
  court,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  // Both with camera motion already taken out.
  ballTrack: BallTrack | null
  poseTrack: PoseTrack | null
  court: CourtCalibration | null
}) {
  const units = useUnits()
  const usable = ballTrack && court && courtFitsTrack(ballTrack, court) ? court : null
  const [fit, setFit] = useState<{ track: BallTrack; fit: FlightFit | null } | null>(null)

  useEffect(() => {
    if (!ballTrack || !usable) return
    let current = true
    sharedFlightFit(ballTrack, usable)
      .then((next) => {
        if (current) setFit({ track: ballTrack, fit: next })
      })
      .catch((caught) => console.error(caught))
    return () => {
      current = false
    }
  }, [ballTrack, usable])

  const fitted = fit && fit.track === ballTrack ? fit.fit : null
  const duration = Math.max(ballTrack?.duration ?? 0, poseTrack?.duration ?? 0)
  const match = useMemo(() => (fitted && usable ? readMatch(fitted, poseTrack, usable, duration) : null), [fitted, usable, poseTrack, duration])
  const seek = (t: number) => {
    const video = videoRef.current
    if (video) video.currentTime = Math.max(0, t - 0.3)
  }

  if (!ballTrack || !usable) {
    return (
      <section className="still-pose ball-panel" aria-label="Match">
        <h4>Match</h4>
        <p className="muted">Mark the court and track the ball to read the shots, rallies, and rests. Track the players too to know who hit each shot and how.</p>
      </section>
    )
  }

  const counts = new Map<string, Map<string, number>>()
  let fastest = new Map<string, number>()
  for (const shot of match?.shots ?? []) {
    const key = shot.player ?? '?'
    const kinds = counts.get(key) ?? new Map<string, number>()
    kinds.set(shot.kind, (kinds.get(shot.kind) ?? 0) + 1)
    counts.set(key, kinds)
    if (shot.handSpeed != null) fastest = fastest.set(key, Math.max(fastest.get(key) ?? 0, shot.handSpeed))
  }
  const rallies = match?.segments.filter((segment) => segment.kind === 'rally') ?? []

  return (
    <section className="still-pose ball-panel" aria-label="Match">
      <h4>Match</h4>
      <p className="muted">
        Shots are read from the ball&apos;s 3D flight (a hit is where it changes flight without touching the ground) and the
        nearest player&apos;s pose and racquet at that moment. Click a shot or a stretch to jump the video there.
      </p>
      {!match ? <p className="muted">Fitting the ball&apos;s flight.</p> : null}
      {match && duration > 0 ? (
        <div className="match-timeline" role="list" aria-label="Rallies and rests">
          {match.segments.map((segment) => (
            <button
              key={`${segment.kind}-${segment.from}`}
              type="button"
              role="listitem"
              className={`match-span ${segment.kind}`}
              style={{ left: `${(segment.from / duration) * 100}%`, width: `${Math.max(0.5, ((segment.to - segment.from) / duration) * 100)}%` }}
              title={segment.kind === 'rally' ? `Rally, ${segment.shots.length} shots` : gapText(segment)}
              onClick={() => seek(segment.from)}
            />
          ))}
          {match.shots.map((shot) => (
            <button
              key={shot.t}
              type="button"
              className="match-shot"
              style={{ left: `${(shot.t / duration) * 100}%`, background: (shot.player && ID_COLORS[shot.player]) || '#f3d38a' }}
              title={`${clock(shot.t)} ${shotText(shot)}`}
              onClick={() => seek(shot.t)}
            >
              {shot.player && /^[A-H]$/.test(shot.player) ? shot.player : '•'}
            </button>
          ))}
        </div>
      ) : null}
      {match ? (
        <ul className="label-list">
          {match.segments.map((segment) =>
            segment.kind === 'rally' ? (
              <li key={`rally-${segment.from}`}>
                <button type="button" className="text-button" onClick={() => seek(segment.from)}>
                  Rally {rallies.indexOf(segment) + 1}
                </button>{' '}
                · {clock(segment.from)}–{clock(segment.to)} · {segment.shots.length} {segment.shots.length === 1 ? 'shot' : 'shots'}:{' '}
                {segment.shots.map((shot, index) => (
                  <span key={shot.t}>
                    {index > 0 ? ' → ' : ''}
                    <button type="button" className="text-button" onClick={() => seek(shot.t)}>
                      {shotText(shot)}
                    </button>
                  </span>
                ))}
              </li>
            ) : (
              <li key={`${segment.kind}-${segment.from}`}>
                {clock(segment.from)}–{clock(segment.to)} · {gapText(segment)}
              </li>
            ),
          )}
          {match.shots.length === 0 ? <li>No hit was found in the ball&apos;s flight.</li> : null}
        </ul>
      ) : null}
      {match && counts.size > 0 ? (
        <ul className="label-list" aria-label="Shots by player">
          {[...counts.entries()].map(([key, kinds]) => (
            <li key={key}>
              {key === '?' ? 'Not placed' : who(key)}
              {match.hands[key] ? ` (${match.hands[key]}-handed)` : ''}:{' '}
              {[...kinds.entries()].map(([kind, count]) => `${count} ${kind}${count > 1 ? 's' : ''}`).join(', ')}
              {fastest.get(key) ? ` · fastest hand ${speed(fastest.get(key)!, units)}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        Stroke names come from simple rules on the pose: a hand above the head is a serve (after a pause, from the
        baseline) or a smash; the racquet&apos;s side of the body, facing the net, makes a forehand or backhand; no bounce
        since the other player&apos;s hit makes a volley. Small, far players and fast swings between frames are read less
        well; 30 frames per second helps.
      </p>
    </section>
  )
}
