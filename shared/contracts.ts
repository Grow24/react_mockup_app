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
  objectModelId?: string
}

export const OBJECT_MODEL_ID = 'mediapipe-efficientdet-lite0'
export const ONNX_MODEL_ID = 'yolov8n-coco-onnx'
export const POSE_MODEL_ID = 'mediapipe-pose-landmarker-lite'

export type AiModel = {
  id: string
  name: string
  task: 'object-detection' | 'pose'
}

// A YOLOv8 or YOLOv5 ONNX export, for example from Roboflow or Ultralytics, shared in one session.
export type CustomModel = {
  id: string
  sessionId: string
  name: string
  inputSize: number
  labels: string[]
  ballClasses: number[]
  byteLength: number
  createdAt: number
  fileUrl: string
}

export const MAX_MODEL_BYTES = 200 * 1024 * 1024

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
  deviceId?: string
  takeId?: string
  startedAt?: number
}

export type Take = {
  id: string
  sessionId: string
  startAt: number
  seconds: number
  createdAt: number
  createdBy: string
}

export const TAKE_LEAD_MS = 2500
export const TAKE_SECONDS = [5, 10, 20] as const

export type CourtPreset = 'tennis-doubles' | 'cricket-pitch'

export type CourtPoint = {
  x: number
  y: number
}

export type CourtCalibration = {
  preset: CourtPreset
  assetId: string
  deviceId?: string
  sourceWidth: number
  sourceHeight: number
  imagePoints: CourtPoint[]
}

export const COURT_PRESETS: Record<CourtPreset, { label: string; widthMeters: number; lengthMeters: number }> = {
  'tennis-doubles': { label: 'Tennis doubles', widthMeters: 10.97, lengthMeters: 23.77 },
  'cricket-pitch': { label: 'Cricket pitch', widthMeters: 3.05, lengthMeters: 20.12 },
}

export const SPORTS_BALL_CLASS = 32

export type BallPoint = {
  t: number
  x: number
  y: number
  radius: number
  score: number
  bounce?: boolean
}

export type BallTrack = {
  assetId: string
  modelId: string
  sourceWidth: number
  sourceHeight: number
  sampleFps: number
  duration: number
  createdAt: number
  points: BallPoint[]
  live?: boolean
}

export const BALL_TRACK_LIMIT = 5000

export type SessionDetail = CaptureSession & {
  assets: MediaAssetRecord[]
  court: CourtCalibration | null
  courts: CourtCalibration[]
  ballTracks: BallTrack[]
  models: CustomModel[]
}
