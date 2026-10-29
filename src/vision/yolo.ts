import { OBJECT_MODEL_ID, ONNX_MODEL_ID } from '../../shared/contracts.ts'
import type { Box, Detection } from '../types'

export { OBJECT_MODEL_ID, ONNX_MODEL_ID }

export type ObjectDetectorId = typeof OBJECT_MODEL_ID | typeof ONNX_MODEL_ID

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

export function decodeYolo(
  data: Float32Array,
  dims: readonly number[],
  srcWidth: number,
  srcHeight: number,
  inputSize = YOLO_INPUT,
): Detection[] {
  if (dims.length < 3 || srcWidth < 2 || srcHeight < 2) return []
  const channelsFirst = dims[1] === 84 || dims[1] === 85
  const anchors = channelsFirst ? dims[2]! : dims[1]!
  const channels = channelsFirst ? dims[1]! : dims[2]!
  const classOffset = channels === 85 ? 5 : channels >= 84 ? 4 : -1
  if (classOffset < 0) return []
  const classCount = channels - classOffset
  const at = (anchor: number, channel: number) =>
    channelsFirst ? data[channel * anchors + anchor]! : data[anchor * channels + channel]!
  const fitted = letterbox(srcWidth, srcHeight, inputSize)
  const found: Detection[] = []

  for (let anchor = 0; anchor < anchors; anchor += 1) {
    let bestClass = 0
    let bestScore = 0
    for (let klass = 0; klass < classCount; klass += 1) {
      const score = at(anchor, classOffset + klass)
      if (score > bestScore) {
        bestScore = score
        bestClass = klass
      }
    }
    if (classOffset === 5) bestScore *= at(anchor, 4)
    if (bestScore < 0.25) continue
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
      label: COCO_LABELS[bestClass] ?? 'object',
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
