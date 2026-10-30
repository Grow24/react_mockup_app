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

// COCO keypoint order, used by YOLOv8-pose.
export const COCO_KEYPOINTS = [
  'nose',
  'left eye',
  'right eye',
  'left ear',
  'right ear',
  'left shoulder',
  'right shoulder',
  'left elbow',
  'right elbow',
  'left wrist',
  'right wrist',
  'left hip',
  'right hip',
  'left knee',
  'right knee',
  'left ankle',
  'right ankle',
] as const

// One person from a multi-person pose model. keypoints is [x, y, score] for each COCO keypoint,
// in source pixels. player is 'near' or 'far' (with -2 for a doubles partner) once placed on the court.
export type PersonPose = {
  box: Box
  score: number
  keypoints: number[]
  player?: string
}

export type AiSnapshot = {
  at: number
  detections: Detection[]
  pose: PosePoint[]
  worldPose?: PosePoint[]
  people?: PersonPose[]
  inferenceMs: number
  performance?: InferencePerformance
  objectModelId?: string
}

export const OBJECT_MODEL_ID = 'mediapipe-efficientdet-lite0'
export const ONNX_MODEL_ID = 'yolov8n-coco-onnx'
export const POSE_MODEL_ID = 'mediapipe-pose-landmarker-lite'
export const PEOPLE_MODEL_ID = 'yolov8n-pose-onnx'
export const MAX_PEOPLE = 8

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
  // Ids from COURT_LANDMARKS in shared/court.ts, one per image point. Missing means the outer corners.
  landmarks?: string[]
  // An id from COURT_AREAS: the part of the court that counts as in.
  callArea?: string
  // How many of the last image points were estimated (from three clicks and a level phone), not clicked.
  // Estimated points may lie outside the photo.
  estimatedPoints?: number
}

export const COURT_PRESETS: Record<CourtPreset, { label: string; widthMeters: number; lengthMeters: number }> = {
  'tennis-doubles': { label: 'Tennis court', widthMeters: 10.97, lengthMeters: 23.77 },
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

// 11 minutes at 30 frames per second.
export const BALL_TRACK_LIMIT = 20000

export type PoseFrame = { t: number; people: PersonPose[] }

// The players' joints through a video, sampled like a ball track.
export type PoseTrack = {
  assetId: string
  modelId: string
  sourceWidth: number
  sourceHeight: number
  sampleFps: number
  duration: number
  createdAt: number
  frames: PoseFrame[]
}

// Two minutes at 30 frames per second.
export const POSE_TRACK_LIMIT = 3700

export type ExerciseKind = 'strength' | 'bodyweight' | 'cardio' | 'timed'

export type Exercise = {
  id: string
  name: string
  kind: ExerciseKind
  muscles: string[]
  equipment: string
  cue: string
  builtIn?: boolean
}

export type WorkoutSet = {
  id: string
  reps?: number
  weightKg?: number
  seconds?: number
  meters?: number
  rpe?: number
  done: boolean
  doneAt?: number
}

export type WorkoutEntry = {
  id: string
  exerciseId: string
  sets: WorkoutSet[]
  note?: string
}

export type Workout = {
  id: string
  name: string
  startedAt: number
  finishedAt?: number
  updatedAt: number
  entries: WorkoutEntry[]
  note?: string
}

export type WorkoutBook = {
  workouts: Workout[]
  exercises: Exercise[]
}

export const WORKOUT_LIMITS = { entries: 60, sets: 60, text: 200, workouts: 5000, exercises: 500 } as const

// A labeled box in a training image, in that image's pixels.
export type TrainingBox = { classId: number; x: number; y: number; width: number; height: number }

export type TrainingSplit = 'train' | 'val'

export type TrainingImage = {
  id: string
  sessionId: string
  sourceAssetId?: string
  frameTime?: number
  width: number
  height: number
  createdAt: number
  boxes: TrainingBox[]
  split: TrainingSplit
  fileUrl: string
}

export type TrainingSet = {
  classes: string[]
  images: TrainingImage[]
}

export const TRAINING_LIMITS = { classes: 100, boxes: 300, images: 5000, imageBytes: 20 * 1024 * 1024 } as const

export type SessionDetail = CaptureSession & {
  /** True once the session has a key; without it nothing in the session can be read or changed. */
  locked: boolean
  /** Sent once, when the session is created or made private. Keep it to share or reopen the session. */
  key?: string
  assets: MediaAssetRecord[]
  court: CourtCalibration | null
  courts: CourtCalibration[]
  ballTracks: BallTrack[]
  poseTracks: PoseTrack[]
  models: CustomModel[]
}
