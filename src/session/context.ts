import { createContext, useContext } from 'react'
import type { CameraRecord } from '../../shared/contracts.ts'
import type { MediaAsset, NewMediaAsset } from '../types'

export type BackendStatus = 'online' | 'offline'

export type SessionValue = {
  assets: MediaAsset[]
  ready: boolean
  storageWarning: string | null
  sessionId: string | null
  backend: BackendStatus
  addAsset: (input: NewMediaAsset) => void
  removeAsset: (id: string) => void
  noteCameras: (cameras: CameraRecord[]) => void
}

export const SessionContext = createContext<SessionValue | null>(null)

export function useSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession must be used within SessionProvider')
  return session
}
