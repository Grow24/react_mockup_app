import { COURT_PRESETS, type CourtCalibration, type CourtPoint, type CourtPreset } from './contracts.ts'

// World meters: x from the left doubles (or pitch) line, y from the near line, as seen from the near end.
export type CourtLandmark = { id: string; label: string; x: number; y: number }
export type CourtArea = { id: string; label: string; x0: number; y0: number; x1: number; y1: number }
export type CourtLine = { from: CourtPoint; to: CourtPoint; dashed?: boolean }
// Three-point sets assume the phone is held level and estimate a fourth point from that.
export type LandmarkSet = { id: string; label: string; landmarks: string[] }

const TENNIS = COURT_PRESETS['tennis-doubles']
const SINGLES_INSET = 1.37
const SINGLES_LEFT = SINGLES_INSET
const SINGLES_RIGHT = TENNIS.widthMeters - SINGLES_INSET
const CENTER_X = TENNIS.widthMeters / 2
const NET_Y = TENNIS.lengthMeters / 2
const SERVICE_NEAR = NET_Y - 6.4
const SERVICE_FAR = NET_Y + 6.4
const CENTER_MARK = 0.1

const PITCH = COURT_PRESETS['cricket-pitch']
const STUMPS_X = PITCH.widthMeters / 2
const RETURN_LEFT = STUMPS_X - 1.32
const RETURN_RIGHT = STUMPS_X + 1.32
const POPPING_NEAR = 1.22
const POPPING_FAR = PITCH.lengthMeters - 1.22
const POPPING_HALF = 1.83

function landmark(id: string, label: string, x: number, y: number): CourtLandmark {
  return { id, label, x, y }
}

// The first four of each list are the outer corners in the original click order, so older calibrations still read.
export const COURT_LANDMARKS: Record<CourtPreset, CourtLandmark[]> = {
  'tennis-doubles': [
    landmark('doubles-near-left', 'Doubles corner, near left', 0, 0),
    landmark('doubles-near-right', 'Doubles corner, near right', TENNIS.widthMeters, 0),
    landmark('doubles-far-right', 'Doubles corner, far right', TENNIS.widthMeters, TENNIS.lengthMeters),
    landmark('doubles-far-left', 'Doubles corner, far left', 0, TENNIS.lengthMeters),
    landmark('singles-near-left', 'Singles corner, near left', SINGLES_LEFT, 0),
    landmark('singles-near-right', 'Singles corner, near right', SINGLES_RIGHT, 0),
    landmark('singles-far-right', 'Singles corner, far right', SINGLES_RIGHT, TENNIS.lengthMeters),
    landmark('singles-far-left', 'Singles corner, far left', SINGLES_LEFT, TENNIS.lengthMeters),
    landmark('service-near-left', 'Near service line, left end', SINGLES_LEFT, SERVICE_NEAR),
    landmark('service-near-right', 'Near service line, right end', SINGLES_RIGHT, SERVICE_NEAR),
    landmark('service-far-right', 'Far service line, right end', SINGLES_RIGHT, SERVICE_FAR),
    landmark('service-far-left', 'Far service line, left end', SINGLES_LEFT, SERVICE_FAR),
    landmark('tee-near', 'Near T (service line meets center line)', CENTER_X, SERVICE_NEAR),
    landmark('tee-far', 'Far T (service line meets center line)', CENTER_X, SERVICE_FAR),
    landmark('center-mark-near', 'Near baseline center mark', CENTER_X, 0),
    landmark('center-mark-far', 'Far baseline center mark', CENTER_X, TENNIS.lengthMeters),
  ],
  'cricket-pitch': [
    landmark('pitch-near-left', 'Pitch corner, near left', 0, 0),
    landmark('pitch-near-right', 'Pitch corner, near right', PITCH.widthMeters, 0),
    landmark('pitch-far-right', 'Pitch corner, far right', PITCH.widthMeters, PITCH.lengthMeters),
    landmark('pitch-far-left', 'Pitch corner, far left', 0, PITCH.lengthMeters),
    landmark('stumps-near', 'Near middle stump', STUMPS_X, 0),
    landmark('stumps-far', 'Far middle stump', STUMPS_X, PITCH.lengthMeters),
    landmark('bowling-near-left', 'Near bowling crease meets left return crease', RETURN_LEFT, 0),
    landmark('bowling-near-right', 'Near bowling crease meets right return crease', RETURN_RIGHT, 0),
    landmark('bowling-far-right', 'Far bowling crease meets right return crease', RETURN_RIGHT, PITCH.lengthMeters),
    landmark('bowling-far-left', 'Far bowling crease meets left return crease', RETURN_LEFT, PITCH.lengthMeters),
    landmark('popping-near-left', 'Near popping crease meets left return crease', RETURN_LEFT, POPPING_NEAR),
    landmark('popping-near-right', 'Near popping crease meets right return crease', RETURN_RIGHT, POPPING_NEAR),
    landmark('popping-far-right', 'Far popping crease meets right return crease', RETURN_RIGHT, POPPING_FAR),
    landmark('popping-far-left', 'Far popping crease meets left return crease', RETURN_LEFT, POPPING_FAR),
  ],
}

