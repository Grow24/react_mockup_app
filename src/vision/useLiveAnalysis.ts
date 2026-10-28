import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { Detection, PosePoint } from '../types'
import { useAi } from './context'
import { readDetections, readPose } from './engine'
import { emptyPerformance, noteInference } from './performance'

export function useLiveAnalysis(
  videoRef: RefObject<HTMLVideoElement | null>,
  active: boolean,
) {
  const { engines, confidence, publish } = useAi()
  const confidenceRef = useRef(confidence)

  useEffect(() => {
    confidenceRef.current = confidence
  }, [confidence])

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

    const tick = () => {
      if (stopped) return
      if (document.hidden || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
        timer = window.setTimeout(tick, 200)
        return
      }

      const started = performance.now()
      try {
        if (mode === 'pose') {
          const reading = readPose(engines, video)
          pose = reading.pose
          worldPose = reading.worldPose
          inferenceMs = reading.inferenceMs
          mode = 'detect'
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
          inferenceMs,
          performance: noted.sample,
        })
      } catch (error) {
        console.error(error)
      }

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
