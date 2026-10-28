import {
  FilesetResolver,
  ObjectDetector,
  PoseLandmarker,
  type ObjectDetector as Detector,
  type PoseLandmarker as Landmarker,
} from '@mediapipe/tasks-vision'
import type { Detection, PosePoint } from '../types'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm'
const DETECTOR_MODEL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite'
const POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

export type DelegateName = 'GPU' | 'CPU'

export type Engines = {
  detector: Detector
  pose: Landmarker
  delegate: DelegateName
}

let pending: Promise<Engines> | null = null
let detectorStamp = 0
let poseStamp = 0

function nextStamp(current: number) {
  const now = Math.round(performance.now())
  return Math.max(current + 1, now)
}

async function createEngines(delegate: DelegateName): Promise<Engines> {
  const wasm = await FilesetResolver.forVisionTasks(WASM)
  const canvas = delegate === 'GPU' ? document.createElement('canvas') : undefined
  const detector = await ObjectDetector.createFromOptions(wasm, {
    baseOptions: { modelAssetPath: DETECTOR_MODEL, delegate },
    canvas,
    runningMode: 'VIDEO',
    scoreThreshold: 0.25,
    maxResults: 5,
  })
  try {
    const pose = await PoseLandmarker.createFromOptions(wasm, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      canvas: delegate === 'GPU' ? document.createElement('canvas') : undefined,
      runningMode: 'VIDEO',
      numPoses: 1,
    })
    return { detector, pose, delegate }
  } catch (error) {
    detector.close()
    throw error
  }
}

export function loadEngines() {
  if (!pending) {
    pending = createEngines('GPU').catch(async () => {
      try {
        return await createEngines('CPU')
      } catch (error) {
        pending = null
        throw error
      }
    })
  }
  return pending
}

export function resetEngines() {
  pending = null
}

export function readDetections(engines: Engines, video: HTMLVideoElement) {
  detectorStamp = nextStamp(detectorStamp)
  const started = performance.now()
  const result = engines.detector.detectForVideo(video, detectorStamp)
  const detections: Detection[] = []
  for (const detection of result.detections) {
    const category = detection.categories[0]
    const box = detection.boundingBox
    if (!category || !box || box.width <= 0 || box.height <= 0) continue
    const label = category.categoryName || category.displayName || 'Object'
    const normalized =
      video.videoWidth > 4 &&
      box.originX <= 1 &&
      box.originY <= 1 &&
      box.width <= 1 &&
      box.height <= 1
    detections.push({
      label,
      score: category.score,
      box: normalized
        ? {
            x: box.originX * video.videoWidth,
            y: box.originY * video.videoHeight,
            width: box.width * video.videoWidth,
            height: box.height * video.videoHeight,
          }
        : {
            x: box.originX,
            y: box.originY,
            width: box.width,
            height: box.height,
          },
    })
  }
  return { detections, inferenceMs: performance.now() - started }
}

export function readPose(engines: Engines, video: HTMLVideoElement) {
  poseStamp = nextStamp(poseStamp)
  const started = performance.now()
  const result = engines.pose.detectForVideo(video, poseStamp)
  const pose: PosePoint[] = (result.landmarks[0] ?? []).map((point) => ({
    x: point.x,
    y: point.y,
    visibility: point.visibility ?? 0,
  }))
  return { pose, inferenceMs: performance.now() - started }
}
