import { COURT_PRESETS, POSE_TRACK_LIMIT, type CourtCalibration, type MotionFrame, type MotionTrack } from '../../shared/contracts.ts'
import { openVideo, seek } from './ballTracker'
import { courtHomography, solveLinear } from './flight'
import { applyHomography, IDENTITY, MIN_INLIERS, type Homography } from './motion'
import { loadOpenCv } from './opencv'

// Matching runs on frames with this long side; the result is scaled back to the court photo's pixels.
const WORK_SIDE = 640
const FEATURES = 1500
const RATIO = 0.75
// Ground around the court where the surface and lines give stable features, in meters past the lines.
const GROUND_MARGIN = 3

type Mat = {
  rows: number
  cols: number
  data: Uint8Array
  data64F: Float64Array
  delete: () => void
}
type KeyPoints = { size: () => number; get: (index: number) => { pt: { x: number; y: number } }; delete: () => void }
type Match = { queryIdx: number; trainIdx: number; distance: number }
type MatchList = { size: () => number; get: (index: number) => Match }
type MatchLists = { size: () => number; get: (index: number) => MatchList; delete: () => void }
type Cv = {
  Mat: { new (): Mat; zeros: (rows: number, cols: number, type: number) => Mat }
  MatVector: new () => { push_back: (mat: Mat) => void; delete: () => void }
  KeyPointVector: new () => KeyPoints
  DMatchVectorVector: new () => MatchLists
  ORB: new (features: number) => { detectAndCompute: (image: Mat, mask: Mat, points: KeyPoints, descriptors: Mat) => void; delete: () => void }
  BFMatcher: new (norm: number, crossCheck: boolean) => { knnMatch: (a: Mat, b: Mat, out: MatchLists, k: number) => void; delete: () => void }
  Scalar: new (value: number) => unknown
  NORM_HAMMING: number
  RANSAC: number
  CV_8UC1: number
  CV_32SC2: number
  CV_32FC2: number
  COLOR_RGBA2GRAY: number
  imread: (source: HTMLCanvasElement) => Mat
  cvtColor: (src: Mat, dst: Mat, code: number) => void
  matFromArray: (rows: number, cols: number, type: number, data: number[]) => Mat
  fillPoly: (image: Mat, points: unknown, color: unknown) => void
  findHomography: (src: Mat, dst: Mat, method: number, threshold: number, mask: Mat) => Mat
}

type Features = { points: KeyPoints; descriptors: Mat }

function grayOf(cv: Cv, canvas: HTMLCanvasElement) {
  const color = cv.imread(canvas)
  const gray = new cv.Mat()
  cv.cvtColor(color, gray, cv.COLOR_RGBA2GRAY)
  color.delete()
  return gray
}

// The ground around the court, in the court photo, as a mask; null when part of it is past the horizon.
function groundMask(cv: Cv, court: CourtCalibration, width: number, height: number, scale: number) {
  const h = courtHomography(court)
  if (!h) return null
  const { widthMeters: w, lengthMeters: l } = COURT_PRESETS[court.preset]
  const corners = [
    [-GROUND_MARGIN, -GROUND_MARGIN],
    [w + GROUND_MARGIN, -GROUND_MARGIN],
    [w + GROUND_MARGIN, l + GROUND_MARGIN],
    [-GROUND_MARGIN, l + GROUND_MARGIN],
  ]
  const facing = (x: number, y: number) => h[6]! * x + h[7]! * y + h[8]!
  const side = Math.sign(facing(w / 2, 0)) || 1
  if (corners.some(([x, y]) => facing(x!, y!) * side <= 0)) return null
  const pixels = corners.flatMap(([x, y]) => {
    const point = applyHomography(h, { x: x!, y: y! })!
    return [Math.round(point.x * scale), Math.round(point.y * scale)]
  })
  const mask = cv.Mat.zeros(height, width, cv.CV_8UC1)
  const polygon = cv.matFromArray(4, 1, cv.CV_32SC2, pixels)
  const list = new cv.MatVector()
  list.push_back(polygon)
  cv.fillPoly(mask, list, new cv.Scalar(255))
  list.delete()
  polygon.delete()
  return mask
}

