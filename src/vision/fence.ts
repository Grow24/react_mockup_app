import { openVideo, seek } from './ballTracker'
import { loadOpenCv } from './opencv'

// Cleaning runs at this long side; the result is drawn back at the frame's size.
const WORK_SIDE = 640
// Fence wires thinner than this many working pixels are found by the black-hat filter.
export const FENCE_THICKNESS = { thin: 5, medium: 7, thick: 11 } as const
export type FenceThickness = keyof typeof FENCE_THICKNESS
// A pixel is fence when it shows a wire in this share of the frames looked at.
const VOTE_SHARE = 0.6
// A wire is at least this many grey levels, and this share of its surroundings, darker than them.
const MIN_DIP = 8
const MIN_SHARE = 0.22
// Along a found wire, a fainter dip is enough.
const LOOSE_DIP = 4
const LOOSE_SHARE = 0.08

type Mat = { rows: number; cols: number; data: Uint8Array; delete: () => void }
type Cv = {
  Mat: new () => Mat
  Size: new (width: number, height: number) => unknown
  MORPH_ELLIPSE: number
  MORPH_RECT: number
  MORPH_BLACKHAT: number
  THRESH_BINARY: number
  THRESH_OTSU: number
  INPAINT_TELEA: number
  CV_8UC1: number
  COLOR_RGBA2GRAY: number
  COLOR_RGBA2RGB: number
  COLOR_RGB2RGBA: number
  imread: (source: HTMLCanvasElement) => Mat
  imshow: (canvas: HTMLCanvasElement, mat: Mat) => void
  matFromArray: (rows: number, cols: number, type: number, data: ArrayLike<number>) => Mat
  cvtColor: (src: Mat, dst: Mat, code: number) => void
  getStructuringElement: (shape: number, size: unknown) => Mat
  morphologyEx: (src: Mat, dst: Mat, op: number, kernel: Mat) => void
  threshold: (src: Mat, dst: Mat, thresh: number, max: number, type: number) => number
  dilate: (src: Mat, dst: Mat, kernel: Mat) => void
  HoughLinesP: (src: Mat, lines: Mat & { data32S: Int32Array }, rho: number, theta: number, threshold: number, minLength: number, maxGap: number) => void
  line: (image: Mat, a: unknown, b: unknown, color: unknown, thickness: number) => void
  Point: new (x: number, y: number) => unknown
  Scalar: new (value: number) => unknown
  inpaint: (src: Mat, mask: Mat, dst: Mat, radius: number, method: number) => void
}

// Finds a chain-link fence in front of the camera and paints it out of frames.
export class FenceRemover {
  private readonly cv: Cv
  private readonly work: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly wire: Mat
  private readonly grow: Mat
  private votes: Uint16Array
  private looseVotes: Uint16Array
  private seen = 0
  private mask: Mat | null = null
  readonly width: number
  readonly height: number

