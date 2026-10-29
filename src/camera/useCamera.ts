import { useEffect, useRef, useState, type RefObject } from 'react'
import { useSession } from '../session/context'
import type { AiSnapshot, CameraInfo, CameraStatus, LiveCamera, NumericRange } from '../types'
import { jpegFromVideo } from './webcodecs'

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
]

function readRange(value: unknown): NumericRange | undefined {
  if (!value || typeof value !== 'object') return undefined
  const range = value as NumericRange
  if (typeof range.min !== 'number' && typeof range.max !== 'number') return undefined
  return {
    min: typeof range.min === 'number' ? range.min : undefined,
    max: typeof range.max === 'number' ? range.max : undefined,
  }
}

function describeTrack(track: MediaStreamTrack, cameras: CameraInfo[]): LiveCamera {
  const settings = track.getSettings()
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : undefined
  const deviceId = settings.deviceId ?? ''
  const listed = cameras.find((camera) => camera.deviceId === deviceId)
  const trackLabel = track.label && track.label !== deviceId ? track.label : ''
  return {
    deviceId,
    label: trackLabel || listed?.label || 'Camera',
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate,
    facingMode: settings.facingMode,
    widthRange: readRange(caps?.width),
    heightRange: readRange(caps?.height),
    frameRateRange: readRange(caps?.frameRate),
    facingModes: caps?.facingMode,
  }
}

