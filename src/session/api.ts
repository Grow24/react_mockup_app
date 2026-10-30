import type {
  AiSnapshot,
  BallTrack,
  CameraRecord,
  CourtCalibration,
  CustomModel,
  Device,
  MediaAssetRecord,
  SessionDetail,
  Take,
} from '../../shared/contracts.ts'

const SESSION_KEY = 'pbmp-session-id'
const DEVICE_KEY = 'pbmp-device-id'

export function deviceId() {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing) return existing
    const created = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

export function rememberedSessionId() {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

export function rememberSessionId(id: string) {
  try {
    localStorage.setItem(SESSION_KEY, id)
  } catch {
    // The session link still works for this visit.
  }
}

export function thisDevice(): Device {
  return {
    id: deviceId(),
    label: 'This browser',
    userAgent: navigator.userAgent.slice(0, 300),
  }
}

async function errorText(response: Response) {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error || response.statusText
  } catch {
    return response.statusText
  }
}

export async function openSession(id: string, device: Device) {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, device }),
  })
  if (!response.ok) throw new Error(await errorText(response))
  return (await response.json()) as SessionDetail
}

export async function fetchSession(id: string) {
  const response = await fetch(`/api/sessions/${id}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(await errorText(response))
  return (await response.json()) as SessionDetail
}

export async function saveCameras(sessionId: string, cameras: CameraRecord[]) {
  const response = await fetch(`/api/sessions/${sessionId}/cameras`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameras }),
  })
  if (!response.ok) throw new Error(await errorText(response))
}

export async function uploadAsset(
  sessionId: string,
  asset: {
    id: string
    kind: 'photo' | 'video'
    blob: Blob
    mimeType: string
    createdAt: number
    cameraLabel: string
    width?: number
    height?: number
    snapshot?: AiSnapshot
    deviceId?: string
    takeId?: string
    startedAt?: number
  },
) {
  const form = new FormData()
  const extension = asset.mimeType.includes('png')
    ? 'png'
    : asset.kind === 'photo'
      ? 'jpg'
      : 'webm'
  form.set('file', asset.blob, `${asset.kind}.${extension}`)
  form.set(
    'meta',
    JSON.stringify({
      id: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      createdAt: asset.createdAt,
      cameraLabel: asset.cameraLabel,
      width: asset.width,
      height: asset.height,
      snapshot: asset.snapshot ?? null,
      deviceId: asset.deviceId,
      takeId: asset.takeId,
      startedAt: asset.startedAt,
    }),
  )
  const response = await fetch(`/api/sessions/${sessionId}/assets`, { method: 'POST', body: form })
  if (!response.ok) throw new Error(await errorText(response))
}

function courtKey(sessionId: string) {
  return `pbmp-court:${sessionId}`
}

export function courtKeyOf(court: Pick<CourtCalibration, 'deviceId'>) {
  return court.deviceId ?? ''
}

// Each phone marks the court in its own view; a court without a phone is the shared fallback.
export function courtFor(courts: CourtCalibration[], deviceId: string | undefined) {
  return courts.find((court) => courtKeyOf(court) === (deviceId ?? '')) ?? courts.find((court) => !court.deviceId) ?? null
}

export function readLocalCourts(sessionId: string): CourtCalibration[] {
  try {
    const raw = localStorage.getItem(courtKey(sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as CourtCalibration | CourtCalibration[]
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.filter((court) => court && court.imagePoints?.length === 4)
  } catch {
    return []
  }
}

export function writeLocalCourts(sessionId: string, courts: CourtCalibration[]) {
  try {
    if (courts.length === 0) localStorage.removeItem(courtKey(sessionId))
    else localStorage.setItem(courtKey(sessionId), JSON.stringify(courts))
  } catch {
    // The calibration still applies for this visit.
  }
}

export async function saveRemoteCourt(sessionId: string, court: CourtCalibration) {
  const response = await fetch(`/api/sessions/${sessionId}/court`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(court),
  })
  if (!response.ok) throw new Error(await errorText(response))
}

export async function clearRemoteCourt(sessionId: string, deviceId: string) {
  const query = deviceId ? `?device=${encodeURIComponent(deviceId)}` : ''
  const response = await fetch(`/api/sessions/${sessionId}/court${query}`, { method: 'DELETE' })
  if (response.status === 404) return
  if (!response.ok) throw new Error(await errorText(response))
}

export async function createTake(sessionId: string, seconds: number) {
  const response = await fetch(`/api/sessions/${sessionId}/takes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seconds, deviceId: deviceId() }),
  })
  if (!response.ok) throw new Error(await errorText(response))
  return (await response.json()) as Take
}

