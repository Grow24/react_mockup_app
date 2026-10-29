export type FramePath = 'webcodecs' | 'canvas'

export function framePath(): FramePath {
  return typeof VideoFrame === 'function' ? 'webcodecs' : 'canvas'
}

export function framePathLabel(path: FramePath) {
  return path === 'webcodecs' ? 'WebCodecs VideoFrame' : 'Canvas copy'
}

function paintWebCodecs(context: CanvasRenderingContext2D, video: HTMLVideoElement, width: number, height: number) {
  const timestamp = Math.max(0, Math.round(video.currentTime * 1_000_000))
  const makers = [() => new VideoFrame(video), () => new VideoFrame(video, { timestamp })]
  let last: unknown
  for (const make of makers) {
    let frame: VideoFrame | null = null
    try {
      frame = make()
      context.drawImage(frame, 0, 0, width, height)
      return
    } catch (error) {
      last = error
    } finally {
      frame?.close()
    }
  }
  throw last instanceof Error ? last : new Error('WebCodecs could not read this frame.')
}

export async function jpegFromVideo(video: HTMLVideoElement): Promise<{
  blob: Blob
  width: number
  height: number
  path: FramePath
}> {
  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    throw new Error('Wait until a frame is visible, then try again.')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not read a frame from the preview.')

  let path = framePath()
  if (path === 'webcodecs') {
    try {
      paintWebCodecs(context, video, width, height)
    } catch {
      context.drawImage(video, 0, 0, width, height)
      path = 'canvas'
    }
  } else {
    context.drawImage(video, 0, 0, width, height)
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/jpeg', 0.92)
  })
  if (!blob) throw new Error('Could not save a JPEG from this frame.')
  return { blob, width, height, path }
}
