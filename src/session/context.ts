import { createContext, useContext } from 'react'
import type { MediaAsset, NewMediaAsset } from '../types'

export type SessionValue = {
  assets: MediaAsset[]
  addAsset: (input: NewMediaAsset) => void
  removeAsset: (id: string) => void
}

export const SessionContext = createContext<SessionValue | null>(null)

export function useSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession must be used within SessionProvider')
  return session
}
