import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  BallTrack,
  CameraRecord,
  CourtCalibration,
  CustomModel,
  MediaAssetRecord,
  SessionDetail,
} from '../../shared/contracts.ts'
import type { MediaAsset, NewMediaAsset } from '../types'
import {
  assetUrl,
  clearRemoteBallTrack,
  clearRemoteCourt,
  deleteRemoteAsset,
  deleteRemoteModel,
  lockSession,
  PrivateSessionError,
  unlockSession,
  fetchSession,
  openSession,
  courtKeyOf,
  deviceId as ownDeviceId,
  readLocalBallTracks,
  readLocalCourts,
  rememberedSessionId,
  rememberSessionId,
  saveCameras,
  saveModelDetails,
  saveRemoteBallTrack,
  saveRemoteCourt,
  snapshotOf,
  thisDevice,
  tracksById,
  uploadAsset,
  uploadModel,
  type ModelDetails,
  writeLocalBallTracks,
  writeLocalCourts,
  type BallTracks,
} from './api'
import { deleteStored, loadStored, saveStored, type StoredAsset } from './db'
import { SessionContext, type BackendStatus } from './context'

type CaptureFields = Pick<MediaAsset, 'deviceId' | 'takeId' | 'startedAt'>

function captureFields(source: CaptureFields): CaptureFields {
  const fields: CaptureFields = {}
  if (source.deviceId) fields.deviceId = source.deviceId
  if (source.takeId) fields.takeId = source.takeId
  if (source.startedAt != null) fields.startedAt = source.startedAt
  return fields
}