function detect(cv: Cv, orb: InstanceType<Cv['ORB']>, gray: Mat, mask: Mat | null): Features {
  const points = new cv.KeyPointVector()
  const descriptors = new cv.Mat()
  const empty = mask ?? new cv.Mat()
  orb.detectAndCompute(gray, empty, points, descriptors)
  if (!mask) empty.delete()
  return { points, descriptors }
}

type Pair = { ax: number; ay: number; bx: number; by: number }

// Reference-to-frame point pairs in court-photo pixels: a ratio test, then only pairs that pick
// each other both ways, which drops most look-alike line crossings.
function pairs(cv: Cv, matcher: InstanceType<Cv['BFMatcher']>, reference: Features, frame: Features, scale: number): Pair[] {
  if (reference.descriptors.rows < 8 || frame.descriptors.rows < 8) return []
  const forward = new cv.DMatchVectorVector()
  const backward = new cv.DMatchVectorVector()
  matcher.knnMatch(reference.descriptors, frame.descriptors, forward, 2)
  matcher.knnMatch(frame.descriptors, reference.descriptors, backward, 1)
  const back = new Map<number, number>()
  for (let index = 0; index < backward.size(); index += 1) {
    const list = backward.get(index)
    if (list.size() > 0) back.set(list.get(0).queryIdx, list.get(0).trainIdx)
  }
  const found: Pair[] = []
  for (let index = 0; index < forward.size(); index += 1) {
    const list = forward.get(index)
    if (list.size() < 2) continue
    const best = list.get(0)
    if (best.distance >= RATIO * list.get(1).distance || back.get(best.trainIdx) !== best.queryIdx) continue
    const a = reference.points.get(best.queryIdx).pt
    const b = frame.points.get(best.trainIdx).pt
    found.push({ ax: a.x / scale, ay: a.y / scale, bx: b.x / scale, by: b.y / scale })
  }
  forward.delete()
  backward.delete()
  return found
}

function similarityFrom(p: Pair, q: Pair): Homography | null {
  const ax = q.ax - p.ax
  const ay = q.ay - p.ay
  const bx = q.bx - p.bx
  const by = q.by - p.by
  const size = ax * ax + ay * ay
  if (size < 100) return null
  const c = (ax * bx + ay * by) / size
  const s = (ax * by - ay * bx) / size
  return [c, -s, p.bx - (c * p.ax - s * p.ay), s, c, p.by - (s * p.ax + c * p.ay), 0, 0, 1]
}

function supportOf(h: Homography, list: Pair[], threshold: number) {
  const inliers: Pair[] = []
  for (const pair of list) {
    const at = applyHomography(h, { x: pair.ax, y: pair.ay })
    if (at && Math.hypot(at.x - pair.bx, at.y - pair.by) <= threshold) inliers.push(pair)
  }
  return inliers
}

// Points along one court line match anywhere along it, so a model is trusted only when its
// inliers spread in two directions, not along a single line.
function spreadsOut(inliers: Pair[], width: number, height: number) {
  if (inliers.length < 3) return false
  let mx = 0
  let my = 0
  for (const pair of inliers) {
    mx += pair.ax
    my += pair.ay
  }
  mx /= inliers.length
  my /= inliers.length
  let xx = 0
  let yy = 0
  let xy = 0
  for (const pair of inliers) {
    xx += (pair.ax - mx) ** 2
    yy += (pair.ay - my) ** 2
    xy += (pair.ax - mx) * (pair.ay - my)
  }
  xx /= inliers.length
  yy /= inliers.length
  xy /= inliers.length
  const minor = (xx + yy) / 2 - Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy)
  return Math.sqrt(Math.max(0, minor)) >= 0.05 * Math.min(width, height)
}

