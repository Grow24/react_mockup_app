import type { CourtCalibration, CourtPoint } from '../../shared/contracts.ts'
import { courtLines, courtWorldPoints } from '../../shared/court.ts'
import { courtMeters, courtPixelSize, mapPixel } from './court.ts'

type CourtPlaneInput = Pick<CourtCalibration, 'preset' | 'landmarks' | 'imagePoints'>

const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js'

type CvMat = {
  data32F: Float32Array
  delete: () => void
}

type OpenCv = {
  CV_32FC2: number
  Mat: new () => CvMat
  matFromArray: (rows: number, cols: number, type: number, data: number[]) => CvMat
  getPerspectiveTransform: (src: CvMat, dst: CvMat) => CvMat
  perspectiveTransform: (src: CvMat, dst: CvMat, matrix: CvMat) => void
  warpPerspective: (src: CvMat, dst: CvMat, matrix: CvMat, size: unknown) => void
  imread: (source: HTMLImageElement) => CvMat
  imshow: (canvas: HTMLCanvasElement, mat: CvMat) => void
  Size: new (width: number, height: number) => unknown
}

type OpenCvBoot = {
  calledRun?: boolean
  then?: (onReady: (cv: OpenCv) => void) => void
}

function readyCv(value: unknown): OpenCv | null {
  if (!value || typeof value !== 'object') return null
  const cv = value as OpenCv & OpenCvBoot
  if (!cv.calledRun || typeof cv.getPerspectiveTransform !== 'function' || typeof cv.Mat !== 'function') return null
  return cv
}

// The Emscripten module has its own `then`, so resolving a Promise with it never settles.
type Loaded = { cv: OpenCv }

let pending: Promise<Loaded> | null = null

export function loadOpenCv() {
  if (typeof window === 'undefined') return Promise.reject(new Error('OpenCV.js runs in the browser.'))
  const current = readyCv((window as unknown as { cv?: unknown }).cv)
  if (current) return Promise.resolve<Loaded>({ cv: current })
  if (!pending) {
    pending = new Promise<Loaded>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = OPENCV_URL
      script.async = true
      script.crossOrigin = 'anonymous'
      script.onerror = () => {
        pending = null
        reject(new Error('OpenCV.js could not be downloaded.'))
      }
      script.onload = () => {
        const cv = (window as unknown as { cv?: OpenCvBoot }).cv
        if (typeof cv?.then !== 'function') {
          pending = null
          reject(new Error('OpenCV.js did not start.'))
          return
        }
        cv.then((ready) => {
          const started = readyCv(ready)
          if (started) {
            resolve({ cv: started })
            return
          }
          pending = null
          reject(new Error('OpenCV.js did not finish starting.'))
        })
      }
      document.head.appendChild(script)
    })
  }
  return pending
}

function flat(points: CourtPoint[]) {
  return points.flatMap((point) => [point.x, point.y])
}

function mapPoints(court: Pick<CourtCalibration, 'preset' | 'landmarks'>) {
  return courtWorldPoints(court).map((world) => mapPixel(court.preset, world))
}

export async function projectToCourt(court: CourtPlaneInput, points: CourtPoint[]) {
  const { cv } = await loadOpenCv()
  if (points.length === 0) return []
  const created: CvMat[] = []
  try {
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, flat(court.imagePoints))
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, flat(mapPoints(court)))
    created.push(srcPts, dstPts)
    const matrix = cv.getPerspectiveTransform(srcPts, dstPts)
    created.push(matrix)
    const input = cv.matFromArray(points.length, 1, cv.CV_32FC2, flat(points))
    const output = new cv.Mat()
    created.push(input, output)
    cv.perspectiveTransform(input, output, matrix)
    return points.map((_, index) => ({
      x: output.data32F[index * 2] ?? 0,
      y: output.data32F[index * 2 + 1] ?? 0,
    }))
  } finally {
    for (const mat of created) mat.delete()
  }
}

export async function renderCourt(
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  court: CourtPlaneInput,
  sourceWidth: number,
  sourceHeight: number,
  markers: { label: string; point: CourtPoint }[],
  isCurrent: () => boolean,
) {
  const { cv } = await loadOpenCv()
  if (!isCurrent() || image.naturalWidth < 2 || image.naturalHeight < 2) return []
  const preset = court.preset
  const scaleX = image.naturalWidth / sourceWidth
  const scaleY = image.naturalHeight / sourceHeight
  const scaledPoints = court.imagePoints.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }))
  const { width, height } = courtPixelSize(preset)
  const created: CvMat[] = []
  const lines: { label: string; fromLeft: number; fromNear: number }[] = []
  try {
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, flat(scaledPoints))
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, flat(mapPoints(court)))
    created.push(srcPts, dstPts)
    const matrix = cv.getPerspectiveTransform(srcPts, dstPts)
    created.push(matrix)
    const src = cv.imread(image)
    created.push(src)
    const warped = new cv.Mat()
    created.push(warped)
    cv.warpPerspective(src, warped, matrix, new cv.Size(width, height))
    if (!isCurrent()) return []
    cv.imshow(canvas, warped)
    const context = canvas.getContext('2d')
    if (!context) return lines
    // Where the court lines should be: if the photo's lines sit under them, the points were clicked well.
    context.strokeStyle = 'rgba(243, 211, 138, 0.85)'
    context.lineWidth = 1.5
    for (const line of courtLines(preset)) {
      const from = mapPixel(preset, line.from)
      const to = mapPixel(preset, line.to)
      context.setLineDash(line.dashed ? [5, 5] : [])
      context.beginPath()
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
      context.stroke()
    }
    context.setLineDash([])
    context.font = '13px "Avenir Next", "Segoe UI", sans-serif'
    for (const marker of markers) {
      const scaled = { x: marker.point.x * scaleX, y: marker.point.y * scaleY }
      const srcPoint = cv.matFromArray(1, 1, cv.CV_32FC2, [scaled.x, scaled.y])
      const dstPoint = new cv.Mat()
      try {
        cv.perspectiveTransform(srcPoint, dstPoint, matrix)
        const pixel = { x: dstPoint.data32F[0] ?? 0, y: dstPoint.data32F[1] ?? 0 }
        if (pixel.x < -20 || pixel.y < -20 || pixel.x > width + 20 || pixel.y > height + 20) continue
        context.beginPath()
        context.fillStyle = '#f3d38a'
        context.arc(pixel.x, pixel.y, 6, 0, Math.PI * 2)
        context.fill()
        const meters = courtMeters(preset, pixel)
        lines.push({ label: marker.label, fromLeft: meters.fromLeft, fromNear: meters.fromNear })
      } finally {
        srcPoint.delete()
        dstPoint.delete()
      }
    }
  } finally {
    for (const mat of created) mat.delete()
  }
  return lines
}
