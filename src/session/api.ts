import type {
  AiSnapshot,
  BallTrack,
  CameraRecord,
  CourtCalibration,
  CustomModel,
  Device,
  MediaAssetRecord,
  MotionTrack,
  PoseTrack,
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

export class PrivateSessionError extends Error {}

async function sessionReply(response: Response) {
  if (response.status === 403) throw new PrivateSessionError(await errorText(response))
  if (!response.ok) throw new Error(await errorText(response))
  const session = (await response.json()) as SessionDetail
  if (session.key) rememberSessionKey(session.id, session.key)
  return session
}

export async function openSession(id: string, device: Device) {
  return sessionReply(
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, device }),
    }),
  )
}

export async function fetchSession(id: string) {
  const response = await fetch(`/api/sessions/${id}`)
  if (response.status === 404) return null
  return sessionReply(response)
}

// The server keeps the key as an HttpOnly cookie; this copy is only to build the share link.
function keyStorage(id: string) {
  return `pbmp-session-key:${id}`
}

export function rememberSessionKey(id: string, key: string) {
  try {
    localStorage.setItem(keyStorage(id), key)
  } catch {
    // The cookie still opens the session; only the share link loses its key.
  }
}

export function sessionKey(id: string) {
  try {
    return localStorage.getItem(keyStorage(id))
  } catch {
    return null
  }
}

