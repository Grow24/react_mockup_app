import { COURT_PRESETS, type CourtPreset } from '../../shared/contracts.ts'
import { positionAt, type Flight, type Vec3 } from './flight'
import type { Prediction } from './physics'

export const PREDICT_SECONDS = 2

export function describeSpot(preset: CourtPreset, p: Vec3) {
  const { widthMeters, lengthMeters } = COURT_PRESETS[preset]
  const outside = p.x < -0.5 || p.y < -0.5 || p.x > widthMeters + 0.5 || p.y > lengthMeters + 0.5
  return `${p.x.toFixed(1)} m from the left line, ${p.y.toFixed(1)} m from the near line${outside ? ' (outside the court)' : ''}`
}

export function predictionText(preset: CourtPreset, prediction: Prediction) {
  const firstBounce = prediction.bounces[0]
  if (prediction.obstacle && (!firstBounce || prediction.obstacle.t <= firstBounce.t)) {
    return `Rapier: the ball hits the ${prediction.obstacle.name} at ${prediction.obstacle.t.toFixed(1)} s.`
  }
  if (!firstBounce) return `Rapier: no bounce in the next ${PREDICT_SECONDS} s.`
  return `Rapier: next bounce at ${firstBounce.t.toFixed(1)} s, ${describeSpot(preset, firstBounce.p)}.`
}

export type PathSample = { t: number; p: Vec3 }

export function flightPaths(flights: Flight[]): PathSample[][] {
  return flights.map((flight) => {
    const samples: PathSample[] = []
    for (let t = flight.from; t < flight.to; t += 1 / 60) samples.push({ t, p: positionAt(flight, t) })
    samples.push({ t: flight.to, p: positionAt(flight, flight.to) })
    return samples
  })
}
