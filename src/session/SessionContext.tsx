import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MediaAsset, NewMediaAsset } from '../types'
import { SessionContext } from './context'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const assetsRef = useRef(assets)

  const addAsset = useCallback((input: NewMediaAsset) => {
    const asset: MediaAsset = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    }
    setAssets((current) => [asset, ...current])
  }, [])

  const removeAsset = useCallback((id: string) => {
    setAssets((current) => {
      const target = current.find((asset) => asset.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return current.filter((asset) => asset.id !== id)
    })
  }, [])

  useEffect(() => {
    assetsRef.current = assets
  }, [assets])

  useEffect(() => {
    return () => {
      for (const asset of assetsRef.current) URL.revokeObjectURL(asset.url)
    }
  }, [])

  const value = useMemo(
    () => ({ assets, addAsset, removeAsset }),
    [assets, addAsset, removeAsset],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
