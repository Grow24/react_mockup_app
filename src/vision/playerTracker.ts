import {
  CHUNK_SECONDS,
  fpsForLength,
  LONG_VIDEO_SECONDS,
  PEOPLE_MODEL_ID,
  POSE_TRACK_LIMIT,
  TENNIS_RACKET_CLASS,
  trackUnfinished,
  type CourtCalibration,
  type PlayerProfile,
  type PoseFrame,
  type PoseTrack,
} from '../../shared/contracts.ts'
import { appearanceOf, PlayerIdentifier } from './identity'
import { openVideo, seek, type ChunkOptions } from './ballTracker'
import { COCO_MODEL } from './models'
import { detectPeople, detectSource, prepareOnnx, preparePeople } from './onnxDetector'
import { assignPlayers, holdRackets, identitySpot } from './players'

// Colors are read from frames at this long side.
const LOOK_SIDE = 960

export const POSE_FPS_CHOICES = [5, 10, 15, 30] as const
export const POSE_MAX_SECONDS = LONG_VIDEO_SECONDS

export async function trackPlayers(
  url: string,
  assetId: string,
  // The courts this camera watches; people are placed on the one they stand on.
  courtOrCourts: CourtCalibration | CourtCalibration[] | null,
  signal: AbortSignal,
  onProgress: (done: number, total: number, found: number) => void,
  chosenFps = 10,
  // Players already lettered in other videos of the session keep their letters.
  seeds: PlayerProfile[] = [],
  { resume, onChunk }: ChunkOptions<PoseTrack> = {},
): Promise<PoseTrack> {
  const courts = Array.isArray(courtOrCourts) ? courtOrCourts : courtOrCourts ? [courtOrCourts] : []
  await preparePeople()
  await prepareOnnx(COCO_MODEL)
  const video = await openVideo(url)
  try {
    const width = video.videoWidth
    const height = video.videoHeight
    if (width < 2 || height < 2) throw new Error('This video has no frames to read.')
    const duration = Math.min(video.duration, POSE_MAX_SECONDS)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('This video has no length to read.')
    const fps = fpsForLength(duration, chosenFps)
    const total = Math.min(POSE_TRACK_LIMIT, Math.floor(duration * fps) + 1)
    const end = Math.max(0, duration - 0.01)
    const carried = resume && resume.sampleFps === fps && trackUnfinished(resume) ? resume : null
    let frames: PoseFrame[] = carried ? carried.frames : []
    let found = frames.filter((frame) => frame.people.length > 0).length
    // Carrying on, the letters seen so far come first, so the same players keep them.
    const known = carried?.players ?? []
    const identifier = new PlayerIdentifier([...known, ...seeds.filter((seed) => !known.some((player) => player.id === seed.id))], courts.length > 0)
    const scale = Math.min(1, LOOK_SIDE / Math.max(width, height))
    const look = document.createElement('canvas')
    look.width = Math.round(width * scale)
    look.height = Math.round(height * scale)
    const lookContext = look.getContext('2d', { willReadFrequently: true })
    let chunk: PoseFrame[] = []
    let readTo = carried?.duration ?? 0
    const track = (upTo: number, partial: boolean): PoseTrack => {
      // A letter seen in only a few frames was a flicker or a passer-by.
      const players = identifier.profiles(Math.max(2, Math.round((frames.length + chunk.length) * 0.05)))
      const kept = new Set(players.map((player) => player.id))
      frames = frames.concat(chunk)
      chunk = []
      return {
        assetId,
        modelId: PEOPLE_MODEL_ID,
        sourceWidth: width,
        sourceHeight: height,
        sampleFps: fps,
        duration: upTo,
        createdAt: Date.now(),
        frames: frames.map((frame) =>
          frame.people.some((person) => person.id && !kept.has(person.id))
            ? { t: frame.t, people: frame.people.map(({ id, ...person }) => (id && kept.has(id) ? { ...person, id } : person)) }
            : frame,
        ),
        players,
        ...(partial ? { videoDuration: duration } : {}),
      }
    }
    const stoppedHere = () => new DOMException('Player tracking was stopped.', 'AbortError')
    const first = carried ? Math.round(carried.duration * fps) + 1 : 0
    onProgress(first, total, found)
    for (let index = first; index < total; index += 1) {
      const t = Math.min(end, index / fps)
      try {
        if (signal.aborted) throw stoppedHere()
        await seek(video, t)
        let reading: Awaited<ReturnType<typeof detectPeople>> = null
        while (!reading) {
          if (signal.aborted) throw stoppedHere()
          reading = await detectPeople(video, width, height)
          if (!reading) await new Promise((resolve) => window.setTimeout(resolve, 30))
        }
        let people = assignPlayers(reading.people, courts, width, height)
        if (people.length > 0) {
          let rackets: Awaited<ReturnType<typeof detectSource>> = null
          while (!rackets) {
            if (signal.aborted) throw stoppedHere()
            rackets = await detectSource(video, width, height, { model: COCO_MODEL, classes: [TENNIS_RACKET_CLASS], minScore: 0.2 })
            if (!rackets) await new Promise((resolve) => window.setTimeout(resolve, 30))
          }
          people = holdRackets(people, rackets.detections)
        }
        if (lookContext && people.length > 0) {
          lookContext.drawImage(video, 0, 0, look.width, look.height)
          const pixels = lookContext.getImageData(0, 0, look.width, look.height).data
          const appearances = people.map((person) => appearanceOf(pixels, look.width, look.height, person, scale))
          const spots = people.map((person) => identitySpot(person, courts, width, height))
          people = identifier.assign(people, appearances, spots, t)
        }
        if (people.length > 0) found += 1
        chunk.push({ t, people })
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError' && index > first) onChunk?.(track(readTo, true))
        throw caught
      }
      readTo = t
      onProgress(index + 1, total, found)
      if (chunk.length >= CHUNK_SECONDS * fps && index < total - 1) onChunk?.(track(readTo, true))
    }
    return track(duration, false)
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
