import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { PersonPose } from '../../shared/contracts.ts'
import { courtsFor, deviceId } from '../session/api'
import { useSession } from '../session/context'
import type { Detection, PosePoint } from '../types'
import { useAi } from './context'
import { readDetections, readPose } from './engine'
import type { FramePixels, LiveRoster } from './livePlayers'
import { detectPeople, detectSource } from './onnxDetector'
import { emptyPerformance, noteInference } from './performance'
import { assignPlayers, holdRackets } from './players'

// Clothes colors are read from the preview at this long side.
const LOOK_SIDE = 640
const RACKET_SCORE = 0.2

export function useLiveAnalysis(
  videoRef: RefObject<HTMLVideoElement | null>,
  active: boolean,
  // Collects the lettered players on the live ball's clock when given.
  roster?: LiveRoster,
) {
  const { engines, confidence, objectDetector, objectModel, poseMode, publish } = useAi()
  const { courts } = useSession()
  const confidenceRef = useRef(confidence)
  const detectorRef = useRef(objectDetector)
  const modelRef = useRef(objectModel)
  const poseModeRef = useRef(poseMode)
  const courtsRef = useRef(courtsFor(courts, deviceId()))

  useEffect(() => {
    confidenceRef.current = confidence
    detectorRef.current = objectDetector
    modelRef.current = objectModel
    poseModeRef.current = poseMode
    courtsRef.current = courtsFor(courts, deviceId())
  }, [confidence, objectDetector, objectModel, poseMode, courts])

  useEffect(() => {
    if (!active || !engines) return
    const video = videoRef.current
    if (!video) return

    let stopped = false
    let timer = 0
    let mode: 'pose' | 'detect' = 'pose'
    let detections: Detection[] = []
    let pose: PosePoint[] = []
    let worldPose: PosePoint[] = []
    let people: PersonPose[] = []
    let inferenceMs = 0
    let presented = 0
    let perf = emptyPerformance()
    const look = document.createElement('canvas')
    const lookContext = look.getContext('2d', { willReadFrequently: true })

    const countFrame = () => {
      if (stopped) return
      presented += 1
      video.requestVideoFrameCallback(countFrame)
    }
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(countFrame)
    }

    // The frame's pixels, read before the detector runs so the colors match where it finds people.
    const grab = (width: number, height: number): FramePixels | null => {
      if (!roster || !lookContext) return null
      const scale = Math.min(1, LOOK_SIDE / Math.max(width, height))
      const lookWidth = Math.max(1, Math.round(width * scale))
      const lookHeight = Math.max(1, Math.round(height * scale))
      if (look.width !== lookWidth || look.height !== lookHeight) {
        look.width = lookWidth
        look.height = lookHeight
      }
      lookContext.drawImage(video, 0, 0, lookWidth, lookHeight)
      return { pixels: lookContext.getImageData(0, 0, lookWidth, lookHeight).data, width: lookWidth, height: lookHeight, scale }
    }

    const tick = async () => {
      if (stopped) return
      if (document.hidden || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
        timer = window.setTimeout(tick, 200)
        return
      }

      const started = performance.now()
      try {
        if (mode === 'pose' && poseModeRef.current === 'people') {
          const width = video.videoWidth
          const height = video.videoHeight
          const pixels = grab(width, height)
          const reading = await detectPeople(video, width, height)
          if (stopped) return
          if (!reading) {
            timer = window.setTimeout(tick, 40)
            return
          }
          const watched = courtsRef.current
          const rackets = detections.filter((item) => item.label === 'tennis racket' && item.score >= RACKET_SCORE)
          const placed = holdRackets(assignPlayers(reading.people, watched, width, height), rackets)
          people = roster ? roster.add(started / 1000, placed, pixels, watched, width, height) : placed
          pose = []
          worldPose = []
          inferenceMs = reading.inferenceMs
          mode = 'detect'
        } else if (mode === 'pose') {
          const reading = readPose(engines, video)
          pose = reading.pose
          worldPose = reading.worldPose
          people = []
          inferenceMs = reading.inferenceMs
          mode = 'detect'
        } else if (modelRef.current) {
          const reading = await detectSource(video, video.videoWidth, video.videoHeight, { model: modelRef.current })
          if (stopped) return
          if (!reading) {
            timer = window.setTimeout(tick, 40)
            return
          }
          detections = reading.detections
          inferenceMs = reading.inferenceMs
          mode = 'pose'
        } else {
          const reading = readDetections(engines, video)
          detections = reading.detections
          inferenceMs = reading.inferenceMs
          mode = 'pose'
        }
        const noted = noteInference(perf, performance.now(), inferenceMs, presented)
        perf = noted.state
        const floor = confidenceRef.current
        publish({
          at: Date.now(),
          detections: detections.filter((item) => item.score >= floor),
          pose,
          worldPose,
          ...(people.length > 0 ? { people } : {}),
          inferenceMs,
          performance: noted.sample,
          objectModelId: detectorRef.current,
        })
      } catch (error) {
        console.error(error)
      }

      if (stopped) return
      const wait = Math.max(40, 160 - (performance.now() - started))
      timer = window.setTimeout(tick, wait)
    }

    timer = window.setTimeout(tick, 0)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [active, engines, publish, videoRef, roster])
}
