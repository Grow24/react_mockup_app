import type { CourtPoint, CourtPreset } from '../../shared/contracts.ts'
import { courtMeters, destinationCorners } from './court.ts'

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

let pending: Promise<OpenCv> | null = null

export function loadOpenCv() {
  if (typeof window === 'undefined') return Promise.reject(new Error('OpenCV.js runs in the browser.'))
  const current = readyCv((window as unknown as { cv?: unknown }).cv)
  if (current) return Promise.resolve(current)
  if (!pending) {
    pending = new Promise<OpenCv>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = OPENCV_URL
      script.async = true
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
            resolve(started)
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

export async function renderCourt(
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  preset: CourtPreset,
  sourceWidth: number,
  sourceHeight: number,
  imagePoints: CourtPoint[],
  markers: { label: string; point: CourtPoint }[],
  isCurrent: () => boolean,
) {
  const cv = await loadOpenCv()
  if (!isCurrent() || image.naturalWidth < 2 || image.naturalHeight < 2) return []
  const scaleX = image.naturalWidth / sourceWidth
  const scaleY = image.naturalHeight / sourceHeight
  const scaledPoints = imagePoints.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }))
  const dstSize = destinationCorners(preset)
  const width = Math.round(dstSize[1]?.x ?? 2)
  const height = Math.round(dstSize[0]?.y ?? 2)
  const created: CvMat[] = []
  const lines: string[] = []
  try {
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, flat(scaledPoints))
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, flat(dstSize))
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
        lines.push(
          `${marker.label}: ${meters.fromLeft.toFixed(1)} m from the left line, ${meters.fromNear.toFixed(1)} m from the near line`,
        )
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