function fromLocal(record: StoredAsset, url: string): MediaAsset {
  return {
    ...captureFields(record),
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
    ...captureFields(record),
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

function serverCourts(session: SessionDetail) {
  if (Array.isArray(session.courts)) return session.courts
  return session.court ? [session.court] : []
}

function requestedSessionId() {
  return new URLSearchParams(window.location.search).get('session')
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [ready, setReady] = useState(false)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [locked, setLocked] = useState(false)
  const [courts, setCourtsState] = useState<CourtCalibration[]>([])
  const courtsRef = useRef<CourtCalibration[]>([])
  const [ballTracks, setBallTracksState] = useState<BallTracks>({})
  const [models, setModels] = useState<CustomModel[]>([])
  const [backend, setBackend] = useState<BackendStatus>('offline')
  const assetsRef = useRef(assets)
  const ballTracksRef = useRef<BallTracks>({})
  const uploadsRef = useRef(new Map<string, Promise<void>>())
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
      ...captureFields(asset),
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
      ...captureFields(asset),
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
        ...captureFields({ ...input, deviceId: input.deviceId ?? ownDeviceId() }),
      }
      setAssets((current) => [asset, ...current])
      const upload = rememberAsset(asset, input.blob).then(() => publishRemote(asset, input.blob))
      uploadsRef.current.set(
        asset.id,
        upload.catch(() => undefined).finally(() => uploadsRef.current.delete(asset.id)),
      )
      void upload
        .then(() => setStorageWarning(null))
        .catch((error) => {
          console.error(error)
          setStorageWarning(
            backendRef.current === 'online'
              ? 'Saved in this browser. The server did not keep the file.'
              : 'The server is offline. This file stays in this browser until it is back.',
          )
        })
      return asset.id
    },
    [publishRemote, rememberAsset],
  )

  const publishBallTracks = useCallback((next: BallTracks) => {
    ballTracksRef.current = next
    setBallTracksState(next)
    const id = sessionRef.current
    if (id) writeLocalBallTracks(id, next)
  }, [])

  const setBallTrack = useCallback(
    (assetId: string, track: BallTrack | null) => {
      const next = { ...ballTracksRef.current }
      if (track) next[assetId] = track
      else delete next[assetId]
      publishBallTracks(next)
      if (backendRef.current !== 'online') return
      // A track saved right after a recording has to wait for that video to reach the server.
      const uploaded = uploadsRef.current.get(assetId) ?? Promise.resolve()
      const request = uploaded.then(() => (track ? saveRemoteBallTrack(track) : clearRemoteBallTrack(assetId)))
      void request.catch((error) => {
        console.error(error)
        setStorageWarning('The ball track stays in this browser. The server did not keep it.')
      })
    },
    [publishBallTracks],
  )

  const removeAsset = useCallback((id: string) => {
    if (ballTracksRef.current[id]) {
      const next = { ...ballTracksRef.current }
      delete next[id]
      publishBallTracks(next)
    }
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
  }, [publishBallTracks])

  const publishCourts = useCallback((next: CourtCalibration[]) => {
    courtsRef.current = next
    setCourtsState(next)
    const id = sessionRef.current
    if (id) writeLocalCourts(id, next)
  }, [])

  const setCourt = useCallback((deviceKey: string, next: CourtCalibration | null) => {
    const others = courtsRef.current.filter((court) => courtKeyOf(court) !== deviceKey)
    publishCourts(next ? [next, ...others] : others)
    const id = sessionRef.current
    if (!id || backendRef.current !== 'online') return
    const request = next ? saveRemoteCourt(id, next) : clearRemoteCourt(id, deviceKey)
    void request.catch((error) => {
      console.error(error)
      setStorageWarning('The court stays in this browser. The server did not keep it.')
    })
  }, [publishCourts])

  const makePrivate = useCallback(async () => {
    const id = sessionRef.current
    if (!id || backendRef.current !== 'online') throw new Error('Making a session private needs the server.')
    const session = await lockSession(id)
    setLocked(session.locked)
  }, [])

  const needServer = useCallback(() => {
    const id = sessionRef.current
    if (!id || backendRef.current !== 'online') throw new Error('Custom models need the server.')
    return id
  }, [])

  const addModel = useCallback(
    async (details: ModelDetails, bytes: ArrayBuffer) => {
      const id = crypto.randomUUID()
      const session = await uploadModel(needServer(), id, details, bytes)
      setModels(session.models ?? [])
      return id
    },
    [needServer],
  )

  const editModel = useCallback(
    async (id: string, details: ModelDetails) => {
      needServer()
      setModels((await saveModelDetails(id, details)).models ?? [])
    },
    [needServer],
  )

  const removeModel = useCallback(
    async (id: string) => {
      needServer()
      setModels((await deleteRemoteModel(id)).models ?? [])
    },
    [needServer],
  )

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
          ...captureFields(record),
        })
      }
    }

    async function syncBallTracks(session: SessionDetail) {
      const remote = tracksById(session.ballTracks)
      const assetIds = new Set(session.assets.map((asset) => asset.id))
      for (const track of Object.values(readLocalBallTracks(session.id))) {
        if (remote[track.assetId] || !assetIds.has(track.assetId)) continue
        try {
          await saveRemoteBallTrack(track)
          remote[track.assetId] = track
        } catch (error) {
          console.error(error)
        }
      }
      return remote
    }

    async function boot() {
      const asked = requestedSessionId()
      let id = asked || rememberedSessionId() || crypto.randomUUID()
      let notice: string | null = null
      try {
        const sharedKey = asked ? new URLSearchParams(window.location.search).get('key') : null
        let existing = null
        if (asked) {
          try {
            existing = sharedKey ? await unlockSession(id, sharedKey) : await fetchSession(id)
          } catch (error) {
            if (!(error instanceof PrivateSessionError) || !active) throw error
            setStorageWarning(
              sharedKey
                ? 'That link has the wrong session key.'
                : 'This session is private. Open it with its full link, which includes the key.',
            )
            setBackend('online')
            backendRef.current = 'online'
            setReady(true)
            return
          }
          // The key is now a cookie, so it should not stay in the address bar or browser history.
          if (sharedKey) {
            const clean = new URL(window.location.href)
            clean.searchParams.delete('key')
            window.history.replaceState(null, '', clean)
          }
        }
        if (asked && !existing) {
          if (!active) return
          setStorageWarning('That session was not found on the server.')
          setBackend('online')
          backendRef.current = 'online'
          setReady(true)
          return
        }
        let session = existing
        if (!session) {
          try {
            session = await openSession(id, thisDevice())
          } catch (error) {
            // This browser lost the key to its last session, so it starts a new one.
            if (!(error instanceof PrivateSessionError)) throw error
            id = crypto.randomUUID()
            session = await openSession(id, thisDevice())
            notice = 'Your last session is private and this browser no longer has its key, so a new one was started.'
          }
        }
        if (!active) return
        setLocked(session.locked)
        rememberSessionId(session.id)
        sessionRef.current = session.id
        setSessionId(session.id)
        setBackend('online')
        backendRef.current = 'online'
        const remoteIds = new Set(session.assets.map((asset) => asset.id))
        let latest = session
        try {
          await syncLocal(session.id, remoteIds)
          latest = (await fetchSession(session.id)) ?? session
          const tracks = await syncBallTracks(latest)
          if (!active) return
          setAssets(latest.assets.map((asset) => fromServer(asset)))
          publishCourts(serverCourts(latest))
          publishBallTracks(tracks)
          setModels(latest.models ?? [])
          setStorageWarning(notice)
        } catch (error) {
          if (!active) return
          console.error(error)
          setAssets(latest.assets.map((asset) => fromServer(asset)))
          publishCourts(serverCourts(latest))
          setModels(latest.models ?? [])
          publishBallTracks({ ...readLocalBallTracks(session.id), ...tracksById(latest.ballTracks) })
          setStorageWarning('Some files saved in this browser have not reached the server yet.')
        }
      } catch (error) {
        if (!active) return
        console.error(error)
        sessionRef.current = id
        if (!asked) {
          rememberSessionId(id)
          setSessionId(id)
        }
        setBackend('offline')
        backendRef.current = 'offline'
        publishCourts(readLocalCourts(id))
        publishBallTracks(readLocalBallTracks(id))
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
  }, [publishBallTracks, publishCourts])

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
      locked,
      courts,
      ballTracks,
      models,
      backend,
      addAsset,
      removeAsset,
      noteCameras,
      setCourt,
      makePrivate,
      setBallTrack,
      addModel,
      editModel,
      removeModel,
    }),
    [
      assets,
      ready,
      storageWarning,
      sessionId,
      locked,
      courts,
      ballTracks,
      models,
      backend,
      addAsset,
      removeAsset,
      noteCameras,
      setCourt,
      makePrivate,
      setBallTrack,
      addModel,
      editModel,
      removeModel,
    ],
  )

  return (
    <SessionContext.Provider value={value}>
      {ready ? children : <p className="booting">Opening the shared session…</p>}
    </SessionContext.Provider>
  )
}