async function readCameras(): Promise<CameraInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'videoinput' && device.deviceId)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Camera ${index + 1}`,
    }))
}

function cameraFailure(error: unknown): { status: CameraStatus; message: string } {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return {
        status: 'denied',
        message:
          'The browser blocked the camera. Allow camera access for this site in the address bar, then try again.',
      }
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return {
        status: 'error',
        message: 'No camera was found on this device.',
      }
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return {
        status: 'error',
        message: 'The camera is busy in another app, or the browser could not open it.',
      }
    }
    if (error.name === 'OverconstrainedError') {
      return {
        status: 'error',
        message: 'This camera does not support the requested settings.',
      }
    }
    if (error.name === 'SecurityError') {
      return {
        status: 'error',
        message: 'Camera access needs localhost or HTTPS.',
      }
    }
    if (error.name === 'AbortError') {
      return {
        status: 'error',
        message: 'The camera request was interrupted. Try again.',
      }
    }
  }
  return { status: 'error', message: 'The camera could not be started.' }
}

function preferredMime() {
  if (typeof MediaRecorder === 'undefined') return undefined
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type))
}

export function useCamera(
  previewRef: RefObject<HTMLVideoElement | null>,
  readSnapshot: () => AiSnapshot | null,
) {
  const { addAsset } = useSession()
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const liveRef = useRef<LiveCamera | null>(null)
  const mountedRef = useRef(true)
  const openingRef = useRef(false)

  const [status, setStatus] = useState<CameraStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [cameras, setCameras] = useState<CameraInfo[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [live, setLive] = useState<LiveCamera | null>(null)
  const [recording, setRecording] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [busy, setBusy] = useState(false)
  const [captureMessage, setCaptureMessage] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)

  function rememberLive(next: LiveCamera | null) {
    liveRef.current = next
    setLive(next)
  }

  function stopStream() {
    const current = streamRef.current
    streamRef.current = null
    current?.getTracks().forEach((track) => track.stop())
    if (mountedRef.current) setStream(null)
  }

  function finalizeRecording(recorder: MediaRecorder) {
    const chunks = chunksRef.current
    chunksRef.current = []
    if (chunks.length === 0) return
    const mimeType = recorder.mimeType || preferredMime() || 'video/webm'
    const blob = new Blob(chunks, { type: mimeType })
    if (blob.size === 0) return
    const info = liveRef.current
    addAsset({
      kind: 'video',
      blob,
      mimeType,
      cameraLabel: info?.label ?? 'Camera',
      width: info?.width,
      height: info?.height,
      snapshot: readSnapshot(),
    })
    if (mountedRef.current) {
      setCaptureMessage('Video saved to this session. Play it below or on Results.')
    }
  }

  function stopRecordingAndWait() {
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== 'recording') return Promise.resolve()
    return new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true })
      recorder.stop()
    })
  }

  async function openCamera(deviceId?: string) {
    if (openingRef.current) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus('error')
      setError('Camera access needs localhost or HTTPS, in a browser that supports getUserMedia.')
      return
    }

    openingRef.current = true
    setBusy(true)
    setError(null)
    setNotice(deviceId ? 'Switching camera…' : 'Requesting camera access…')
    if (!deviceId) setStatus('requesting')

    let stream: MediaStream | null = null
    try {
      await stopRecordingAndWait()
      stopStream()
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
      })
      const track = stream.getVideoTracks()[0]
      if (!track) throw new DOMException('No video track was returned.', 'NotFoundError')

      const found = await readCameras()
      const next = describeTrack(track, found)
      if (!mountedRef.current) return

      const owned = stream
      track.onended = () => {
        if (!mountedRef.current || streamRef.current !== owned) return
        setRecording(false)
        rememberLive(null)
        setStatus('error')
        setError('The camera stopped. It may have been unplugged or taken by another app.')
      }

      streamRef.current = owned
      stream = null
      setStream(owned)
      setCameras(found)
      rememberLive(next)
      setSelectedId(next.deviceId)
      setStatus('live')
      setNotice(null)
    } catch (caught) {
      if (!mountedRef.current) return
      const failure = cameraFailure(caught)
      rememberLive(null)
      setStatus(failure.status)
      setError(failure.message)
      setNotice(null)
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      openingRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }

  async function selectCamera(deviceId: string) {
    if (!deviceId || deviceId === liveRef.current?.deviceId) return
    await openCamera(deviceId)
  }

  function startRecording() {
    const stream = streamRef.current
    if (!stream || recording || busy) return
    if (typeof MediaRecorder === 'undefined') {
      setCaptureMessage('This browser cannot record video.')
      return
    }

    const mimeType = preferredMime()
    let recorder: MediaRecorder
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    } catch {
      setCaptureMessage('This browser could not start a recording.')
      return
    }

    chunksRef.current = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onstop = () => {
      finalizeRecording(recorder)
      recorderRef.current = null
      if (mountedRef.current) setRecording(false)
    }
    recorder.start(250)
    recorderRef.current = recorder
    setElapsedMs(0)
    setRecording(true)
    setCaptureMessage(null)
  }

  function toggleRecording() {
    if (recording) {
      void stopRecordingAndWait()
      return
    }
    startRecording()
  }

  async function capturePhoto() {
    const video = previewRef.current
    const info = liveRef.current
    if (!video) {
      setCaptureMessage('Wait until a frame is visible, then try again.')
      return
    }

    try {
      const still = await jpegFromVideo(video)
      addAsset({
        kind: 'photo',
        blob: still.blob,
        mimeType: 'image/jpeg',
        cameraLabel: info?.label ?? 'Camera',
        width: still.width,
        height: still.height,
        snapshot: readSnapshot(),
      })
      setCaptureMessage(
        still.path === 'webcodecs'
          ? 'Photo saved with WebCodecs VideoFrame.'
          : 'Photo saved from the preview.',
      )
    } catch (error) {
      setCaptureMessage(error instanceof Error ? error.message : 'Could not save a JPEG from this frame.')
    }
  }

  useEffect(() => {
    mountedRef.current = true
    const media = navigator.mediaDevices
    if (!media) return

    const onDeviceChange = () => {
      if (!streamRef.current) return
      void readCameras().then((found) => {
        if (!mountedRef.current) return
        setCameras(found)
        const activeId = streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId
        if (activeId && found.length > 0 && !found.some((camera) => camera.deviceId === activeId)) {
          const recorder = recorderRef.current
          if (recorder && recorder.state === 'recording') recorder.stop()
          stopStream()
          rememberLive(null)
          setRecording(false)
          setStatus('error')
          setError('The selected camera is no longer available.')
        }
      })
    }

    media.addEventListener('devicechange', onDeviceChange)
    return () => {
      mountedRef.current = false
      media.removeEventListener('devicechange', onDeviceChange)
      const recorder = recorderRef.current
      if (recorder && recorder.state === 'recording') recorder.stop()
      stopStream()
    }
  }, [])

  useEffect(() => {
    const node = previewRef.current
    if (!node) return
    node.srcObject = stream
    if (!stream) return
    void node.play().catch(() => {
      // Autoplay can reject for a moment while the element is attaching.
    })
  }, [previewRef, stream])

  useEffect(() => {
    if (!recording) return
    const started = Date.now()
    const timer = window.setInterval(() => {
      if (mountedRef.current) setElapsedMs(Date.now() - started)
    }, 200)
    return () => window.clearInterval(timer)
  }, [recording])

  return {
    status,
    error,
    notice,
    cameras,
    selectedId,
    live,
    recording,
    elapsedMs,
    busy,
    captureMessage,
    stream,
    start: () => void openCamera(),
    selectCamera,
    capturePhoto: () => void capturePhoto(),
    toggleRecording,
  }
}
