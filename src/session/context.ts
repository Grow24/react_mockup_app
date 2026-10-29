import { createContext, useContext } from 'react'
import type { BallTrack, CameraRecord, CourtCalibration } from '../../shared/contracts.ts'
import type { MediaAsset, NewMediaAsset } from '../types'

export type BackendStatus = 'online' | 'offline'

export type SessionValue = {
  assets: MediaAsset[]
  ready: boolean
  storageWarning: string | null
  sessionId: string | null
  backend: BackendStatus
  court: CourtCalibration | null
  ballTracks: Record<string, BallTrack>
  addAsset: (input: NewMediaAsset) => string
  removeAsset: (id: string) => void
  noteCameras: (cameras: CameraRecord[]) => void
  setCourt: (court: CourtCalibration | null) => void
  setBallTrack: (assetId: string, track: BallTrack | null) => void
}

export const SessionContext = createContext<SessionValue | null>(null)

export function useSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession must be used within SessionProvider')
  return session
}
