import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  deleteAsset,
  getSession,
  listModels,
  openStore,
  readAssetFile,
  createTake,
  deleteModel,
  latestTake,
  mediaPath,
  readModel,
  saveModel,
  updateModel,
  type ModelDetails,
  saveBallTrack,
  saveCourt,
  saveAsset,
  saveCameras,
  saveSession,
} from './store.ts'
import {
  BALL_TRACK_LIMIT,
  MAX_MODEL_BYTES,
  TAKE_LEAD_MS,
  TAKE_SECONDS,
  type AiSnapshot,
  type BallPoint,
  type BallTrack,
  type CameraRecord,
  type CourtCalibration,
  type CourtPreset,
  type Device,
} from '../shared/contracts.ts'

function listenPort() {
  const raw = (process.env.PORT || process.env.PBMP_PORT || '8787').trim()
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 8080
  return port
}

const port = listenPort()
const distDir = path.resolve(process.cwd(), 'dist')
const MAX_JSON = 1_000_000
const MAX_MEDIA = 200 * 1024 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function isUuid(value: string) {
  return UUID.test(value)
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON) return undefined
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text) as unknown
}

function asDevice(value: unknown): Device | undefined {
  if (!value || typeof value !== 'object') return undefined
  const device = value as Partial<Device>
  if (typeof device.id !== 'string' || !isUuid(device.id)) return undefined
  const label = typeof device.label === 'string' ? device.label.trim().slice(0, 120) : ''
  const userAgent = typeof device.userAgent === 'string' ? device.userAgent.slice(0, 300) : ''
  return { id: device.id, label: label || 'Browser', userAgent }
}

function asRange(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const range = value as { min?: unknown; max?: unknown }
  const min = typeof range.min === 'number' ? range.min : undefined
  const max = typeof range.max === 'number' ? range.max : undefined
  if (min == null && max == null) return undefined
  return { min, max }
}

function asCameras(value: unknown): CameraRecord[] | undefined {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { cameras?: unknown }).cameras)) {
    return undefined
  }
  const cameras: CameraRecord[] = []
  for (const item of (value as { cameras: unknown[] }).cameras) {
    if (!item || typeof item !== 'object') return undefined
    const camera = item as Partial<CameraRecord>
    if (typeof camera.deviceId !== 'string' || camera.deviceId.length < 1 || camera.deviceId.length > 512) {
      return undefined
    }
    if (typeof camera.label !== 'string' || camera.label.trim().length === 0) return undefined
    const next: CameraRecord = {
      deviceId: camera.deviceId,
      label: camera.label.trim().slice(0, 160),
    }
    if (camera.capability && typeof camera.capability === 'object') {
      const capability = camera.capability
      next.capability = {
        width: asRange(capability.width),
        height: asRange(capability.height),
        frameRate: asRange(capability.frameRate),
        facingModes: Array.isArray(capability.facingModes)
          ? capability.facingModes.filter((mode): mode is string => typeof mode === 'string').slice(0, 8)
          : undefined,
      }
    }
    cameras.push(next)
    if (cameras.length > 16) return undefined
  }
  return cameras
}

function asPose(value: unknown, requireZ: boolean) {
  if (!Array.isArray(value) || value.length > 64) return undefined
  const points = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const point = item as Partial<AiSnapshot['pose'][number]>
    if (typeof point.x !== 'number' || typeof point.y !== 'number' || typeof point.visibility !== 'number') {
      return undefined
    }
    if (requireZ && typeof point.z !== 'number') return undefined
    const next: AiSnapshot['pose'][number] = {
      x: point.x,
      y: point.y,
      visibility: point.visibility,
    }
    if (typeof point.z === 'number') next.z = point.z
    points.push(next)
  }
  return points
}

