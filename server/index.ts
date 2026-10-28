import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  deleteAsset,
  getSession,
  listModels,
  openStore,
  readMedia,
  saveAsset,
  saveCameras,
  saveSession,
} from './store.ts'
import type { AiSnapshot, CameraRecord, Device } from '../shared/contracts.ts'

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

function asSnapshot(value: unknown): AiSnapshot | null | undefined {
  if (value == null) return null
  if (!value || typeof value !== 'object') return undefined
  const snapshot = value as Partial<AiSnapshot>
  if (typeof snapshot.at !== 'number' || typeof snapshot.inferenceMs !== 'number') return undefined
  if (!Array.isArray(snapshot.detections) || !Array.isArray(snapshot.pose)) return undefined
  if (snapshot.detections.length > 20 || snapshot.pose.length > 64) return undefined
  return {
    at: snapshot.at,
    inferenceMs: snapshot.inferenceMs,
    detections: snapshot.detections.filter((item) => {
      if (!item || typeof item !== 'object') return false
      const detection = item as AiSnapshot['detections'][number]
      return typeof detection.label === 'string' && typeof detection.score === 'number' && !!detection.box
    }),
    pose: snapshot.pose.filter((item) => {
      if (!item || typeof item !== 'object') return false
      const point = item as AiSnapshot['pose'][number]
      return typeof point.x === 'number' && typeof point.y === 'number' && typeof point.visibility === 'number'
    }),
  }
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
    const media = await readMedia(parts[2]!)
    if (!media) {
      sendJson(res, 404, { error: 'File was not found.' })
      return
    }
    cors(res)
    res.writeHead(200, {
      'Content-Type': media.mimeType,
      'Content-Length': media.bytes.byteLength,
      'Cache-Control': 'no-store',
    })
    res.end(media.bytes)
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
