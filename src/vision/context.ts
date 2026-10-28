import { createContext, useContext } from 'react'
import type { AiSnapshot } from '../types'
import type { DelegateName, Engines } from './engine'

export type AiStatus = 'off' | 'loading' | 'ready' | 'error'

export type AiValue = {
  enabled: boolean
  confidence: number
  status: AiStatus
  error: string | null
  delegate: DelegateName | null
  latest: AiSnapshot | null
  engines: Engines | null
  setEnabled: (enabled: boolean) => void
  setConfidence: (confidence: number) => void
  retry: () => void
  publish: (snapshot: AiSnapshot) => void
  readSnapshot: () => AiSnapshot | null
}

export const AiContext = createContext<AiValue | null>(null)

export function useAi() {
  const ai = useContext(AiContext)
  if (!ai) throw new Error('useAi must be used within AiProvider')
  return ai
}
