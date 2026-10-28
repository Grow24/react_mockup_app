import type { AiSnapshot, CameraRecord, Device, MediaAssetRecord, SessionDetail } from '../../shared/contracts.ts'

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
    }),
  )
  const response = await fetch(`/api/sessions/${sessionId}/assets`, { method: 'POST', body: form })
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
  return snapshot
}