export async function fetchLatestTake(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/takes/latest`, { cache: 'no-store' })
  if (!response.ok) throw new Error(await errorText(response))
  return ((await response.json()) as { take: Take | null }).take
}

export type ModelDetails = Pick<CustomModel, 'name' | 'inputSize' | 'labels' | 'ballClasses'>

export async function uploadModel(sessionId: string, id: string, details: ModelDetails, bytes: ArrayBuffer) {
  const form = new FormData()
  form.set('file', new Blob([bytes], { type: 'application/octet-stream' }), 'model.onnx')
  form.set('meta', JSON.stringify({ id, ...details }))
  const response = await fetch(`/api/sessions/${sessionId}/models`, { method: 'POST', body: form })
  if (!response.ok) throw new Error(await errorText(response))
  return (await response.json()) as SessionDetail
}

export async function saveModelDetails(id: string, details: ModelDetails) {
  const response = await fetch(`/api/custom-models/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(details),
  })
  if (!response.ok) throw new Error(await errorText(response))
  return (await response.json()) as SessionDetail
}

export async function deleteRemoteModel(id: string) {
  const response = await fetch(`/api/custom-models/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await errorText(response))
  return (await response.json()) as SessionDetail
}

// The server downloads the link, so model hosts without CORS headers still work.
export async function fetchModelBytes(link: string) {
  const response = await fetch(`/api/fetch-model?url=${encodeURIComponent(link)}`)
  if (!response.ok) throw new Error(await errorText(response))
  return response.arrayBuffer()
}

export type BallTracks = Record<string, BallTrack>

function ballKey(sessionId: string) {
  return `pbmp-ball:${sessionId}`
}

export function tracksById(tracks: BallTrack[] | undefined): BallTracks {
  const byId: BallTracks = {}
  for (const track of tracks ?? []) {
    if (track?.assetId && Array.isArray(track.points)) byId[track.assetId] = track
  }
  return byId
}

export function readLocalBallTracks(sessionId: string): BallTracks {
  try {
    const raw = localStorage.getItem(ballKey(sessionId))
    if (!raw) return {}
    return tracksById(Object.values(JSON.parse(raw) as BallTracks))
  } catch {
    return {}
  }
}

export function writeLocalBallTracks(sessionId: string, tracks: BallTracks) {
  try {
    if (Object.keys(tracks).length === 0) localStorage.removeItem(ballKey(sessionId))
    else localStorage.setItem(ballKey(sessionId), JSON.stringify(tracks))
  } catch {
    // The track still shows for this visit.
  }
}

export async function saveRemoteBallTrack(track: BallTrack) {
  const response = await fetch(`/api/assets/${track.assetId}/ball-track`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(track),
  })
  if (!response.ok) throw new Error(await errorText(response))
}

export async function clearRemoteBallTrack(assetId: string) {
  const response = await fetch(`/api/assets/${assetId}/ball-track`, { method: 'DELETE' })
  if (response.status === 404) return
  if (!response.ok) throw new Error(await errorText(response))
}

export async function deleteRemoteAsset(id: string) {
  const response = await fetch(`/api/assets/${id}`, { method: 'DELETE' })
  if (response.status === 404) return
  if (!response.ok) throw new Error(await errorText(response))
}

export function assetUrl(record: MediaAssetRecord) {
  return record.fileUrl
}

export function snapshotOf(record: MediaAssetRecord): AiSnapshot | undefined {
  if (!record.inference) return undefined
  const worldPose = record.spatial?.worldPose ?? record.inference.worldPose
  const snapshot: AiSnapshot = {
    at: record.inference.at,
    detections: record.inference.detections,
    pose: record.spatial?.pose ?? record.inference.pose,
    inferenceMs: record.inference.inferenceMs,
  }
  if (worldPose && worldPose.length > 0) snapshot.worldPose = worldPose
  if (record.inference.performance) snapshot.performance = record.inference.performance
  if (record.inference.objectModelId) snapshot.objectModelId = record.inference.objectModelId
  return snapshot
}
