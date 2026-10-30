import type {
  AiSnapshot,
  Box,
  Detection,
  InferencePerformance,
  MediaKind,
  NumericRange,
  PosePoint,
} from '../shared/contracts.ts'

export type {
  AiSnapshot,
  Box,
  Detection,
  InferencePerformance,
  MediaKind,
  NumericRange,
  PosePoint,
}

export type MediaAsset = {
  id: string
  kind: MediaKind
  url: string
  mimeType: string
  createdAt: number
  cameraLabel: string
  width?: number
  height?: number
  snapshot?: AiSnapshot
  deviceId?: string
  takeId?: string
  startedAt?: number
}

export type NewMediaAsset = {
  kind: MediaKind
  blob: Blob
  mimeType: string
  cameraLabel: string
  width?: number
  height?: number
  snapshot?: AiSnapshot | null
  deviceId?: string
  takeId?: string
  startedAt?: number
}

export type CameraInfo = {
  deviceId: string
  label: string
}

export type LiveCamera = {
  deviceId: string
  label: string
  width?: number
  height?: number
  frameRate?: number
  facingMode?: string
  widthRange?: NumericRange
  heightRange?: NumericRange
  frameRateRange?: NumericRange
  facingModes?: string[]
}

export type CameraStatus = 'idle' | 'requesting' | 'live' | 'denied' | 'error'
