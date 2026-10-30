import { mkdirSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  OBJECT_MODEL_ID,
  ONNX_MODEL_ID,
  POSE_MODEL_ID,
  type AiModel,
  type AiSnapshot,
  type BallTrack,
  type CameraRecord,
  type CourtCalibration,
  type Device,
  type InferenceResult,
  type MediaAssetRecord,
  type SessionDetail,
  type SpatialResult,
  type Take,
} from '../shared/contracts.ts'

let mediaDir = path.join(path.resolve(process.cwd(), 'server/data'), 'media')
let db: DatabaseSync | undefined

const schema = `
  PRAGMA journal_mode = DELETE;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    device_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cameras (
    session_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    label TEXT NOT NULL,
    capability_json TEXT,
    PRIMARY KEY (session_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    camera_label TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    byte_length INTEGER NOT NULL,
    inference_json TEXT,
    spatial_json TEXT
  );
  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    task TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS courts (
    session_id TEXT PRIMARY KEY,
    court_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ball_tracks (
    asset_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    track_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_courts (
    session_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    court_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS takes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    seconds INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
  );
`

// Columns added after the first release; older databases get them on open.
const assetColumns = [
  ['device_id', 'TEXT'],
  ['take_id', 'TEXT'],
  ['started_at', 'INTEGER'],
] as const

function migrate(opened: DatabaseSync) {
  const present = new Set(
    (opened.prepare('PRAGMA table_info(assets)').all() as { name: string }[]).map((column) => column.name),
  )
  for (const [name, type] of assetColumns) {
    if (!present.has(name)) opened.exec(`ALTER TABLE assets ADD COLUMN ${name} ${type}`)
  }
  opened.exec('BEGIN')
  try {
    opened.exec(
      `INSERT OR IGNORE INTO device_courts (session_id, device_id, court_json, updated_at)
       SELECT session_id, '', court_json, 0 FROM courts`,
    )
    opened.exec('DELETE FROM courts')
    opened.exec('COMMIT')
  } catch (error) {
    opened.exec('ROLLBACK')
    throw error
  }
}

const models: AiModel[] = [
  { id: OBJECT_MODEL_ID, name: 'MediaPipe EfficientDet Lite0', task: 'object-detection' },
  { id: ONNX_MODEL_ID, name: 'YOLOv8n COCO ONNX', task: 'object-detection' },
  { id: POSE_MODEL_ID, name: 'MediaPipe Pose Landmarker Lite', task: 'pose' },
]

function database() {
  if (!db) throw new Error('The session store is not open.')
  return db
}

function openAt(DatabaseSyncCtor: typeof import('node:sqlite').DatabaseSync, dir: string) {
  const media = path.join(dir, 'media')
  mkdirSync(media, { recursive: true })
  const opened = new DatabaseSyncCtor(path.join(dir, 'pbmp.sqlite'))
  opened.exec(schema)
  migrate(opened)
  const insertModel = opened.prepare(
    'INSERT INTO models (id, name, task) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, task = excluded.task',
  )
  for (const model of models) insertModel.run(model.id, model.name, model.task)
  return { opened, media }
}