export const LANDMARK_SETS: Record<CourtPreset, LandmarkSet[]> = {
  'tennis-doubles': [
    { id: 'doubles', label: 'Doubles corners', landmarks: ['doubles-near-left', 'doubles-near-right', 'doubles-far-right', 'doubles-far-left'] },
    { id: 'singles', label: 'Singles corners', landmarks: ['singles-near-left', 'singles-near-right', 'singles-far-right', 'singles-far-left'] },
    { id: 'service', label: 'Service line ends (both halves)', landmarks: ['service-near-left', 'service-near-right', 'service-far-right', 'service-far-left'] },
    { id: 'near-half', label: 'Near half: baseline and service line', landmarks: ['singles-near-left', 'singles-near-right', 'service-near-right', 'service-near-left'] },
    { id: 'far-half', label: 'Far half: service line and baseline', landmarks: ['service-far-left', 'service-far-right', 'singles-far-right', 'singles-far-left'] },
    { id: 'three-far-right', label: '3 corners, phone level: near left, near right, far right', landmarks: ['doubles-near-left', 'doubles-near-right', 'doubles-far-right'] },
    { id: 'three-far-left', label: '3 corners, phone level: near left, near right, far left', landmarks: ['doubles-near-left', 'doubles-near-right', 'doubles-far-left'] },
    { id: 'three-left-side', label: '3 corners, phone level: near left, far left, far right', landmarks: ['doubles-near-left', 'doubles-far-left', 'doubles-far-right'] },
    { id: 'three-right-side', label: '3 corners, phone level: near right, far right, far left', landmarks: ['doubles-near-right', 'doubles-far-right', 'doubles-far-left'] },
  ],
  'cricket-pitch': [
    { id: 'pitch', label: 'Pitch corners', landmarks: ['pitch-near-left', 'pitch-near-right', 'pitch-far-right', 'pitch-far-left'] },
    { id: 'bowling', label: 'Bowling and return creases', landmarks: ['bowling-near-left', 'bowling-near-right', 'bowling-far-right', 'bowling-far-left'] },
    { id: 'popping', label: 'Popping and return creases', landmarks: ['popping-near-left', 'popping-near-right', 'popping-far-right', 'popping-far-left'] },
    { id: 'three-far-right', label: '3 corners, phone level: near left, near right, far right', landmarks: ['pitch-near-left', 'pitch-near-right', 'pitch-far-right'] },
    { id: 'three-far-left', label: '3 corners, phone level: near left, near right, far left', landmarks: ['pitch-near-left', 'pitch-near-right', 'pitch-far-left'] },
  ],
}

// A serve from the far end lands in a near box; the deuce box is on the receiver's right.
export const COURT_AREAS: Record<CourtPreset, CourtArea[]> = {
  'tennis-doubles': [
    { id: 'doubles', label: 'Doubles court', x0: 0, y0: 0, x1: TENNIS.widthMeters, y1: TENNIS.lengthMeters },
    { id: 'singles', label: 'Singles court', x0: SINGLES_LEFT, y0: 0, x1: SINGLES_RIGHT, y1: TENNIS.lengthMeters },
    { id: 'serve-near-deuce', label: 'Serve into the near deuce box', x0: CENTER_X, y0: SERVICE_NEAR, x1: SINGLES_RIGHT, y1: NET_Y },
    { id: 'serve-near-ad', label: 'Serve into the near ad box', x0: SINGLES_LEFT, y0: SERVICE_NEAR, x1: CENTER_X, y1: NET_Y },
    { id: 'serve-far-deuce', label: 'Serve into the far deuce box', x0: SINGLES_LEFT, y0: NET_Y, x1: CENTER_X, y1: SERVICE_FAR },
    { id: 'serve-far-ad', label: 'Serve into the far ad box', x0: CENTER_X, y0: NET_Y, x1: SINGLES_RIGHT, y1: SERVICE_FAR },
  ],
  'cricket-pitch': [{ id: 'pitch', label: 'Pitch', x0: 0, y0: 0, x1: PITCH.widthMeters, y1: PITCH.lengthMeters }],
}

function segment(x0: number, y0: number, x1: number, y1: number, dashed = false): CourtLine {
  return dashed ? { from: { x: x0, y: y0 }, to: { x: x1, y: y1 }, dashed } : { from: { x: x0, y: y0 }, to: { x: x1, y: y1 } }
}

