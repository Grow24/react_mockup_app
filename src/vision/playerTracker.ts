import { PEOPLE_MODEL_ID, POSE_TRACK_LIMIT, type CourtCalibration, type PlayerProfile, type PoseFrame, type PoseTrack } from '../../shared/contracts.ts'
import { appearanceOf, PlayerIdentifier } from './identity'
import { openVideo, seek } from './ballTracker'
import { COCO_MODEL } from './models'
import { detectPeople, detectSource, prepareOnnx, preparePeople } from './onnxDetector'
import { assignPlayers, feetOf, feetOnCourt, holdRackets } from './players'
import { TENNIS_RACKET_CLASS } from '../../shared/contracts.ts'

// Colors are read from frames at this long side.
const LOOK_SIDE = 960

export const POSE_FPS_CHOICES = [5, 10, 15, 30] as const
export const POSE_MAX_SECONDS = 120

export async function trackPlayers(
  url: string,
  assetId: string,
  court: CourtCalibration | null,
  signal: AbortSignal,
  onProgress: (done: number, total: number, found: number) => void,
  fps = 10,
  // Players already lettered in other videos of the session keep their letters.
  seeds: PlayerProfile[] = [],
): Promise<PoseTrack> {
  await preparePeople()
  await prepareOnnx(COCO_MODEL)
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
    const identifier = new PlayerIdentifier(seeds, !!court)
    const scale = Math.min(1, LOOK_SIDE / Math.max(width, height))
    const look = document.createElement('canvas')
    look.width = Math.round(width * scale)
    look.height = Math.round(height * scale)
    const lookContext = look.getContext('2d', { willReadFrequently: true })
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
      let people = assignPlayers(reading.people, court, width, height)
      if (people.length > 0) {
        let rackets: Awaited<ReturnType<typeof detectSource>> = null
        while (!rackets) {
          if (signal.aborted) throw new DOMException('Player tracking was stopped.', 'AbortError')
          rackets = await detectSource(video, width, height, { model: COCO_MODEL, classes: [TENNIS_RACKET_CLASS], minScore: 0.2 })
          if (!rackets) await new Promise((resolve) => window.setTimeout(resolve, 30))
        }
        people = holdRackets(people, rackets.detections)
      }
      if (lookContext && people.length > 0) {
        lookContext.drawImage(video, 0, 0, look.width, look.height)
        const pixels = lookContext.getImageData(0, 0, look.width, look.height).data
        const appearances = people.map((person) => appearanceOf(pixels, look.width, look.height, person, scale))
        const spots = people.map((person) => (court ? feetOnCourt(person, court, width, height) : feetOf(person)))
        people = identifier.assign(people, appearances, spots, t)
      }
      if (people.length > 0) found += 1
      frames.push({ t, people })
      onProgress(index + 1, total, found)
    }
    // A letter seen in only a few frames was a flicker or a passer-by.
    const players = identifier.profiles(Math.max(2, Math.round(total * 0.05)))
    const kept = new Set(players.map((player) => player.id))
    for (const frame of frames) {
      for (const person of frame.people) if (person.id && !kept.has(person.id)) delete person.id
    }
    return { assetId, modelId: PEOPLE_MODEL_ID, sourceWidth: width, sourceHeight: height, sampleFps: fps, duration, createdAt: Date.now(), frames, players }
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