  private constructor(cv: Cv, width: number, height: number, thickness: FenceThickness) {
    this.cv = cv
    const scale = Math.min(1, WORK_SIDE / Math.max(width, height))
    this.width = Math.round(width * scale)
    this.height = Math.round(height * scale)
    this.work = document.createElement('canvas')
    this.work.width = this.width
    this.work.height = this.height
    const context = this.work.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('The browser could not draw frames for the fence.')
    this.context = context
    const size = FENCE_THICKNESS[thickness]
    this.wire = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size))
    this.grow = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
    this.votes = new Uint16Array(this.width * this.height)
    this.looseVotes = new Uint16Array(this.width * this.height)
  }

  static async create(width: number, height: number, thickness: FenceThickness = 'thin') {
    const { cv } = await loadOpenCv()
    return new FenceRemover(cv as unknown as Cv, width, height, thickness)
  }

  // Thin dark lines in one frame: how much darker each pixel is than the thin-line-free picture
  // around it (the black-hat), as a share of that local brightness, so wires over shade count too.
  private wiresIn(source: CanvasImageSource) {
    const { cv } = this
    this.context.drawImage(source, 0, 0, this.width, this.height)
    const color = cv.imread(this.work)
    const gray = new cv.Mat()
    cv.cvtColor(color, gray, cv.COLOR_RGBA2GRAY)
    const response = new cv.Mat()
    cv.morphologyEx(gray, response, cv.MORPH_BLACKHAT, this.wire)
    const wires = new Uint8Array(this.width * this.height)
    for (let index = 0; index < wires.length; index += 1) {
      const dip = response.data[index]!
      const share = dip / (gray.data[index]! + dip + 10)
      wires[index] = dip >= MIN_DIP && share >= MIN_SHARE ? 2 : dip >= LOOSE_DIP && share >= LOOSE_SHARE ? 1 : 0
    }
    color.delete()
    gray.delete()
    response.delete()
    return wires
  }

  // Counts which pixels show a wire in this frame. The fence stays put while players move, so only
  // pixels that are wire in most frames end up in the mask.
  learn(source: CanvasImageSource) {
    const wires = this.wiresIn(source)
    for (let index = 0; index < this.votes.length; index += 1) {
      if (wires[index] === 2) this.votes[index]! += 1
      if (wires[index]) this.looseVotes[index]! += 1
    }
    this.seen += 1
    this.mask?.delete()
    this.mask = null
  }

  // With only one picture to go on, its own wires are the mask.
  useSingle(source: CanvasImageSource) {
    this.votes = new Uint16Array(this.width * this.height)
    this.looseVotes = new Uint16Array(this.width * this.height)
    this.seen = 0
    this.learn(source)
  }

  // Wire pixels that line up into long straight runs along the fence's two main directions; other
  // thin dark texture (windows, leaves, shadows) is left alone.
  private currentMask() {
    if (this.mask) return this.mask
    if (this.seen === 0) return null
    const { cv } = this
    const need = Math.max(1, Math.ceil(this.seen * VOTE_SHARE))
    const raw = new Uint8Array(this.votes.length)
    for (let index = 0; index < raw.length; index += 1) raw[index] = this.votes[index]! >= need ? 255 : 0
    const candidates = cv.matFromArray(this.height, this.width, cv.CV_8UC1, raw)
    const segments = new cv.Mat() as Mat & { data32S: Int32Array }
    const diagonal = Math.hypot(this.width, this.height)
    cv.HoughLinesP(candidates, segments, 1, Math.PI / 180, 25, diagonal * 0.08, 3)
    const list: { a: number; b: number; c: number; d: number; angle: number; length: number }[] = []
    for (let index = 0; index < segments.rows; index += 1) {
      const [a, b, c, d] = [0, 1, 2, 3].map((k) => segments.data32S[index * 4 + k]!) as [number, number, number, number]
      const angle = ((Math.atan2(d - b, c - a) * 180) / Math.PI + 180) % 180
      list.push({ a, b, c, d, angle, length: Math.hypot(c - a, d - b) })
    }
    segments.delete()
    const bins = new Array<number>(36).fill(0)
    for (const segment of list) bins[Math.floor(segment.angle / 5) % 36]! += segment.length
    const first = bins.indexOf(Math.max(...bins))
    const second = bins.map((value, index) => (Math.min(Math.abs(index - first), 36 - Math.abs(index - first)) < 4 ? 0 : value))
    const peaks = [first, second.indexOf(Math.max(...second))].map((bin) => bin * 5 + 2.5)
    // Wires run straight across the whole picture, so each found piece is carried on to the edges,
    // and fainter wire pixels along it count too.
    const along = cv.matFromArray(this.height, this.width, cv.CV_8UC1, new Uint8Array(raw.length))
    const reach = diagonal
    for (const segment of list) {
      if (!peaks.some((peak) => Math.min(Math.abs(segment.angle - peak), 180 - Math.abs(segment.angle - peak)) <= 7)) continue
      const ux = (segment.c - segment.a) / segment.length
      const uy = (segment.d - segment.b) / segment.length
      cv.line(
        along,
        new cv.Point(Math.round(segment.a - ux * reach), Math.round(segment.b - uy * reach)),
        new cv.Point(Math.round(segment.c + ux * reach), Math.round(segment.d + uy * reach)),
        new cv.Scalar(255),
        3,
      )
    }
    for (let index = 0; index < raw.length; index += 1) along.data[index] = along.data[index] && this.looseVotes[index]! >= need ? 255 : 0
    const grown = new cv.Mat()
    cv.dilate(along, grown, this.grow)
    candidates.delete()
    along.delete()
    this.mask = grown
    return grown
  }

  // Share of the picture covered by fence.
  coverage() {
    const mask = this.currentMask()
    if (!mask) return 0
    let count = 0
    for (let index = 0; index < mask.data.length; index += 1) if (mask.data[index]) count += 1
    return count / mask.data.length
  }

  // Draws the frame with the fence painted out by its surroundings (Telea inpainting).
  clean(source: CanvasImageSource, target: HTMLCanvasElement) {
    const mask = this.currentMask()
    const { cv } = this
    this.context.drawImage(source, 0, 0, this.width, this.height)
    if (!mask) {
      target.getContext('2d')?.drawImage(this.work, 0, 0, target.width, target.height)
      return
    }
    const color = cv.imread(this.work)
    const rgb = new cv.Mat()
    cv.cvtColor(color, rgb, cv.COLOR_RGBA2RGB)
    const filled = new cv.Mat()
    cv.inpaint(rgb, mask, filled, 3, cv.INPAINT_TELEA)
    const out = new cv.Mat()
    cv.cvtColor(filled, out, cv.COLOR_RGB2RGBA)
    cv.imshow(this.work, out)
    for (const mat of [color, rgb, filled, out]) mat.delete()
    target.getContext('2d')?.drawImage(this.work, 0, 0, target.width, target.height)
  }

  // The fence mask as a picture, for checking what will be removed.
  drawMask(target: HTMLCanvasElement) {
    const mask = this.currentMask()
    const context = target.getContext('2d')
    if (!mask || !context) return
    const image = context.createImageData(this.width, this.height)
    for (let index = 0; index < mask.data.length; index += 1) {
      const on = mask.data[index] ? 255 : 0
      image.data[index * 4] = on
      image.data[index * 4 + 1] = on * 0.4
      image.data[index * 4 + 2] = 0
      image.data[index * 4 + 3] = on ? 200 : 0
    }
    const scratch = document.createElement('canvas')
    scratch.width = this.width
    scratch.height = this.height
    scratch.getContext('2d')?.putImageData(image, 0, 0)
    context.drawImage(scratch, 0, 0, target.width, target.height)
  }

  dispose() {
    this.mask?.delete()
    this.wire.delete()
    this.grow.delete()
  }
}

// Looks at frames spread through the video to learn where the fence is.
export async function learnFence(url: string, remover: FenceRemover, signal: AbortSignal, onProgress: (done: number, total: number) => void, samples = 16) {
  const video = await openVideo(url)
  try {
    const duration = Math.min(video.duration, 120)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('This video has no length to read.')
    for (let index = 0; index < samples; index += 1) {
      if (signal.aborted) throw new DOMException('Learning the fence was stopped.', 'AbortError')
      await seek(video, Math.min(duration - 0.01, (duration * (index + 0.5)) / samples))
      remover.learn(video)
      onProgress(index + 1, samples)
    }
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