export function courtLines(preset: CourtPreset): CourtLine[] {
  if (preset === 'tennis-doubles') {
    const { widthMeters: w, lengthMeters: l } = TENNIS
    return [
      segment(0, 0, w, 0),
      segment(0, l, w, l),
      segment(0, 0, 0, l),
      segment(w, 0, w, l),
      segment(SINGLES_LEFT, 0, SINGLES_LEFT, l),
      segment(SINGLES_RIGHT, 0, SINGLES_RIGHT, l),
      segment(SINGLES_LEFT, SERVICE_NEAR, SINGLES_RIGHT, SERVICE_NEAR),
      segment(SINGLES_LEFT, SERVICE_FAR, SINGLES_RIGHT, SERVICE_FAR),
      segment(CENTER_X, SERVICE_NEAR, CENTER_X, SERVICE_FAR),
      segment(CENTER_X, 0, CENTER_X, CENTER_MARK),
      segment(CENTER_X, l, CENTER_X, l - CENTER_MARK),
      segment(-0.914, NET_Y, w + 0.914, NET_Y, true),
    ]
  }
  const { widthMeters: w, lengthMeters: l } = PITCH
  return [
    segment(0, 0, w, 0, true),
    segment(0, l, w, l, true),
    segment(0, 0, 0, l, true),
    segment(w, 0, w, l, true),
    segment(RETURN_LEFT, 0, RETURN_RIGHT, 0),
    segment(RETURN_LEFT, l, RETURN_RIGHT, l),
    segment(STUMPS_X - POPPING_HALF, POPPING_NEAR, STUMPS_X + POPPING_HALF, POPPING_NEAR),
    segment(STUMPS_X - POPPING_HALF, POPPING_FAR, STUMPS_X + POPPING_HALF, POPPING_FAR),
    segment(RETURN_LEFT, POPPING_NEAR, RETURN_LEFT, -1.22),
    segment(RETURN_RIGHT, POPPING_NEAR, RETURN_RIGHT, -1.22),
    segment(RETURN_LEFT, POPPING_FAR, RETURN_LEFT, l + 1.22),
    segment(RETURN_RIGHT, POPPING_FAR, RETURN_RIGHT, l + 1.22),
  ]
}

export function defaultLandmarks(preset: CourtPreset) {
  return LANDMARK_SETS[preset][0]!.landmarks
}

export function landmarkById(preset: CourtPreset, id: string) {
  return COURT_LANDMARKS[preset].find((item) => item.id === id)
}

export function courtArea(preset: CourtPreset, id?: string) {
  const areas = COURT_AREAS[preset]
  return areas.find((area) => area.id === id) ?? areas[0]!
}

const triangleArea = (p: CourtPoint, q: CourtPoint, r: CourtPoint) =>
  Math.abs((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / 2

function smallestTriangle(points: CourtPoint[]) {
  let smallest = Number.POSITIVE_INFINITY
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      for (let k = j + 1; k < points.length; k += 1) smallest = Math.min(smallest, triangleArea(points[i]!, points[j]!, points[k]!))
    }
  }
  return smallest
}

// Four points fix the ground plane only when they are distinct and no three lie on one line.
// Three points do too when the phone is held level.
export function landmarksProblem(preset: CourtPreset, ids: string[], allowThree = false): string | null {
  if (ids.length !== 4 && !(allowThree && ids.length === 3)) return allowThree ? 'Pick three or four court points.' : 'Pick four court points.'
  if (new Set(ids).size !== ids.length) return 'Pick different court points.'
  const points = ids.map((id) => landmarkById(preset, id))
  if (points.some((point) => !point)) return 'One of the court points is not on this court.'
  if (smallestTriangle(points as CourtLandmark[]) < 0.5) return 'Three of these points lie on one line. Pick points that span the court.'
  return null
}

// The court point that, with the three given, spreads widest: usually the missing corner.
export function completingLandmark(preset: CourtPreset, ids: string[]) {
  const chosen = ids.map((id) => landmarkById(preset, id)!)
  let best: CourtLandmark | null = null
  let bestArea = 0
  for (const candidate of COURT_LANDMARKS[preset]) {
    if (ids.includes(candidate.id)) continue
    const area = smallestTriangle([...chosen, candidate])
    if (area > bestArea) {
      best = candidate
      bestArea = area
    }
  }
  return best
}

export function courtWorldPoints(court: Pick<CourtCalibration, 'preset' | 'landmarks'>): CourtPoint[] {
  const ids = court.landmarks && !landmarksProblem(court.preset, court.landmarks) ? court.landmarks : defaultLandmarks(court.preset)
  return ids.map((id) => {
    const point = landmarkById(court.preset, id)!
    return { x: point.x, y: point.y }
  })
}

export function courtLandmarkLabels(court: Pick<CourtCalibration, 'preset' | 'landmarks'>) {
  const ids = court.landmarks && !landmarksProblem(court.preset, court.landmarks) ? court.landmarks : defaultLandmarks(court.preset)
  return ids.map((id) => landmarkById(court.preset, id)!.label)
}
