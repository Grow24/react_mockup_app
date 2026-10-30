import type { BallTrack, CourtCalibration } from '../../shared/contracts.ts'
import { fitFlights } from './flight'

self.onmessage = (event: MessageEvent<{ id: number; track: BallTrack; court: CourtCalibration }>) => {
  const { id, track, court } = event.data
  try {
    self.postMessage({ id, fit: fitFlights(track, court) })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : 'The 3D flight could not be fitted.' })
  }
}
