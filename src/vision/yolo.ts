import { OBJECT_MODEL_ID, ONNX_MODEL_ID } from '../../shared/contracts.ts'
import { COCO_KEYPOINTS, MAX_PEOPLE, type PersonPose } from '../../shared/contracts.ts'
import type { Box, Detection } from '../types.ts'

export { OBJECT_MODEL_ID, ONNX_MODEL_ID }

// MediaPipe, the built-in YOLOv8n, or the id of a custom model in the session.
export type ObjectDetectorId = string

export const YOLO_INPUT = 640
export const YOLO_MODEL_URL =
  'https://cdn.jsdelivr.net/gh/Hyuto/yolov8-onnxruntime-web@fc4a52c466d15ad4519873a0cef22fbc935b93b6/public/model/yolov8n.onnx'

export const COCO_LABELS = [
  'person',
  'bicycle',
  'car',
  'motorcycle',
  'airplane',
  'bus',
  'train',
  'truck',
  'boat',
  'traffic light',
  'fire hydrant',
  'stop sign',
  'parking meter',
  'bench',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'backpack',
  'umbrella',
  'handbag',
  'tie',
  'suitcase',
  'frisbee',
  'skis',
  'snowboard',
  'sports ball',
  'kite',
  'baseball bat',
  'baseball glove',
  'skateboard',
  'surfboard',
  'tennis racket',
  'bottle',
  'wine glass',
  'cup',
  'fork',
  'knife',
  'spoon',
  'bowl',
  'banana',
  'apple',
  'sandwich',
  'orange',
  'broccoli',
  'carrot',
  'hot dog',
  'pizza',
  'donut',
  'cake',
  'chair',
  'couch',
  'potted plant',
  'bed',
  'dining table',
  'toilet',
  'tv',
  'laptop',
  'mouse',
  'remote',
  'keyboard',
  'cell phone',
  'microwave',
  'oven',
  'toaster',
  'sink',
  'refrigerator',
  'book',
  'clock',
  'vase',
  'scissors',
  'teddy bear',
  'hair drier',
  'toothbrush',
] as const

export function letterbox(srcWidth: number, srcHeight: number, size = YOLO_INPUT) {
  const scale = Math.min(size / srcWidth, size / srcHeight)
  const resizedW = Math.round(srcWidth * scale)
  const resizedH = Math.round(srcHeight * scale)
  return {
    scale,
    resizedW,
    resizedH,
    padX: (size - resizedW) / 2,
    padY: (size - resizedH) / 2,
  }
}

function iou(a: Box, b: Box) {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const union = a.width * a.height + b.width * b.height - intersection
  return union <= 0 ? 0 : intersection / union
}

export type DecodeOptions = {
  classes?: readonly number[]
  minScore?: number
  classCount?: number
  labels?: readonly string[]
}

// With the class count known, a YOLOv8 output has 4 + classes rows and YOLOv5 has 5 + classes.
function layoutOf(dims: readonly number[], classCount: number | undefined) {
  if (classCount) {
    for (const extra of [4, 5]) {
      const rows = classCount + extra
      if (dims[1] === rows) return { channelsFirst: true, channels: rows, classOffset: extra }
      if (dims[2] === rows) return { channelsFirst: false, channels: rows, classOffset: extra }
    }
    return null
  }
  const channelsFirst = dims[1] === 84 || dims[1] === 85
  const channels = channelsFirst ? dims[1]! : dims[2]!
  const classOffset = channels === 85 ? 5 : channels >= 84 ? 4 : -1
  return classOffset < 0 ? null : { channelsFirst, channels, classOffset }
}

