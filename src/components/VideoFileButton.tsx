import { useRef, useState } from 'react'
import { useSession } from '../session/context'

// The size of a video file, read from its first frame.
function videoSize(file: File) {
  return new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    const done = () => {
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
    }
    video.onloadedmetadata = () => {
      const size = { width: video.videoWidth, height: video.videoHeight, duration: video.duration }
      done()
      if (size.width < 2 || size.height < 2) reject(new Error('This file has no picture this browser can show.'))
      else resolve(size)
    }
    video.onerror = () => {
      done()
      reject(new Error('This browser cannot play that file. MP4 (H.264) and WebM work everywhere.'))
    }
    video.src = url
  })
}

// Adds a match video recorded on another camera, up to 4 GB, to the session.
export function VideoFileButton({ onAdded }: { onAdded: (id: string) => void }) {
  const { addAsset } = useSession()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  async function pick(file: File | undefined) {
    if (!file) return
    setMessage(null)
    setFailed(false)
    try {
      const size = await videoSize(file)
      const id = addAsset({
        kind: 'video',
        blob: file,
        mimeType: file.type || 'video/mp4',
        cameraLabel: `File: ${file.name}`.slice(0, 160),
        width: size.width,
        height: size.height,
      })
      onAdded(id)
      const minutes = Number.isFinite(size.duration) ? Math.round(size.duration / 60) : 0
      setMessage(
        minutes >= 2
          ? `Added ${file.name} (${minutes} minutes). Ball and player tracking read up to an hour, a minute at a time.`
          : `Added ${file.name}.`,
      )
    } catch (caught) {
      setFailed(true)
      setMessage(caught instanceof Error ? caught.message : 'That file could not be added.')
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="file-pick">
      <label className="secondary link-button">
        Add a video file
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="visually-hidden"
          onChange={(event) => void pick(event.target.files?.[0])}
        />
      </label>
      {message ? (
        <p className={failed ? 'warn' : 'muted'} role={failed ? 'alert' : 'status'}>
          {message}
        </p>
      ) : null}
    </div>
  )
}