export async function openStore() {
  if (db) return
  const { DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite')
  const preferred = path.resolve(process.cwd(), 'server/data')
  try {
    const opened = openAt(DatabaseSyncCtor, preferred)
    db = opened.opened
    mediaDir = opened.media
    console.log(`PBMP data directory ${preferred}`)
    return
  } catch (error) {
    console.error(`Could not open ${preferred}. Using /tmp/pbmp-data.`, error)
  }
  const fallback = '/tmp/pbmp-data'
  const opened = openAt(DatabaseSyncCtor, fallback)
  db = opened.opened
  mediaDir = opened.media
  console.log(`PBMP data directory ${fallback}`)
}

export function listModels() {
  return models
}

type SessionRow = {
  id: string
  created_at: number
  updated_at: number
  device_json: string
}

type CameraRow = {
  device_id: string
  label: string
  capability_json: string | null
}

type AssetRow = {
  id: string
  session_id: string
  kind: string
  mime_type: string
  created_at: number
  camera_label: string
  width: number | null
  height: number | null
  byte_length: number
  inference_json: string | null
  spatial_json: string | null
  device_id: string | null
  take_id: string | null
  started_at: number | null
}

function sessionById(id: string) {
  return database().prepare('SELECT id, created_at, updated_at, device_json FROM sessions WHERE id = ?').get(id) as
    | SessionRow
    | undefined
}

function camerasFor(sessionId: string) {
  const rows = database()
    .prepare(
      'SELECT device_id, label, capability_json FROM cameras WHERE session_id = ? ORDER BY label',
    )
    .all(sessionId) as CameraRow[]
  return rows.map((row) => {
    const camera: CameraRecord = { deviceId: row.device_id, label: row.label }
    if (row.capability_json) camera.capability = JSON.parse(row.capability_json) as CameraRecord['capability']
    return camera
  })
}

function assetsFor(sessionId: string) {
  const rows = database()
    .prepare(
      `SELECT id, session_id, kind, mime_type, created_at, camera_label, width, height, byte_length, inference_json, spatial_json,
              device_id, take_id, started_at
       FROM assets WHERE session_id = ? ORDER BY created_at DESC`,
    )
    .all(sessionId) as AssetRow[]
  return rows.map(toAsset)
}

function toAsset(row: AssetRow): MediaAssetRecord {
  const extra: Pick<MediaAssetRecord, 'deviceId' | 'takeId' | 'startedAt'> = {}
  if (row.device_id) extra.deviceId = row.device_id
  if (row.take_id) extra.takeId = row.take_id
  if (row.started_at != null) extra.startedAt = row.started_at
  return {
    ...extra,
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind === 'video' ? 'video' : 'photo',
    mimeType: row.mime_type,
    createdAt: row.created_at,
    cameraLabel: row.camera_label,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    byteLength: row.byte_length,
    fileUrl: `/api/assets/${row.id}/file`,
    inference: row.inference_json ? (JSON.parse(row.inference_json) as InferenceResult) : null,
    spatial: row.spatial_json ? (JSON.parse(row.spatial_json) as SpatialResult) : null,
  }
}

export function getSession(id: string): SessionDetail | undefined {
  const row = sessionById(id)
  if (!row) return undefined
  const courts = readCourts(id)
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    device: JSON.parse(row.device_json) as Device,
    cameras: camerasFor(id),
    assets: assetsFor(id),
    court: courts[0] ?? null,
    courts,
    ballTracks: readBallTracks(id),
  }
}

function readBallTracks(sessionId: string): BallTrack[] {
  const rows = database()
    .prepare(
      `SELECT b.track_json FROM ball_tracks b JOIN assets a ON a.id = b.asset_id
       WHERE b.session_id = ? ORDER BY a.created_at DESC`,
    )
    .all(sessionId) as { track_json: string }[]
  const tracks: BallTrack[] = []
  for (const row of rows) {
    try {
      tracks.push(JSON.parse(row.track_json) as BallTrack)
    } catch {
      // A broken row is skipped; the video can be tracked again.
    }
  }
  return tracks
}

export function saveBallTrack(assetId: string, track: BallTrack | null) {
  const asset = database().prepare('SELECT session_id FROM assets WHERE id = ?').get(assetId) as
    | { session_id: string }
    | undefined
  if (!asset) return undefined
  if (!track) {
    database().prepare('DELETE FROM ball_tracks WHERE asset_id = ?').run(assetId)
  } else {
    database()
      .prepare(
        'INSERT INTO ball_tracks (asset_id, session_id, track_json) VALUES (?, ?, ?) ON CONFLICT(asset_id) DO UPDATE SET track_json = excluded.track_json',
      )
      .run(assetId, asset.session_id, JSON.stringify(track))
  }
  database().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), asset.session_id)
  return getSession(asset.session_id)
}

export function readCourts(sessionId: string): CourtCalibration[] {
  const rows = database()
    .prepare('SELECT device_id, court_json FROM device_courts WHERE session_id = ? ORDER BY updated_at DESC')
    .all(sessionId) as { device_id: string; court_json: string }[]
  const courts: CourtCalibration[] = []
  for (const row of rows) {
    try {
      const court = JSON.parse(row.court_json) as CourtCalibration
      if (!court || court.imagePoints?.length !== 4) continue
      const clean: CourtCalibration = {
        preset: court.preset,
        assetId: court.assetId,
        sourceWidth: court.sourceWidth,
        sourceHeight: court.sourceHeight,
        imagePoints: court.imagePoints,
      }
      if (row.device_id) clean.deviceId = row.device_id
      courts.push(clean)
    } catch {
      // A broken row is skipped; the court can be marked again.
    }
  }
  return courts
}

export function saveCourt(sessionId: string, deviceId: string, court: CourtCalibration | null) {
  if (!sessionById(sessionId)) return undefined
  if (!court) {
    database().prepare('DELETE FROM device_courts WHERE session_id = ? AND device_id = ?').run(sessionId, deviceId)
  } else {
    database()
      .prepare(
        `INSERT INTO device_courts (session_id, device_id, court_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, device_id) DO UPDATE SET court_json = excluded.court_json, updated_at = excluded.updated_at`,
      )
      .run(sessionId, deviceId, JSON.stringify(court), Date.now())
  }
  database().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
  return getSession(sessionId)
}

type TakeRow = { id: string; session_id: string; start_at: number; seconds: number; created_at: number; created_by: string }