function asCourt(value: unknown): CourtCalibration | undefined {
  if (!value || typeof value !== 'object') return undefined
  const court = value as Partial<CourtCalibration>
  if (court.preset !== 'tennis-doubles' && court.preset !== 'cricket-pitch') return undefined
  if (typeof court.assetId !== 'string' || !isUuid(court.assetId)) return undefined
  if (
    typeof court.sourceWidth !== 'number' ||
    typeof court.sourceHeight !== 'number' ||
    court.sourceWidth < 2 ||
    court.sourceHeight < 2 ||
    court.sourceWidth > 8000 ||
    court.sourceHeight > 8000
  ) {
    return undefined
  }
  if (!Array.isArray(court.imagePoints) || court.imagePoints.length !== 4) return undefined
  const imagePoints = []
  for (const item of court.imagePoints) {
    if (!item || typeof item !== 'object') return undefined
    const point = item as Partial<CourtCalibration['imagePoints'][number]>
    if (typeof point.x !== 'number' || typeof point.y !== 'number') return undefined
    if (point.x < -50 || point.y < -50 || point.x > court.sourceWidth + 50 || point.y > court.sourceHeight + 50) {
      return undefined
    }
    imagePoints.push({ x: point.x, y: point.y })
  }
  const next: CourtCalibration = {
    preset: court.preset as CourtPreset,
    assetId: court.assetId,
    sourceWidth: court.sourceWidth,
    sourceHeight: court.sourceHeight,
    imagePoints,
  }
  if (court.deviceId != null) {
    if (typeof court.deviceId !== 'string' || !isUuid(court.deviceId)) return undefined
    next.deviceId = court.deviceId
  }
  return next
}

function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function asBallTrack(value: unknown, assetId: string): BallTrack | undefined {
  if (!value || typeof value !== 'object') return undefined
  const track = value as Partial<BallTrack>
  if (track.assetId !== assetId) return undefined
  if (typeof track.modelId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(track.modelId)) return undefined
  if (!finiteIn(track.sourceWidth, 2, 8000) || !finiteIn(track.sourceHeight, 2, 8000)) return undefined
  if (!finiteIn(track.sampleFps, 1, 60) || !finiteIn(track.duration, 0, 3600)) return undefined
  if (!finiteIn(track.createdAt, 0, Number.MAX_SAFE_INTEGER)) return undefined
  if (!Array.isArray(track.points) || track.points.length > BALL_TRACK_LIMIT) return undefined
  const width = track.sourceWidth
  const height = track.sourceHeight
  const points: BallPoint[] = []
  for (const item of track.points) {
    if (!item || typeof item !== 'object') return undefined
    const point = item as Partial<BallPoint>
    if (
      !finiteIn(point.t, 0, 3600) ||
      !finiteIn(point.x, -width, width * 2) ||
      !finiteIn(point.y, -height, height * 2) ||
      !finiteIn(point.radius, 0, Math.max(width, height)) ||
      !finiteIn(point.score, 0, 1)
    ) {
      return undefined
    }
    const next: BallPoint = { t: point.t, x: point.x, y: point.y, radius: point.radius, score: point.score }
    if (point.bounce === true) next.bounce = true
    points.push(next)
  }
  return {
    assetId,
    modelId: track.modelId,
    sourceWidth: width,
    sourceHeight: height,
    sampleFps: track.sampleFps,
    duration: track.duration,
    createdAt: track.createdAt,
    points,
    ...(track.live === true ? { live: true } : {}),
  }
}

function asPerformance(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const sample = value as Partial<NonNullable<AiSnapshot['performance']>>
  if (
    typeof sample.processedFps !== 'number' ||
    typeof sample.latencyMs !== 'number' ||
    typeof sample.droppedFrames !== 'number'
  ) {
    return undefined
  }
  return {
    processedFps: sample.processedFps,
    latencyMs: sample.latencyMs,
    droppedFrames: sample.droppedFrames,
  }
}

function asSnapshot(value: unknown): AiSnapshot | null | undefined {
  if (value == null) return null
  if (!value || typeof value !== 'object') return undefined
  const snapshot = value as Partial<AiSnapshot>
  if (typeof snapshot.at !== 'number' || typeof snapshot.inferenceMs !== 'number') return undefined
  if (!Array.isArray(snapshot.detections) || snapshot.detections.length > 20) return undefined
  const pose = asPose(snapshot.pose, false)
  if (!pose) return undefined
  const worldPose = snapshot.worldPose == null ? undefined : asPose(snapshot.worldPose, true)
  if (snapshot.worldPose != null && !worldPose) return undefined
  const performance = snapshot.performance == null ? undefined : asPerformance(snapshot.performance)
  if (snapshot.performance != null && !performance) return undefined
  const next: AiSnapshot = {
    at: snapshot.at,
    inferenceMs: snapshot.inferenceMs,
    detections: snapshot.detections.filter((item) => {
      if (!item || typeof item !== 'object') return false
      const detection = item as AiSnapshot['detections'][number]
      return typeof detection.label === 'string' && typeof detection.score === 'number' && !!detection.box
    }),
    pose,
  }
  if (worldPose && worldPose.length > 0) next.worldPose = worldPose
  if (performance) next.performance = performance
  if (typeof snapshot.objectModelId === 'string' && /^[a-z0-9-]{1,80}$/.test(snapshot.objectModelId)) {
    next.objectModelId = snapshot.objectModelId
  }
  return next
}

