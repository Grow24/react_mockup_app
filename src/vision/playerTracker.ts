import { PEOPLE_MODEL_ID, POSE_TRACK_LIMIT, type CourtCalibration, type PoseFrame, type PoseTrack } from '../../shared/contracts.ts'
import { openVideo, seek } from './ballTracker'
import { detectPeople, preparePeople } from './onnxDetector'
import { assignPlayers } from './players'

export const POSE_FPS_CHOICES = [5, 10, 15, 30] as const
export const POSE_MAX_SECONDS = 120

export async function trackPlayers(
  url: string,
  assetId: string,
  court: CourtCalibration | null,
  signal: AbortSignal,
  onProgress: (done: number, total: number, found: number) => void,
  fps = 10,
): Promise<PoseTrack> {
  await preparePeople()
  const video = await openVideo(url)
  try {
    const width = video.videoWidth
    const height = video.videoHeight
    if (width < 2 || height < 2) throw new Error('This video has no frames to read.')
    const duration = Math.min(video.duration, POSE_MAX_SECONDS)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('This video has no length to read.')
    const total = Math.min(POSE_TRACK_LIMIT, Math.floor(duration * fps) + 1)
    const end = Math.max(0, duration - 0.01)
    const frames: PoseFrame[] = []
    let found = 0
    onProgress(0, total, 0)
    for (let index = 0; index < total; index += 1) {
      if (signal.aborted) throw new DOMException('Player tracking was stopped.', 'AbortError')
      const t = Math.min(end, index / fps)
      await seek(video, t)
      let reading: Awaited<ReturnType<typeof detectPeople>> = null
      while (!reading) {
        if (signal.aborted) throw new DOMException('Player tracking was stopped.', 'AbortError')
        reading = await detectPeople(video, width, height)
        if (!reading) await new Promise((resolve) => window.setTimeout(resolve, 30))
      }
      const people = assignPlayers(reading.people, court, width, height)
      if (people.length > 0) found += 1
      frames.push({ t, people })
      onProgress(index + 1, total, found)
    }
    return { assetId, modelId: PEOPLE_MODEL_ID, sourceWidth: width, sourceHeight: height, sampleFps: fps, duration, createdAt: Date.now(), frames }
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
