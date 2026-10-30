import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { PersonPose } from '../../shared/contracts.ts'
import { courtFor, deviceId } from '../session/api'
import { useSession } from '../session/context'
import type { Detection, PosePoint } from '../types'
import { useAi } from './context'
import { readDetections, readPose } from './engine'
import { detectPeople, detectSource } from './onnxDetector'
import { emptyPerformance, noteInference } from './performance'
import { assignPlayers } from './players'

export function useLiveAnalysis(
  videoRef: RefObject<HTMLVideoElement | null>,
  active: boolean,
) {
  const { engines, confidence, objectDetector, objectModel, poseMode, publish } = useAi()
  const { courts } = useSession()
  const confidenceRef = useRef(confidence)
  const detectorRef = useRef(objectDetector)
  const modelRef = useRef(objectModel)
  const poseModeRef = useRef(poseMode)
  const courtRef = useRef(courtFor(courts, deviceId()))

  useEffect(() => {
    confidenceRef.current = confidence
    detectorRef.current = objectDetector
    modelRef.current = objectModel
    poseModeRef.current = poseMode
    courtRef.current = courtFor(courts, deviceId())
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

    const countFrame = () => {
      if (stopped) return
      presented += 1
      video.requestVideoFrameCallback(countFrame)
    }
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(countFrame)
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
          const reading = await detectPeople(video, video.videoWidth, video.videoHeight)
          if (stopped) return
          if (!reading) {
            timer = window.setTimeout(tick, 40)
            return
          }
          people = assignPlayers(reading.people, courtRef.current, video.videoWidth, video.videoHeight)
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
  }, [active, engines, publish, videoRef])
}
