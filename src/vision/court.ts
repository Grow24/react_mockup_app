import { COURT_PRESETS, type CourtPoint, type CourtPreset } from '../../shared/contracts.ts'

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

// Court meters to the top-down map, where the far line is at the top.
export function mapPixel(preset: CourtPreset, meters: CourtPoint, longSide = 420): CourtPoint {
  const size = courtPixelSize(preset, longSide)
  return { x: meters.x * size.scale, y: size.height - meters.y * size.scale }
}

export function courtMeters(preset: CourtPreset, pixel: CourtPoint, longSide = 420) {
  const size = courtPixelSize(preset, longSide)
  return {
    fromLeft: pixel.x / size.scale,
    fromNear: (size.height - pixel.y) / size.scale,
  }
}
