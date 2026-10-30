import { jpegFromVideo } from '../camera/webcodecs'
import { openVideo, seek } from '../vision/ballTracker'

export type Frame = { blob: Blob; width: number; height: number; time: number }

export const MAX_FRAMES_PER_VIDEO = 120

// Saves one JPEG every `everySeconds` across a video, for labeling.
export async function sampleFrames(url: string, everySeconds: number, onFrame: (done: number, total: number) => void) {
  const video = await openVideo(url)
  try {
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const total = Math.min(MAX_FRAMES_PER_VIDEO, Math.max(1, Math.floor(duration / everySeconds) + 1))
    const frames: Frame[] = []
    for (let index = 0; index < total; index += 1) {
      const time = Math.min(Math.max(0, duration - 0.01), index * everySeconds)
      await seek(video, time)
      const still = await jpegFromVideo(video)
      frames.push({ blob: still.blob, width: still.width, height: still.height, time })
      onFrame(index + 1, total)
    }
    return frames
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

export async function photoFrame(url: string): Promise<Frame> {
  const image = new Image()
  image.src = url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The photo could not be read.')
  context.drawImage(image, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  if (!blob) throw new Error('The photo could not be saved as JPEG.')
  return { blob, width: canvas.width, height: canvas.height, time: 0 }
}
