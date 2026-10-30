import { createContext, useContext } from 'react'
import type { BallTrack, CameraRecord, CourtCalibration, CustomModel } from '../../shared/contracts.ts'
import type { ModelDetails } from './api'
import type { MediaAsset, NewMediaAsset } from '../types'

export type BackendStatus = 'online' | 'offline'

export type SessionValue = {
  assets: MediaAsset[]
  ready: boolean
  storageWarning: string | null
  sessionId: string | null
  backend: BackendStatus
  courts: CourtCalibration[]
  ballTracks: Record<string, BallTrack>
  models: CustomModel[]
  addAsset: (input: NewMediaAsset) => string
  removeAsset: (id: string) => void
  noteCameras: (cameras: CameraRecord[]) => void
  setCourt: (deviceKey: string, court: CourtCalibration | null) => void
  setBallTrack: (assetId: string, track: BallTrack | null) => void
  addModel: (details: ModelDetails, bytes: ArrayBuffer) => Promise<string>
  editModel: (id: string, details: ModelDetails) => Promise<void>
  removeModel: (id: string) => Promise<void>
}

export const SessionContext = createContext<SessionValue | null>(null)

export function useSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession must be used within SessionProvider')
  return session
}