export async function unlockSession(id: string, key: string) {
  const response = await fetch(`/api/sessions/${id}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  if (response.status === 404) return null
  const session = await sessionReply(response)
  rememberSessionKey(id, key)
  return session
}

export async function lockSession(id: string) {
  return sessionReply(await fetch(`/api/sessions/${id}/lock`, { method: 'POST' }))
}

export function shareLink(id: string, locked: boolean) {
  const key = locked ? sessionKey(id) : null
  return `${window.location.origin}/?session=${id}${key ? `&key=${encodeURIComponent(key)}` : ''}`
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
  const meta = JSON.stringify({
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
  })
  // A long match video goes up as the file alone, which the server streams to disk.
  if (asset.blob.size > STREAM_UPLOAD_FROM) {
    const response = await fetch(`/api/sessions/${sessionId}/assets/stream`, {
      method: 'PUT',
      headers: { 'Content-Type': asset.mimeType || 'application/octet-stream', 'X-Asset-Meta': encodeURIComponent(meta) },
      body: asset.blob,
    })
    if (!response.ok) throw new Error(await errorText(response))
    return
  }
  const form = new FormData()
  const extension = asset.mimeType.includes('png')
    ? 'png'
    : asset.kind === 'photo'
      ? 'jpg'
      : 'webm'
  form.set('file', asset.blob, `${asset.kind}.${extension}`)
  form.set('meta', meta)
  const response = await fetch(`/api/sessions/${sessionId}/assets`, { method: 'POST', body: form })
  if (!response.ok) throw new Error(await errorText(response))
}

const STREAM_UPLOAD_FROM = 64 * 1024 * 1024

function courtKey(sessionId: string) {
  return `pbmp-court:${sessionId}`
}

export function courtKeyOf(court: Pick<CourtCalibration, 'deviceId' | 'slot'>) {
  return `${court.deviceId ?? ''}${court.slot ? `:${court.slot}` : ''}`
}

// Each phone marks the court in its own view; a court without a phone is the shared fallback.
export function courtFor(courts: CourtCalibration[], deviceId: string | undefined) {
  return courtsFor(courts, deviceId)[0] ?? null
}

// Every court this phone watches, the first marked first: two when it sees two courts side by side.
export function courtsFor(courts: CourtCalibration[], deviceId: string | undefined) {
  const own = courts.filter((court) => (court.deviceId ?? '') === (deviceId ?? ''))
  const chosen = own.length > 0 ? own : courts.filter((court) => !court.deviceId)
  return chosen.slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
}

export function courtLabel(court: Pick<CourtCalibration, 'name' | 'slot'>) {
  return court.name || `Court ${(court.slot ?? 0) + 1}`
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

// key is courtKeyOf the court: the phone's id, with ":1" for its second court.
export async function clearRemoteCourt(sessionId: string, key: string) {
  const [deviceId = '', slot = ''] = key.split(':')
  const params = new URLSearchParams()
  if (deviceId) params.set('device', deviceId)
  if (slot) params.set('slot', slot)
  const query = params.size > 0 ? `?${params}` : ''
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
export async function fetchModelBytes(sessionId: string, link: string) {
  const response = await fetch(`/api/fetch-model?session=${sessionId}&url=${encodeURIComponent(link)}`)
  if (!response.ok) throw new Error(await errorText(response))
  return response.arrayBuffer()
}

// Tracks of a long video run to megabytes; gzipped they upload several times faster.
const GZIP_UPLOAD_FROM = 256 * 1024

async function jsonBody(value: unknown): Promise<{ body: BodyInit; headers: Record<string, string> }> {
  const text = JSON.stringify(value)
  if (text.length < GZIP_UPLOAD_FROM || typeof CompressionStream === 'undefined') {
    return { body: text, headers: { 'Content-Type': 'application/json' } }
  }
  const zipped = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return { body: await new Response(zipped).blob(), headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } }
}

// Runs saves for one key in order, skipping any that a newer one replaced while they waited, so
// an older copy of a growing track never lands after a newer one.
export function latestOnly() {
  const lanes = new Map<string, { next: (() => Promise<void>) | null }>()
  return (key: string, run: () => Promise<void>) => {
    const lane = lanes.get(key)
    if (lane) {
      lane.next = run
      return
    }
    const fresh = { next: run as (() => Promise<void>) | null }
    lanes.set(key, fresh)
    void (async () => {
      while (fresh.next) {
        const job = fresh.next
        fresh.next = null
        await job().catch((error) => console.error(error))
      }
      lanes.delete(key)
    })()
  }
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
    ...(await jsonBody(track)),
  })
  if (!response.ok) throw new Error(await errorText(response))
}

export async function clearRemoteBallTrack(assetId: string) {
  const response = await fetch(`/api/assets/${assetId}/ball-track`, { method: 'DELETE' })
  if (response.status === 404) return
  if (!response.ok) throw new Error(await errorText(response))
}

export function poseTracksById(tracks: PoseTrack[] | undefined) {
  const byId: Record<string, PoseTrack> = {}
  for (const track of tracks ?? []) {
    if (track?.assetId && Array.isArray(track.frames)) byId[track.assetId] = track
  }
  return byId
}

export async function saveRemotePoseTrack(track: PoseTrack) {
  const response = await fetch(`/api/assets/${track.assetId}/pose-track`, {
    method: 'PUT',
    ...(await jsonBody(track)),
  })
  if (!response.ok) throw new Error(await errorText(response))
}

export async function clearRemotePoseTrack(assetId: string) {
  const response = await fetch(`/api/assets/${assetId}/pose-track`, { method: 'DELETE' })
  if (response.status === 404) return
  if (!response.ok) throw new Error(await errorText(response))
}

export function motionTracksById(tracks: MotionTrack[] | undefined) {
  const byId: Record<string, MotionTrack> = {}
  for (const track of tracks ?? []) {
    if (track?.assetId && Array.isArray(track.frames)) byId[track.assetId] = track
  }
  return byId
}

export async function saveRemoteMotionTrack(track: MotionTrack) {
  const response = await fetch(`/api/assets/${track.assetId}/motion-track`, {
    method: 'PUT',
    ...(await jsonBody(track)),
  })
  if (!response.ok) throw new Error(await errorText(response))
}

export async function clearRemoteMotionTrack(assetId: string) {
  const response = await fetch(`/api/assets/${assetId}/motion-track`, { method: 'DELETE' })
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
