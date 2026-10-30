import type { CourtPoint } from '../../shared/contracts.ts'
import { fitCourtModel, landmarksInView, mergeSegments, type Segment } from './courtFit'
import { loadOpenCv } from './opencv'

const WORK_SIDE = 960
// Court lines are a few pixels wide; the top-hat keeps bright things narrower than this.
const TOP_HAT = 15
const BRIGHTER_BY = 30
const MAX_SATURATION = 0.35
// Of the brightest one percent of the picture.
const BRIGHT_SHARE = 0.6

type Mat = { rows: number; cols: number; data: Uint8Array; data32S: Int32Array; delete: () => void }
type Cv = {
  Mat: new () => Mat
  Size: new (width: number, height: number) => unknown
  MORPH_RECT: number
  MORPH_TOPHAT: number
  CV_8UC1: number
  COLOR_RGBA2GRAY: number
  imread: (source: HTMLCanvasElement) => Mat
  matFromArray: (rows: number, cols: number, type: number, data: ArrayLike<number>) => Mat
  cvtColor: (src: Mat, dst: Mat, code: number) => void
  getStructuringElement: (shape: number, size: unknown) => Mat
  morphologyEx: (src: Mat, dst: Mat, op: number, kernel: Mat) => void
  dilate: (src: Mat, dst: Mat, kernel: Mat) => void
  HoughLinesP: (src: Mat, lines: Mat, rho: number, theta: number, threshold: number, minLength: number, maxGap: number) => void
}

export type DetectedCourt = { landmarks: string[]; imagePoints: CourtPoint[]; hitRate: number }

// Finds a tennis court's painted lines in a photo and returns four court points, in the photo's
// pixels, as if they had been clicked. Null when no court fits the lines well.
export async function detectCourt(image: CanvasImageSource, width: number, height: number): Promise<DetectedCourt | null> {
  const { cv: loaded } = await loadOpenCv()
  const cv = loaded as unknown as Cv
  const scale = Math.min(1, WORK_SIDE / Math.max(width, height))
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(image, 0, 0, w, h)
  const pixels = context.getImageData(0, 0, w, h).data

  const created: Mat[] = []
  const keep = (mat: Mat) => {
    created.push(mat)
    return mat
  }
  try {
    const color = keep(cv.imread(canvas))
    const gray = keep(new cv.Mat())
    cv.cvtColor(color, gray, cv.COLOR_RGBA2GRAY)
    const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(TOP_HAT, TOP_HAT)))
    const tophat = keep(new cv.Mat())
    cv.morphologyEx(gray, tophat, cv.MORPH_TOPHAT, kernel)
    // Painted lines: brighter than their surroundings, close to white (not a yellow ball or a shirt),
    // and near the brightest things in the picture, not the gaps between a dark fence's wires.
    const histogram = new Array<number>(256).fill(0)
    for (let index = 0; index < w * h; index += 1) histogram[Math.max(pixels[index * 4]!, pixels[index * 4 + 1]!, pixels[index * 4 + 2]!)]! += 1
    let bright = 255
    for (let seen = 0; bright > 0 && seen < w * h * 0.01; bright -= 1) seen += histogram[bright]!
    const floor = Math.max(90, bright * BRIGHT_SHARE)
    const white = new Uint8Array(w * h)
    for (let index = 0; index < w * h; index += 1) {
      const r = pixels[index * 4]!
      const g = pixels[index * 4 + 1]!
      const b = pixels[index * 4 + 2]!
      const top = Math.max(r, g, b)
      const saturation = top === 0 ? 0 : (top - Math.min(r, g, b)) / top
      white[index] = tophat.data[index]! >= BRIGHTER_BY && saturation <= MAX_SATURATION && top >= floor ? 255 : 0
    }
    const mask = keep(cv.matFromArray(h, w, cv.CV_8UC1, white))
    const segments = keep(new cv.Mat())
    const diagonal = Math.hypot(w, h)
    cv.HoughLinesP(mask, segments, 1, Math.PI / 360, 30, diagonal * 0.04, diagonal * 0.01)
    const list: Segment[] = []
    for (let index = 0; index < segments.rows; index += 1) {
      const at = index * 4
      list.push([segments.data32S[at]!, segments.data32S[at + 1]!, segments.data32S[at + 2]!, segments.data32S[at + 3]!])
    }
    const lines = mergeSegments(list, diagonal)
    const grown = keep(new cv.Mat())
    cv.dilate(mask, grown, keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))))
    const found = fitCourtModel(lines, { data: grown.data, width: w, height: h }, { data: white, width: w, height: h })
    if (!found) return null
    const chosen = landmarksInView(found.h, w, h)
    if (!chosen) return null
    return {
      landmarks: chosen.landmarks,
      imagePoints: chosen.imagePoints.map((point) => ({ x: point.x / scale, y: point.y / scale })),
      hitRate: found.hitRate,
    }
  } finally {
    for (const mat of created) mat.delete()
  }
}
