import { BALL_TRACK_LIMIT, type BallTrack } from '../../shared/contracts.ts'
import { candidatesFrom, linkBallTrack, type BallFrame } from './ball.ts'
import { COCO_MODEL, type DetectorModel } from './models'
import { detectSource, prepareOnnx } from './onnxDetector'

export const BALL_SAMPLE_FPS = 10
export const BALL_MAX_SECONDS = 120
const BALL_MIN_SCORE = 0.15

function once(video: HTMLVideoElement, event: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error('The video stopped answering.')), timeoutMs)
    function finish(error?: Error) {
      window.clearTimeout(timer)
      video.removeEventListener(event, onEvent)
      video.removeEventListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    function onEvent() {
      finish()
    }
    function onError() {
      finish(new Error('The video could not be read.'))
    }
    video.addEventListener(event, onEvent)
    video.addEventListener('error', onError)
  })
}

export async function seek(video: HTMLVideoElement, t: number) {
  if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) return
  const seeked = once(video, 'seeked', 15000)
  video.currentTime = t
  await seeked
}

export async function openVideo(url: string) {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  const loaded = once(video, 'loadeddata', 30000)
  video.src = url
  await loaded
  // MediaRecorder WebM files report an Infinity duration until the end has been seeked.
  if (!Number.isFinite(video.duration)) {
    await seek(video, 1e7)
    await seek(video, 0)
  }
  return video
}

function stopped() {
  return new DOMException('Ball tracking was stopped.', 'AbortError')
}

async function detectBall(video: HTMLVideoElement, signal: AbortSignal, model: DetectorModel) {
  for (;;) {
    if (signal.aborted) throw stopped()
    const result = await detectSource(video, video.videoWidth, video.videoHeight, {
      model,
      classes: model.ballClasses,
      minScore: BALL_MIN_SCORE,
    })
    if (result) return result.detections
    await new Promise((resolve) => window.setTimeout(resolve, 30))
  }
}

export async function trackBall(
  url: string,
  assetId: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number, found: number) => void,
  model: DetectorModel = COCO_MODEL,
): Promise<BallTrack> {
  if (model.ballClasses.length === 0) throw new Error(`Pick which classes are the ball for ${model.name} on the AI screen.`)
  await prepareOnnx(model)
  const video = await openVideo(url)
  try {
    const width = video.videoWidth
    const height = video.videoHeight
    if (width < 2 || height < 2) throw new Error('This video has no frames to read.')
    const duration = Math.min(video.duration, BALL_MAX_SECONDS)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('This video has no length to read.')
    const total = Math.min(BALL_TRACK_LIMIT, Math.floor(duration * BALL_SAMPLE_FPS) + 1)
    const end = Math.max(0, duration - 0.01)
    const frames: BallFrame[] = []
    let found = 0
    onProgress(0, total, 0)
    for (let index = 0; index < total; index += 1) {
      if (signal.aborted) throw stopped()
      const t = Math.min(end, index / BALL_SAMPLE_FPS)
      await seek(video, t)
      const candidates = candidatesFrom(await detectBall(video, signal, model))
      if (candidates.length > 0) found += 1
      frames.push({ t, candidates })
      onProgress(index + 1, total, found)
    }
    return {
      assetId,
      modelId: model.id,
      sourceWidth: width,
      sourceHeight: height,
      sampleFps: BALL_SAMPLE_FPS,
      duration,
      createdAt: Date.now(),
      points: linkBallTrack(frames, width, height),
    }
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
