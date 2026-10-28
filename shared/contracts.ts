export type MediaKind = 'photo' | 'video'

export type NumericRange = {
  min?: number
  max?: number
}

export type Box = {
  x: number
  y: number
  width: number
  height: number
}

export type Detection = {
  label: string
  score: number
  box: Box
}

export type PosePoint = {
  x: number
  y: number
  z?: number
  visibility: number
}

export type InferencePerformance = {
  processedFps: number
  latencyMs: number
  droppedFrames: number
}

export type AiSnapshot = {
  at: number
  detections: Detection[]
  pose: PosePoint[]
  worldPose?: PosePoint[]
  inferenceMs: number
  performance?: InferencePerformance
}

export const OBJECT_MODEL_ID = 'mediapipe-efficientdet-lite0'
export const POSE_MODEL_ID = 'mediapipe-pose-landmarker-lite'

export type AiModel = {
  id: string
  name: string
  task: 'object-detection' | 'pose'
}

export type Device = {
  id: string
  label: string
  userAgent: string
}

export type CameraCapability = {
  width?: NumericRange
  height?: NumericRange
  frameRate?: NumericRange
  facingModes?: string[]
}

export type CameraRecord = {
  deviceId: string
  label: string
  capability?: CameraCapability
}

export type CaptureSession = {
  id: string
  createdAt: number
  updatedAt: number
  device: Device
  cameras: CameraRecord[]
}

export type InferenceResult = AiSnapshot & {
  objectModelId: string
  poseModelId: string
}

export type SpatialResult = {
  source: 'mediapipe-pose'
  coordinateSpace: 'normalized-image'
  pose: PosePoint[]
  worldPose?: PosePoint[]
}

export type MediaAssetRecord = {
  id: string
  sessionId: string
  kind: MediaKind
  mimeType: string
  createdAt: number
  cameraLabel: string
  width?: number
  height?: number
  byteLength: number
  fileUrl: string
  inference: InferenceResult | null
  spatial: SpatialResult | null
}

export type SessionDetail = CaptureSession & {
  assets: MediaAssetRecord[]
}