function asModelDetails(value: unknown): ModelDetails | undefined {
  if (!value || typeof value !== 'object') return undefined
  const details = value as Partial<ModelDetails>
  const name = typeof details.name === 'string' ? details.name.trim().slice(0, 80) : ''
  if (!name) return undefined
  const inputSize = details.inputSize
  if (typeof inputSize !== 'number' || !Number.isInteger(inputSize) || inputSize < 32 || inputSize > 2048 || inputSize % 32) {
    return undefined
  }
  if (!Array.isArray(details.labels) || details.labels.length === 0 || details.labels.length > 1000) return undefined
  const labels = details.labels.map((label, index) =>
    typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : `class ${index}`,
  )
  if (!Array.isArray(details.ballClasses) || details.ballClasses.length > labels.length) return undefined
  const ballClasses = [...new Set(details.ballClasses)]
  if (ballClasses.some((item) => typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item >= labels.length)) {
    return undefined
  }
  return { name, inputSize, labels, ballClasses: ballClasses.sort((a, b) => a - b) }
}

function privateAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const lower = address.toLowerCase()
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:')
}

// The model link is fetched by the server so browser CORS rules do not apply, which means it must
// never be allowed to reach this server's own network.
async function publicUrl(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((item) => item.address)
  if (addresses.length === 0 || addresses.some(privateAddress)) return null
  return url
}

async function proxyModel(raw: string, res: ServerResponse) {
  let target = await publicUrl(raw)
  for (let hop = 0; target && hop < 5; hop += 1) {
    const response = await fetch(target, { redirect: 'manual' }).catch(() => null)
    if (!response) {
      sendJson(res, 502, { error: 'The model link could not be reached.' })
      return
    }
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      target = await publicUrl(new URL(location, target).toString())
      continue
    }
    if (!response.ok || !response.body) {
      sendJson(res, 502, { error: `The model link answered ${response.status}.` })
      return
    }
    // fetch decompresses the body, so the upstream length can be shorter than what is sent on.
    const declared = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_MODEL_BYTES) {
      sendJson(res, 413, { error: 'The model is larger than 200 MB.' })
      return
    }
    cors(res)
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' })
    let sent = 0
    const body = Readable.fromWeb(response.body as never)
    body.on('data', (chunk: Buffer) => {
      sent += chunk.length
      if (sent > MAX_MODEL_BYTES) body.destroy(new Error('The model is larger than 200 MB.'))
    })
    await pipeline(body, res).catch(() => res.destroy())
    return
  }
  sendJson(res, 400, { error: 'Use a public https link to the .onnx file.' })
}