function toTake(row: TakeRow): Take {
  return {
    id: row.id,
    sessionId: row.session_id,
    startAt: row.start_at,
    seconds: row.seconds,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
}

export function createTake(sessionId: string, take: Omit<Take, 'sessionId'>) {
  if (!sessionById(sessionId)) return undefined
  database()
    .prepare('INSERT INTO takes (id, session_id, start_at, seconds, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(take.id, sessionId, take.startAt, take.seconds, take.createdAt, take.createdBy)
  return { ...take, sessionId }
}

export function latestTake(sessionId: string) {
  if (!sessionById(sessionId)) return undefined
  const row = database()
    .prepare('SELECT * FROM takes WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(sessionId) as TakeRow | undefined
  return row ? toTake(row) : null
}

export function saveSession(id: string, device: Device) {
  const existing = sessionById(id)
  const now = Date.now()
  if (existing) return getSession(id)!
  database().prepare('INSERT INTO sessions (id, created_at, updated_at, device_json) VALUES (?, ?, ?, ?)').run(
    id,
    now,
    now,
    JSON.stringify(device),
  )
  return getSession(id)!
}

export function saveCameras(sessionId: string, cameras: CameraRecord[]) {
  if (!sessionById(sessionId)) return undefined
  const remove = database().prepare('DELETE FROM cameras WHERE session_id = ?')
  const insert = database().prepare(
    'INSERT INTO cameras (session_id, device_id, label, capability_json) VALUES (?, ?, ?, ?)',
  )
  database().exec('BEGIN')
  try {
    remove.run(sessionId)
    for (const camera of cameras) {
      insert.run(
        sessionId,
        camera.deviceId,
        camera.label,
        camera.capability ? JSON.stringify(camera.capability) : null,
      )
    }
    database().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
    database().exec('COMMIT')
  } catch (error) {
    database().exec('ROLLBACK')
    throw error
  }
  return getSession(sessionId)
}

export function mediaPath(id: string) {
  return path.join(mediaDir, id)
}

export async function saveAsset(
  sessionId: string,
  asset: {
    id: string
    kind: 'photo' | 'video'
    mimeType: string
    createdAt: number
    cameraLabel: string
    width?: number
    height?: number
    snapshot: AiSnapshot | null
    deviceId?: string
    takeId?: string
    startedAt?: number
  },
  bytes: Buffer,
) {
  if (!sessionById(sessionId)) return undefined
  const existing = database().prepare('SELECT session_id FROM assets WHERE id = ?').get(asset.id) as
    | { session_id: string }
    | undefined
  if (existing) {
    if (existing.session_id !== sessionId) return 'conflict' as const
    return getSession(sessionId)
  }

  const inference: InferenceResult | null = asset.snapshot
    ? {
        ...asset.snapshot,
        objectModelId: asset.snapshot.objectModelId || OBJECT_MODEL_ID,
        poseModelId: POSE_MODEL_ID,
      }
    : null
  const spatial: SpatialResult | null = asset.snapshot
    ? {
        source: 'mediapipe-pose',
        coordinateSpace: 'normalized-image',
        pose: asset.snapshot.pose,
        ...(asset.snapshot.worldPose && asset.snapshot.worldPose.length > 0
          ? { worldPose: asset.snapshot.worldPose }
          : {}),
      }
    : null

  await writeFile(mediaPath(asset.id), bytes)
  try {
    database().prepare(
      `INSERT INTO assets (
        id, session_id, kind, mime_type, created_at, camera_label, width, height, byte_length, inference_json, spatial_json,
        device_id, take_id, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asset.id,
      sessionId,
      asset.kind,
      asset.mimeType,
      asset.createdAt,
      asset.cameraLabel,
      asset.width ?? null,
      asset.height ?? null,
      bytes.byteLength,
      inference ? JSON.stringify(inference) : null,
      spatial ? JSON.stringify(spatial) : null,
      asset.deviceId ?? null,
      asset.takeId ?? null,
      asset.startedAt ?? null,
    )
    database().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
  } catch (error) {
    await unlink(mediaPath(asset.id)).catch(() => undefined)
    throw error
  }
  return getSession(sessionId)
}

export function readAssetFile(id: string) {
  const row = database()
    .prepare('SELECT id, mime_type FROM assets WHERE id = ?')
    .get(id) as { id: string; mime_type: string } | undefined
  if (!row) return undefined
  return { mimeType: row.mime_type, path: mediaPath(id) }
}

export async function deleteAsset(id: string) {
  const row = database().prepare('SELECT id, session_id FROM assets WHERE id = ?').get(id) as
    | { id: string; session_id: string }
    | undefined
  if (!row) return false
  database().prepare('DELETE FROM assets WHERE id = ?').run(id)
  database().prepare('DELETE FROM ball_tracks WHERE asset_id = ?').run(id)
  database().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), row.session_id)
  await unlink(mediaPath(id)).catch(() => undefined)
  return true
}