export function decodeYolo(
  data: Float32Array,
  dims: readonly number[],
  srcWidth: number,
  srcHeight: number,
  inputSize = YOLO_INPUT,
  options: DecodeOptions = {},
): Detection[] {
  const minScore = options.minScore ?? 0.25
  const only = options.classes && options.classes.length > 0 ? options.classes : null
  if (dims.length < 3 || srcWidth < 2 || srcHeight < 2) return []
  const layout = layoutOf(dims, options.classCount)
  if (!layout) return []
  const { channelsFirst, channels, classOffset } = layout
  const anchors = channelsFirst ? dims[2]! : dims[1]!
  const classCount = channels - classOffset
  const labels = options.labels ?? COCO_LABELS
  const at = (anchor: number, channel: number) =>
    channelsFirst ? data[channel * anchors + anchor]! : data[anchor * channels + channel]!
  const fitted = letterbox(srcWidth, srcHeight, inputSize)
  const found: Detection[] = []

  for (let anchor = 0; anchor < anchors; anchor += 1) {
    let bestClass = 0
    let bestScore = 0
    for (let klass = 0; klass < classCount; klass += 1) {
      if (only && !only.includes(klass)) continue
      const score = at(anchor, classOffset + klass)
      if (score > bestScore) {
        bestScore = score
        bestClass = klass
      }
    }
    if (classOffset === 5) bestScore *= at(anchor, 4)
    if (bestScore < minScore) continue
    const cx = at(anchor, 0)
    const cy = at(anchor, 1)
    const width = at(anchor, 2) / fitted.scale
    const height = at(anchor, 3) / fitted.scale
    const x = (cx - at(anchor, 2) / 2 - fitted.padX) / fitted.scale
    const y = (cy - at(anchor, 3) / 2 - fitted.padY) / fitted.scale
    if (width <= 1 || height <= 1) continue
    const box = {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.min(srcWidth, width),
      height: Math.min(srcHeight, height),
    }
    if (box.x >= srcWidth || box.y >= srcHeight) continue
    found.push({
      label: labels[bestClass] ?? `class ${bestClass}`,
      score: bestScore,
      box,
    })
  }

  found.sort((a, b) => b.score - a.score)
  const kept: Detection[] = []
  for (const detection of found) {
    if (kept.some((item) => iou(item.box, detection.box) > 0.45)) continue
    kept.push(detection)
    if (kept.length === 5) break
  }
  return kept
}

const KEYPOINTS = COCO_KEYPOINTS.length
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits

// YOLOv8-pose: per anchor 4 box values, one person score, then x, y, and score for 17 keypoints,
// all in the letterboxed input's pixels.
export function decodeYoloPose(
  data: Float32Array,
  dims: readonly number[],
  srcWidth: number,
  srcHeight: number,
  inputSize = YOLO_INPUT,
  minScore = 0.3,
): PersonPose[] {
  const channels = 5 + KEYPOINTS * 3
  if (dims.length < 3 || srcWidth < 2 || srcHeight < 2) return []
  const channelsFirst = dims[1] === channels
  if (!channelsFirst && dims[2] !== channels) return []
  const anchors = channelsFirst ? dims[2]! : dims[1]!
  const at = (anchor: number, channel: number) =>
    channelsFirst ? data[channel * anchors + anchor]! : data[anchor * channels + channel]!
  const fitted = letterbox(srcWidth, srcHeight, inputSize)
  const toX = (value: number) => (value - fitted.padX) / fitted.scale
  const toY = (value: number) => (value - fitted.padY) / fitted.scale
  const found: PersonPose[] = []
  for (let anchor = 0; anchor < anchors; anchor += 1) {
    const score = at(anchor, 4)
    if (score < minScore) continue
    const w = at(anchor, 2) / fitted.scale
    const h = at(anchor, 3) / fitted.scale
    if (w <= 1 || h <= 1) continue
    const x = Math.max(0, toX(at(anchor, 0) - at(anchor, 2) / 2))
    const y = Math.max(0, toY(at(anchor, 1) - at(anchor, 3) / 2))
    const keypoints: number[] = []
    for (let k = 0; k < KEYPOINTS; k += 1) {
      const base = 5 + k * 3
      keypoints.push(round(toX(at(anchor, base)), 1), round(toY(at(anchor, base + 1)), 1), round(at(anchor, base + 2), 2))
    }
    found.push({
      box: { x: round(x, 1), y: round(y, 1), width: round(Math.min(srcWidth - x, w), 1), height: round(Math.min(srcHeight - y, h), 1) },
      score: round(score, 3),
      keypoints,
    })
  }
  found.sort((a, b) => b.score - a.score)
  const kept: PersonPose[] = []
  for (const person of found) {
    if (kept.some((item) => iou(item.box, person.box) > 0.45)) continue
    kept.push(person)
    if (kept.length === MAX_PEOPLE) break
  }
  return kept
}
