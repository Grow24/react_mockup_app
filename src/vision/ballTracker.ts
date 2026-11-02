import {
  BALL_TRACK_LIMIT,
  CHUNK_SECONDS,
  LONG_VIDEO_SECONDS,
  trackUnfinished,
  type BallPoint,
  type BallTrack,
} from '../../shared/contracts.ts'
import { candidatesFrom, linkBallTrack, type BallFrame } from './ball.ts'
import { COCO_MODEL, type DetectorModel } from './models'
import { detectSource, prepareOnnx } from './onnxDetector'

export const BALL_SAMPLE_FPS = 10
export const BALL_FPS_CHOICES = [10, 20, 30] as const
export const BALL_MAX_SECONDS = LONG_VIDEO_SECONDS
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

export type ChunkOptions<T> = {
  // An unfinished track of this video to carry on from.
  resume?: T | null
  // Hears the track so far after every minute of video read, and when stopped.
  onChunk?: (partial: T) => void
}

export async function trackBall(
  url: string,
  assetId: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number, found: number) => void,
  model: DetectorModel = COCO_MODEL,
  fps: number = BALL_SAMPLE_FPS,
  { resume, onChunk }: ChunkOptions<BallTrack> = {},
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
    const total = Math.min(BALL_TRACK_LIMIT, Math.floor(duration * fps) + 1)
    const end = Math.max(0, duration - 0.01)
    const carried =
      resume && resume.sampleFps === fps && resume.modelId === model.id && !resume.live && trackUnfinished(resume) ? resume : null
    let points: BallPoint[] = carried ? carried.points : []
    let chunk: BallFrame[] = []
    let found = points.length
    let readTo = carried?.duration ?? 0
    const track = (upTo: number, partial: boolean): BallTrack => ({
      assetId,
      modelId: model.id,
      sourceWidth: width,
      sourceHeight: height,
      sampleFps: fps,
      duration: upTo,
      createdAt: Date.now(),
      points,
      ...(partial ? { videoDuration: duration } : {}),
    })
    // Each minute is linked on its own, so a long video never holds more than a minute of raw detections.
    const flush = () => {
      if (chunk.length > 0) points = points.concat(linkBallTrack(chunk, width, height))
      chunk = []
    }
    const first = carried ? Math.round(carried.duration * fps) + 1 : 0
    onProgress(first, total, found)
    for (let index = first; index < total; index += 1) {
      const t = Math.min(end, index / fps)
      try {
        if (signal.aborted) throw stopped()
        await seek(video, t)
        const candidates = candidatesFrom(await detectBall(video, signal, model))
        if (candidates.length > 0) found += 1
        chunk.push({ t, candidates })
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError' && index > first) {
          flush()
          onChunk?.(track(readTo, true))
        }
        throw caught
      }
      readTo = t
      onProgress(index + 1, total, found)
      if (chunk.length >= CHUNK_SECONDS * fps && index < total - 1) {
        flush()
        onChunk?.(track(readTo, true))
      }
    }
    flush()
    return track(duration, false)
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