// Least-squares homography through the inlier pairs (eight unknowns, h8 = 1).
function homographyFrom(list: Pair[]): Homography | null {
  const normal = Array.from({ length: 8 }, () => new Array<number>(8).fill(0))
  const rhs = new Array<number>(8).fill(0)
  const add = (row: number[], value: number) => {
    for (let i = 0; i < 8; i += 1) {
      rhs[i]! += row[i]! * value
      for (let j = 0; j < 8; j += 1) normal[i]![j]! += row[i]! * row[j]!
    }
  }
  for (const { ax, ay, bx, by } of list) {
    add([ax, ay, 1, 0, 0, 0, -bx * ax, -bx * ay], bx)
    add([0, 0, 0, ax, ay, 1, -by * ax, -by * ay], by)
  }
  const solved = solveLinear(normal, rhs)
  return solved ? [...solved, 1] : null
}

// The camera motion from matched pairs. A two-point similarity (shift, turn, zoom) is found first,
// because points along court lines can fit a wrong full homography; the homography is used only
// when the inliers spread across the view. The last motion is kept when it explains the frame as well.
function estimate(list: Pair[], width: number, height: number, previous: Homography | null, threshold: number) {
  if (list.length < MIN_INLIERS) return null
  let best: { h: Homography; inliers: Pair[] } | null = null
  let seed = 7
  const pick = () => {
    seed = (seed * 16807) % 2147483647
    return seed % list.length
  }
  // The last motion, or no motion at all, competes like any sampled model.
  for (const h of [previous ?? IDENTITY, IDENTITY]) {
    const inliers = supportOf(h, list, threshold)
    if (spreadsOut(inliers, width, height) && (!best || inliers.length > best.inliers.length)) best = { h, inliers }
  }
  for (let round = 0; round < 400; round += 1) {
    const h = similarityFrom(list[pick()]!, list[pick()]!)
    if (!h) continue
    const inliers = supportOf(h, list, threshold)
    if ((!best || inliers.length > best.inliers.length) && spreadsOut(inliers, width, height)) best = { h, inliers }
  }
  if (!best || best.inliers.length < MIN_INLIERS || best.inliers.length < list.length * 0.25) return null
  const xs = best.inliers.map((pair) => pair.ax)
  const ys = best.inliers.map((pair) => pair.ay)
  const spread = (Math.max(...xs) - Math.min(...xs)) / width > 0.4 && (Math.max(...ys) - Math.min(...ys)) / height > 0.3
  if (spread && best.inliers.length >= 30) {
    const full = homographyFrom(best.inliers)
    if (full) {
      const inliers = supportOf(full, list, threshold)
      if (inliers.length >= best.inliers.length && spreadsOut(inliers, width, height)) best = { h: full, inliers }
    }
  }
  for (const h of [previous ?? IDENTITY, IDENTITY]) {
    const kept = supportOf(h, list, threshold)
    if (kept.length >= best.inliers.length * 0.9 && spreadsOut(kept, width, height)) return { h, inliers: kept.length }
  }
  return { h: best.h, inliers: best.inliers.length }
}

function plausible(h: Homography, width: number, height: number) {
  const center = applyHomography(h, { x: width / 2, y: height / 2 })
  return !!center && Math.hypot(center.x - width / 2, center.y - height / 2) < 0.5 * Math.max(width, height)
}

async function loadImage(url: string) {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = url
  await image.decode()
  return image
}

// Matches frames against one reference picture: the court photo, or any still for a test.
export class MotionMatcher {
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly orb: InstanceType<Cv['ORB']>
  private readonly matcher: InstanceType<Cv['BFMatcher']>
  private readonly onGround: Features | null
  private readonly anywhere: Features
  private readonly cv: Cv
  readonly scale: number
  readonly width: number
  readonly height: number
  private previous: Homography | null = null

