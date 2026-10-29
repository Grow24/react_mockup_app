import { COURT_PRESETS, type CourtPoint, type CourtPreset } from '../../shared/contracts.ts'

export const CORNER_LABELS = ['Near left', 'Near right', 'Far right', 'Far left'] as const

export function courtPixelSize(preset: CourtPreset, longSide = 420) {
  const spec = COURT_PRESETS[preset]
  const scale = longSide / Math.max(spec.widthMeters, spec.lengthMeters)
  return {
    width: Math.max(2, Math.round(spec.widthMeters * scale)),
    height: Math.max(2, Math.round(spec.lengthMeters * scale)),
    scale,
    widthMeters: spec.widthMeters,
    lengthMeters: spec.lengthMeters,
  }
}

export function destinationCorners(preset: CourtPreset, longSide = 420): CourtPoint[] {
  const size = courtPixelSize(preset, longSide)
  return [
    { x: 0, y: size.height },
    { x: size.width, y: size.height },
    { x: size.width, y: 0 },
    { x: 0, y: 0 },
  ]
}

export function courtMeters(preset: CourtPreset, pixel: CourtPoint, longSide = 420) {
  const size = courtPixelSize(preset, longSide)
  return {
    fromLeft: pixel.x / size.scale,
    fromNear: (size.height - pixel.y) / size.scale,
  }
}
