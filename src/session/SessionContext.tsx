import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CameraRecord, MediaAssetRecord } from '../../shared/contracts.ts'
import type { MediaAsset, NewMediaAsset } from '../types'
import {
  assetUrl,
  deleteRemoteAsset,
  fetchSession,
  openSession,
  rememberedSessionId,
  rememberSessionId,
  saveCameras,
  snapshotOf,
  thisDevice,
  uploadAsset,
} from './api'
import { deleteStored, loadStored, saveStored, type StoredAsset } from './db'
import { SessionContext, type BackendStatus } from './context'

function fromLocal(record: StoredAsset, url: string): MediaAsset {
  return {
    id: record.id,
    kind: record.kind,
    url,
    mimeType: record.mimeType,
    createdAt: record.createdAt,
    cameraLabel: record.cameraLabel,
    width: record.width,
    height: record.height,
    snapshot: record.snapshot,
  }
}

function fromServer(record: MediaAssetRecord): MediaAsset {
  return {
    id: record.id,
    kind: record.kind,
    url: assetUrl(record),
    mimeType: record.mimeType,
    createdAt: record.createdAt,
    cameraLabel: record.cameraLabel,
    width: record.width,
    height: record.height,
    snapshot: snapshotOf(record),
  }
}

function requestedSessionId() {
  return new URLSearchParams(window.location.search).get('session')
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [ready, setReady] = useState(false)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [backend, setBackend] = useState<BackendStatus>('offline')
  const assetsRef = useRef(assets)
  const sessionRef = useRef<string | null>(null)
  const camerasRef = useRef('')
  const backendRef = useRef<BackendStatus>('offline')

  const rememberAsset = useCallback((asset: MediaAsset, blob: Blob) => {
    const record: StoredAsset = {
      id: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      createdAt: asset.createdAt,
      cameraLabel: asset.cameraLabel,
      blob,
    }
    if (asset.width) record.width = asset.width
    if (asset.height) record.height = asset.height
    if (asset.snapshot) record.snapshot = asset.snapshot
    return saveStored(record)
  }, [])

  const publishRemote = useCallback(async (asset: MediaAsset, blob: Blob) => {
    const id = sessionRef.current
    if (!id || backendRef.current !== 'online') return
    await uploadAsset(id, {
      id: asset.id,
      kind: asset.kind,
      blob,
      mimeType: asset.mimeType,
      createdAt: asset.createdAt,
      cameraLabel: asset.cameraLabel,
      width: asset.width,
      height: asset.height,
      snapshot: asset.snapshot,
    })
  }, [])

  const addAsset = useCallback(
    (input: NewMediaAsset) => {
      const asset: MediaAsset = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        kind: input.kind,
        url: URL.createObjectURL(input.blob),
        mimeType: input.mimeType,
        cameraLabel: input.cameraLabel,
        width: input.width,
        height: input.height,
        snapshot: input.snapshot ?? undefined,
      }
      setAssets((current) => [asset, ...current])
      void rememberAsset(asset, input.blob)
        .then(() => publishRemote(asset, input.blob))
        .then(() => setStorageWarning(null))
        .catch((error) => {
          console.error(error)
          setStorageWarning(
            backendRef.current === 'online'
              ? 'Saved in this browser. The server did not keep the file.'
              : 'The server is offline. This file stays in this browser until it is back.',
          )
        })
    },
    [publishRemote, rememberAsset],
  )

  const removeAsset = useCallback((id: string) => {
    setAssets((current) => {
      const target = current.find((asset) => asset.id === id)
      if (target?.url.startsWith('blob:')) URL.revokeObjectURL(target.url)
      return current.filter((asset) => asset.id !== id)
    })
    void deleteStored(id).catch((error) => console.error(error))
    if (backendRef.current === 'online') {
      void deleteRemoteAsset(id).catch((error) => {
        console.error(error)
        setStorageWarning('Removed here, but the server copy may still be there.')
      })
    }
  }, [])

  const noteCameras = useCallback((cameras: CameraRecord[]) => {
    const id = sessionRef.current
    if (!id || backendRef.current !== 'online') return
    const encoded = JSON.stringify(cameras)
    if (encoded === camerasRef.current) return
    camerasRef.current = encoded
    void saveCameras(id, cameras).catch((error) => console.error(error))
  }, [])

  useEffect(() => {
    assetsRef.current = assets
  }, [assets])

  useEffect(() => {
    let active = true

    async function localAssets() {
      const records = await loadStored()
      return records
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((record) => fromLocal(record, URL.createObjectURL(record.blob)))
    }

    async function syncLocal(id: string, remoteIds: Set<string>) {
      const records = await loadStored()
      for (const record of records) {
        if (remoteIds.has(record.id)) continue
        await uploadAsset(id, {
          id: record.id,
          kind: record.kind,
          blob: record.blob,
          mimeType: record.mimeType,
          createdAt: record.createdAt,
          cameraLabel: record.cameraLabel,
          width: record.width,
          height: record.height,
          snapshot: record.snapshot,
        })
      }
    }

    async function boot() {
      const asked = requestedSessionId()
      const id = asked || rememberedSessionId() || crypto.randomUUID()
      try {
        const existing = asked ? await fetchSession(id) : null
        if (asked && !existing) {
          if (!active) return
          setStorageWarning('That session was not found on the server.')
          setBackend('online')
          backendRef.current = 'online'
          setReady(true)
          return
        }
        const session = existing ?? (await openSession(id, thisDevice()))
        if (!active) return
        rememberSessionId(session.id)
        sessionRef.current = session.id
        setSessionId(session.id)
        setBackend('online')
        backendRef.current = 'online'
        const remoteIds = new Set(session.assets.map((asset) => asset.id))
        let records = session.assets
        try {
          await syncLocal(session.id, remoteIds)
          const fresh = await fetchSession(session.id)
          if (fresh) records = fresh.assets
          if (!active) return
          setAssets(records.map((asset) => fromServer(asset)))
          setStorageWarning(null)
        } catch (error) {
          if (!active) return
          console.error(error)
          setAssets(records.map((asset) => fromServer(asset)))
          setStorageWarning('Some files saved in this browser have not reached the server yet.')
        }
      } catch (error) {
        if (!active) return
        console.error(error)
        sessionRef.current = asked ? null : id
        if (!asked) {
          rememberSessionId(id)
          setSessionId(id)
        }
        setBackend('offline')
        backendRef.current = 'offline'
        try {
          setAssets(await localAssets())
          setStorageWarning('The server is offline. Captures stay in this browser until it is back.')
        } catch (localError) {
          console.error(localError)
          setStorageWarning('Saved photos could not be opened.')
        }
      } finally {
        if (active) setReady(true)
      }
    }

    void boot()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    return () => {
      for (const asset of assetsRef.current) {
        if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url)
      }
    }
  }, [])

  const value = useMemo(
    () => ({
      assets,
      ready,
      storageWarning,
      sessionId,
      backend,
      addAsset,
      removeAsset,
      noteCameras,
    }),
    [assets, ready, storageWarning, sessionId, backend, addAsset, removeAsset, noteCameras],
  )

  return (
    <SessionContext.Provider value={value}>
      {ready ? children : <p className="booting">Opening the shared session…</p>}
    </SessionContext.Provider>
  )
}