  private constructor(cv: Cv, reference: CanvasImageSource, width: number, height: number, court: CourtCalibration | null) {
    this.cv = cv
    this.width = width
    this.height = height
    this.scale = WORK_SIDE / Math.max(width, height)
    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.round(width * this.scale)
    this.canvas.height = Math.round(height * this.scale)
    const context = this.canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('The browser could not draw frames for matching.')
    this.context = context
    this.context.drawImage(reference, 0, 0, this.canvas.width, this.canvas.height)
    const gray = grayOf(cv, this.canvas)
    const mask = court ? groundMask(cv, court, this.canvas.width, this.canvas.height, this.scale) : null
    this.orb = new cv.ORB(FEATURES)
    this.matcher = new cv.BFMatcher(cv.NORM_HAMMING, false)
    this.onGround = mask ? detect(cv, this.orb, gray, mask) : null
    this.anywhere = detect(cv, this.orb, gray, null)
    mask?.delete()
    gray.delete()
  }

  static async create(reference: CanvasImageSource, width: number, height: number, court: CourtCalibration | null) {
    const { cv } = await loadOpenCv()
    return new MotionMatcher(cv as unknown as Cv, reference, width, height, court)
  }

  // Reference-to-frame homography in reference pixels, or null when the frame does not match well.
  measure(source: CanvasImageSource) {
    const { cv } = this
    this.context.drawImage(source, 0, 0, this.canvas.width, this.canvas.height)
    const gray = grayOf(cv, this.canvas)
    const frame = detect(cv, this.orb, gray, null)
    gray.delete()
    const threshold = 3 / this.scale
    let result = this.onGround ? estimate(pairs(cv, this.matcher, this.onGround, frame, this.scale), this.width, this.height, this.previous, threshold) : null
    if (!result) {
      const wider = estimate(pairs(cv, this.matcher, this.anywhere, frame, this.scale), this.width, this.height, this.previous, threshold)
      if (wider) result = wider
    }
    frame.points.delete()
    frame.descriptors.delete()
    if (!result || !plausible(result.h, this.width, this.height)) return null
    this.previous = result.h
    return result
  }

  dispose() {
    for (const features of [this.onGround, this.anywhere]) {
      features?.points.delete()
      features?.descriptors.delete()
    }
    this.orb.delete()
    this.matcher.delete()
  }
}

// Measures how the camera moved in each sampled frame, against the court photo. Frames that do not
// match well keep the last good motion.
export async function trackMotion(
  videoUrl: string,
  referenceUrl: string,
  court: CourtCalibration,
  assetId: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number, trusted: number) => void,
  fps = 10,
): Promise<MotionTrack> {
  const matcher = await MotionMatcher.create(await loadImage(referenceUrl), court.sourceWidth, court.sourceHeight, court)
  const video = await openVideo(videoUrl)
  try {
    const duration = Math.min(video.duration, 120)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('This video has no length to read.')
    const total = Math.min(POSE_TRACK_LIMIT, Math.floor(duration * fps) + 1)
    const end = Math.max(0, duration - 0.01)
    const frames: MotionFrame[] = []
    let last: Homography = IDENTITY
    let trusted = 0
    onProgress(0, total, 0)
    for (let index = 0; index < total; index += 1) {
      if (signal.aborted) throw new DOMException('Motion tracking was stopped.', 'AbortError')
      const t = Math.min(end, index / fps)
      await seek(video, t)
      const result = matcher.measure(video)
      if (result) {
        last = result.h
        trusted += 1
        frames.push({ t, h: result.h, inliers: result.inliers })
      } else {
        frames.push({ t, h: last, inliers: 0 })
      }
      onProgress(index + 1, total, trusted)
    }
    return {
      assetId,
      referenceId: court.assetId,
      sourceWidth: court.sourceWidth,
      sourceHeight: court.sourceHeight,
      sampleFps: fps,
      duration,
      createdAt: Date.now(),
      frames,
    }
  } finally {
    matcher.dispose()
    video.removeAttribute('src')
    video.load()
  }
}
