export type MediaKind = 'photo' | 'video'

export type MediaAsset = {
  id: string
  kind: MediaKind
  url: string
  mimeType: string
  createdAt: number
  cameraLabel: string
  width?: number
  height?: number
}

export type NewMediaAsset = Omit<MediaAsset, 'id' | 'createdAt'>

export type CameraInfo = {
  deviceId: string
  label: string
}

export type NumericRange = {
  min?: number
  max?: number
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