async function formRequest(req: IncomingMessage) {
  const host = req.headers.host ?? '127.0.0.1'
  return new Request(`http://${host}${req.url ?? '/'}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: 'half',
  } as never)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/time') {
    sendJson(res, 200, { now: Date.now() })
    return
  }

  if (!url.pathname.startsWith('/api')) {
    if (await serveApp(req, res, url.pathname)) return
    sendJson(res, 404, { error: 'Not found.' })
    return
  }

  await storeReady
  if (storeError) {
    sendJson(res, 503, { error: 'The session store is not available.' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    sendJson(res, 200, { models: listModels() })
    return
  }

  if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 2 && req.method === 'POST') {
    const body = (await readBody(req)) as { id?: unknown; device?: unknown } | undefined
    if (!body) {
      sendJson(res, 413, { error: 'Session request is too large.' })
      return
    }
    const device = asDevice(body.device)
    const id = typeof body.id === 'string' && isUuid(body.id) ? body.id : randomUUID()
    if (!device) {
      sendJson(res, 400, { error: 'A device id is required.' })
      return
    }
    sendJson(res, 200, saveSession(id, device))
    return
  }

  if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3 && req.method === 'GET') {
    if (!isUuid(parts[2]!)) {
      sendJson(res, 400, { error: 'Session id is not valid.' })
      return
    }
    const session = getSession(parts[2]!)
    if (!session) {
      sendJson(res, 404, { error: 'Session was not found.' })
      return
    }
    sendJson(res, 200, session)
    return
  }

  if (
    parts[0] === 'api' &&
    parts[1] === 'sessions' &&
    parts[3] === 'cameras' &&
    parts.length === 4 &&
    req.method === 'PUT'
  ) {
    if (!isUuid(parts[2]!)) {
      sendJson(res, 400, { error: 'Session id is not valid.' })
      return
    }
    const body = await readBody(req)
    if (!body) {
      sendJson(res, 413, { error: 'Camera list is too large.' })
      return
    }
    const cameras = asCameras(body)
    if (!cameras) {
      sendJson(res, 400, { error: 'Camera list is not valid.' })
      return
    }
    const session = saveCameras(parts[2]!, cameras)
    if (!session) {
      sendJson(res, 404, { error: 'Session was not found.' })
      return
    }
    sendJson(res, 200, session)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/fetch-model') {
    await proxyModel(url.searchParams.get('url') ?? '', res)
    return
  }

  if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'models' && parts.length === 4 && req.method === 'POST') {
    if (!isUuid(parts[2]!)) {
      sendJson(res, 400, { error: 'Session id is not valid.' })
      return
    }
    const form = await (await formRequest(req)).formData()
    const file = form.get('file')
    const metaText = form.get('meta')
    if (!(file instanceof File) || typeof metaText !== 'string') {
      sendJson(res, 400, { error: 'A model file and its details are required.' })
      return
    }
    if (file.size > MAX_MODEL_BYTES) {
      sendJson(res, 413, { error: 'The model is larger than 200 MB.' })
      return
    }
    let meta: { id?: unknown } & Record<string, unknown>
    try {
      meta = JSON.parse(metaText) as typeof meta
    } catch {
      sendJson(res, 400, { error: 'Model details could not be read.' })
      return
    }
    const details = asModelDetails(meta)
    if (typeof meta.id !== 'string' || !isUuid(meta.id) || !details) {
      sendJson(res, 400, { error: 'Model details are not valid.' })
      return
    }
    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes[0] !== 0x08) {
      sendJson(res, 400, { error: 'This file is not an ONNX model.' })
      return
    }
    const saved = await saveModel(parts[2]!, meta.id.toLowerCase(), details, bytes)
    if (saved === 'conflict') {
      sendJson(res, 409, { error: 'That model id is already used.' })
      return
    }
    if (!saved) {
      sendJson(res, 404, { error: 'Session was not found.' })
      return
    }
    sendJson(res, 200, saved)
    return
  }

  if (parts[0] === 'api' && parts[1] === 'custom-models' && isUuid(parts[2] ?? '')) {
    const id = parts[2]!.toLowerCase()
    if (parts.length === 4 && parts[3] === 'file' && req.method === 'GET') {
      const model = readModel(id)
      const stored = mediaPath(id)
      if (!model || !existsSync(stored)) {
        sendJson(res, 404, { error: 'Model was not found.' })
        return
      }
      cors(res)
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': statSync(stored).size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      await pipeline(createReadStream(stored), res).catch(() => undefined)
      return
    }
    if (parts.length === 3 && req.method === 'PUT') {
      const body = await readBody(req)
      const details = body ? asModelDetails(body) : undefined
      if (!details) {
        sendJson(res, 400, { error: 'Model details are not valid.' })
        return
      }
      const session = updateModel(id, details)
      if (!session) {
        sendJson(res, 404, { error: 'Model was not found.' })
        return
      }
      sendJson(res, 200, session)
      return
    }
    if (parts.length === 3 && req.method === 'DELETE') {
      const session = await deleteModel(id)
      if (!session) {
        sendJson(res, 404, { error: 'Model was not found.' })
        return
      }
      sendJson(res, 200, session)
      return
    }
  }

  if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'takes' && isUuid(parts[2] ?? '')) {
    if (parts.length === 4 && req.method === 'POST') {
      const body = (await readBody(req)) as { seconds?: unknown; deviceId?: unknown } | undefined
      if (!body) {
        sendJson(res, 413, { error: 'Take request is too large.' })
        return
      }
      const seconds = TAKE_SECONDS.find((choice) => choice === body.seconds)
      if (!seconds) {
        sendJson(res, 400, { error: `A take lasts ${TAKE_SECONDS.join(', ')} seconds.` })
        return
      }
      const createdBy = typeof body.deviceId === 'string' && isUuid(body.deviceId) ? body.deviceId : ''
      const now = Date.now()
      const take = createTake(parts[2]!, { id: randomUUID(), startAt: now + TAKE_LEAD_MS, seconds, createdAt: now, createdBy })
      if (!take) {
        sendJson(res, 404, { error: 'Session was not found.' })
        return
      }
      sendJson(res, 200, take)
      return
    }
    if (parts.length === 5 && parts[4] === 'latest' && req.method === 'GET') {
      const take = latestTake(parts[2]!)
      if (take === undefined) {
        sendJson(res, 404, { error: 'Session was not found.' })
        return
      }
      sendJson(res, 200, { take })
      return
    }
  }

  if (
    parts[0] === 'api' &&
    parts[1] === 'sessions' &&
    parts[3] === 'court' &&
    parts.length === 4 &&
    (req.method === 'PUT' || req.method === 'DELETE')
  ) {
    if (!isUuid(parts[2]!)) {
      sendJson(res, 400, { error: 'Session id is not valid.' })
      return
    }
    if (req.method === 'DELETE') {
      const device = url.searchParams.get('device') ?? ''
      if (device && !isUuid(device)) {
        sendJson(res, 400, { error: 'Device id is not valid.' })
        return
      }
      const session = saveCourt(parts[2]!, device, null)
      if (!session) {
        sendJson(res, 404, { error: 'Session was not found.' })
        return
      }
      sendJson(res, 200, session)
      return
    }
    const body = await readBody(req)
    if (!body) {
      sendJson(res, 413, { error: 'Court calibration is too large.' })
      return
    }
    const court = asCourt(body)
    if (!court) {
      sendJson(res, 400, { error: 'Court calibration is not valid.' })
      return
    }
    const session = saveCourt(parts[2]!, court.deviceId ?? '', court)
    if (!session) {
      sendJson(res, 404, { error: 'Session was not found.' })
      return
    }
    sendJson(res, 200, session)
    return
  }

  if (
    parts[0] === 'api' &&
    parts[1] === 'sessions' &&
    parts[3] === 'assets' &&
    parts.length === 4 &&
    req.method === 'POST'
  ) {
    if (!isUuid(parts[2]!)) {
      sendJson(res, 400, { error: 'Session id is not valid.' })
      return
    }
    const form = await (await formRequest(req)).formData()
    const file = form.get('file')
    const metaText = form.get('meta')
    if (!(file instanceof File) || typeof metaText !== 'string') {
      sendJson(res, 400, { error: 'A file and meta JSON are required.' })
      return
    }
    if (file.size > MAX_MEDIA) {
      sendJson(res, 413, { error: 'The file is larger than 200 MB.' })
      return
    }
    let meta: {
      id?: unknown
      kind?: unknown
      mimeType?: unknown
      createdAt?: unknown
      cameraLabel?: unknown
      width?: unknown
      height?: unknown
      snapshot?: unknown
      deviceId?: unknown
      takeId?: unknown
      startedAt?: unknown
    }
    try {
      meta = JSON.parse(metaText) as typeof meta
    } catch {
      sendJson(res, 400, { error: 'Meta JSON could not be read.' })
      return
    }
    if (typeof meta.id !== 'string' || !isUuid(meta.id)) {
      sendJson(res, 400, { error: 'Asset id is not valid.' })
      return
    }
    if (meta.kind !== 'photo' && meta.kind !== 'video') {
      sendJson(res, 400, { error: 'Asset kind is not valid.' })
      return
    }
    if (typeof meta.mimeType !== 'string' || typeof meta.cameraLabel !== 'string') {
      sendJson(res, 400, { error: 'Asset details are missing.' })
      return
    }
    if (typeof meta.createdAt !== 'number') {
      sendJson(res, 400, { error: 'Asset time is missing.' })
      return
    }
    const snapshot = asSnapshot(meta.snapshot)
    if (snapshot === undefined) {
      sendJson(res, 400, { error: 'AI snapshot is not valid.' })
      return
    }
    for (const key of ['deviceId', 'takeId'] as const) {
      const value = meta[key]
      if (value != null && (typeof value !== 'string' || !isUuid(value))) {
        sendJson(res, 400, { error: `${key} is not valid.` })
        return
      }
    }
    if (meta.startedAt != null && !finiteIn(meta.startedAt, 0, Number.MAX_SAFE_INTEGER)) {
      sendJson(res, 400, { error: 'startedAt is not valid.' })
      return
    }
    const saved = await saveAsset(
      parts[2]!,
      {
        id: meta.id,
        kind: meta.kind,
        mimeType: meta.mimeType.slice(0, 120),
        createdAt: meta.createdAt,
        cameraLabel: meta.cameraLabel.trim().slice(0, 160) || 'Camera',
        width: typeof meta.width === 'number' ? meta.width : undefined,
        height: typeof meta.height === 'number' ? meta.height : undefined,
        snapshot,
        deviceId: typeof meta.deviceId === 'string' ? meta.deviceId : undefined,
        takeId: typeof meta.takeId === 'string' ? meta.takeId : undefined,
        startedAt: typeof meta.startedAt === 'number' ? meta.startedAt : undefined,
      },
      Buffer.from(await file.arrayBuffer()),
    )
    if (saved === 'conflict') {
      sendJson(res, 409, { error: 'That file id already belongs to another session.' })
      return
    }
    if (!saved) {
      sendJson(res, 404, { error: 'Session was not found.' })
      return
    }
    sendJson(res, 200, saved)
    return
  }

  if (parts[0] === 'api' && parts[1] === 'assets' && parts[3] === 'file' && parts.length === 4 && req.method === 'GET') {
    if (!isUuid(parts[2]!)) {
      sendJson(res, 400, { error: 'Asset id is not valid.' })
      return
    }
    const file = readAssetFile(parts[2]!)
    const size = file && existsSync(file.path) ? statSync(file.path).size : -1
    if (!file || size < 0) {
      sendJson(res, 404, { error: 'File was not found.' })
      return
    }
    cors(res)
    const headers = { 'Content-Type': file.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
    // Browsers can only seek a video when the server answers byte ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` })
      await pipeline(createReadStream(file.path, { start, end }), res).catch(() => undefined)
      return
    }
    res.writeHead(200, { ...headers, 'Content-Length': size })
    await pipeline(createReadStream(file.path), res).catch(() => undefined)
    return
  }

  if (
    parts[0] === 'api' &&
    parts[1] === 'assets' &&
    parts[3] === 'ball-track' &&
    parts.length === 4 &&
    (req.method === 'PUT' || req.method === 'DELETE')
  ) {
    const assetId = parts[2]!
    if (!isUuid(assetId)) {
      sendJson(res, 400, { error: 'Asset id is not valid.' })
      return
    }
    let track: BallTrack | null = null
    if (req.method === 'PUT') {
      const body = await readBody(req)
      if (!body) {
        sendJson(res, 413, { error: 'Ball track is too large.' })
        return
      }
      const parsed = asBallTrack(body, assetId)
      if (!parsed) {
        sendJson(res, 400, { error: 'Ball track is not valid.' })
        return
      }
      track = parsed
    }
    const session = saveBallTrack(assetId, track)
    if (!session) {
      sendJson(res, 404, { error: 'File was not found.' })
      return
    }
    sendJson(res, 200, session)
    return
  }

  if (parts[0] === 'api' && parts[1] === 'assets' && parts.length === 3 && req.method === 'DELETE') {
    if (!isUuid(parts[2]!)) {
      sendJson(res, 400, { error: 'Asset id is not valid.' })
      return
    }
    const removed = await deleteAsset(parts[2]!)
    if (!removed) {
      sendJson(res, 404, { error: 'File was not found.' })
      return
    }
    sendJson(res, 200, { ok: true })
    return
  }

  sendJson(res, 404, { error: 'Not found.' })
}

const fileTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
}

function appFile(urlPath: string) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const file = path.resolve(distDir, relative)
  const root = distDir.endsWith(path.sep) ? distDir : `${distDir}${path.sep}`
  if (file !== distDir && !file.startsWith(root)) return undefined
  return file
}

async function serveApp(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || urlPath.startsWith('/api') || !existsSync(distDir)) {
    return false
  }
  const requested = appFile(urlPath)
  const file =
    requested && existsSync(requested) && statSync(requested).isFile() ? requested : path.join(distDir, 'index.html')
  if (!existsSync(file)) return false
  res.writeHead(200, {
    'Content-Type': fileTypes[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.endsWith(`${path.sep}index.html`) ? 'no-store' : 'public, max-age=3600',
    // Cross-origin isolation lets the ONNX worker use threads; credentialless keeps CDN files loading.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  await pipeline(createReadStream(file), res)
  return true
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error)
    if (!res.headersSent) sendJson(res, 500, { error: 'The server could not finish that request.' })
    else res.end()
  })
})

let storeError: unknown
const storeReady = openStore().catch((error: unknown) => {
  storeError = error
  console.error('Session store did not open.', error)
})

console.log(`PBMP starting. Node ${process.version}. Port ${port}.`)
server.listen(port, '0.0.0.0', () => {
  console.log(`PBMP API listening on http://0.0.0.0:${port}`)
})
