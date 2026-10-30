import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
  type CustomModel,
  type Device,
  type Exercise,
  type TrainingBox,
  type TrainingImage,
  type TrainingSplit,
  type Workout,
  type InferenceResult,
  type MediaAssetRecord,
  type SessionDetail,
  type SpatialResult,
  type Take,
} from '../shared/contracts.ts'

let mediaDir = path.join(path.resolve(process.cwd(), 'server/data'), 'media')
let dataDir = path.resolve(process.cwd(), 'server/data')
let db: DatabaseSync | undefined
let DatabaseCtor: typeof import('node:sqlite').DatabaseSync | undefined

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
  CREATE TABLE IF NOT EXISTS custom_models (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    input_size INTEGER NOT NULL,
    labels_json TEXT NOT NULL,
    ball_classes_json TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workouts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    workout_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS exercises (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    exercise_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_sets (
    session_id TEXT PRIMARY KEY,
    classes_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_images (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    source_asset_id TEXT,
    frame_time REAL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    boxes_json TEXT NOT NULL,
    split TEXT NOT NULL
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
const addedColumns = [
  ['assets', 'device_id', 'TEXT'],
  ['assets', 'take_id', 'TEXT'],
  ['assets', 'started_at', 'INTEGER'],
  ['sessions', 'key_hash', 'TEXT'],
] as const

function migrate(opened: DatabaseSync) {
  for (const [table, name, type] of addedColumns) {
    const present = (opened.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((column) => column.name === name)
    if (!present) opened.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
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
  DatabaseCtor = DatabaseSyncCtor
  const preferred = path.resolve(process.cwd(), process.env.PBMP_DATA_DIR || 'server/data')
  try {
    const opened = openAt(DatabaseSyncCtor, preferred)
    db = opened.opened
    mediaDir = opened.media
    dataDir = preferred
    console.log(`PBMP data directory ${preferred}`)
    return
  } catch (error) {
    console.error(`Could not open ${preferred}. Using /tmp/pbmp-data.`, error)
  }
  const fallback = '/tmp/pbmp-data'
  const opened = openAt(DatabaseSyncCtor, fallback)
  db = opened.opened
  mediaDir = opened.media
  dataDir = fallback
  console.log(`PBMP data directory ${fallback}`)
}

export type DataStats = { sessions: number; assets: number; workouts: number; models: number; trainingImages: number; mediaFiles: number; mediaBytes: number }

export function dataStats(): DataStats {
  const count = (table: string) => (database().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  let mediaFiles = 0
  let mediaBytes = 0
  for (const name of existsSync(mediaDir) ? readdirSync(mediaDir) : []) {
    mediaFiles += 1
    mediaBytes += statSync(path.join(mediaDir, name)).size
  }
  return {
    sessions: count('sessions'),
    assets: count('assets'),
    workouts: (database().prepare('SELECT COUNT(*) AS n FROM workouts WHERE deleted = 0').get() as { n: number }).n,
    models: count('custom_models'),
    trainingImages: count('training_images'),
    mediaFiles,
    mediaBytes,
  }
}

// A consistent copy of the database plus every media file, ready to stream as a tar archive.
export function backupFiles() {
  const folder = path.join(tmpdir(), `pbmp-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(folder, { recursive: true })
  const snapshot = path.join(folder, 'pbmp.sqlite')
  database().prepare('VACUUM INTO ?').run(snapshot)
  const files = [{ name: 'pbmp.sqlite', path: snapshot, size: statSync(snapshot).size, mtime: Date.now() }]
  for (const name of existsSync(mediaDir) ? readdirSync(mediaDir) : []) {
    const file = path.join(mediaDir, name)
    const info = statSync(file)
    if (info.isFile()) files.push({ name: `media/${name}`, path: file, size: info.size, mtime: info.mtimeMs })
  }
  return { files, cleanup: () => rmSync(folder, { recursive: true, force: true }) }
}

export function restoreFolder() {
  const folder = path.join(dataDir, `.restore-${Date.now()}`)
  mkdirSync(folder, { recursive: true })
  return folder
}

// Swaps in an unpacked backup. Only an empty store is replaced, so a restore never overwrites data.
export function applyRestore(folder: string) {
  if (!DatabaseCtor) throw new Error('The session store is not open.')
  if (dataStats().sessions > 0) throw new Error('This server already has sessions, so it was not overwritten.')
  if (!existsSync(path.join(folder, 'pbmp.sqlite'))) throw new Error('The backup has no pbmp.sqlite.')
  database().close()
  db = undefined
  const media = path.join(dataDir, 'media')
  rmSync(path.join(dataDir, 'pbmp.sqlite'), { force: true })
  rmSync(media, { recursive: true, force: true })
  renameSync(path.join(folder, 'pbmp.sqlite'), path.join(dataDir, 'pbmp.sqlite'))
  if (existsSync(path.join(folder, 'media'))) renameSync(path.join(folder, 'media'), media)
  rmSync(folder, { recursive: true, force: true })
  const opened = openAt(DatabaseCtor, dataDir)
  db = opened.opened
  mediaDir = opened.media
  return dataStats()
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
    locked: sessionKeyHash(id) != null,
    device: JSON.parse(row.device_json) as Device,
    cameras: camerasFor(id),
    assets: assetsFor(id),
    court: courts[0] ?? null,
    courts,
    ballTracks: readBallTracks(id),
    models: modelsFor(id),
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
      if (court.landmarks) clean.landmarks = court.landmarks
      if (court.callArea) clean.callArea = court.callArea
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

type ModelRow = {
  id: string
  session_id: string
  name: string
  input_size: number
  labels_json: string
  ball_classes_json: string
  byte_length: number
  created_at: number
}

function toModel(row: ModelRow): CustomModel {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    inputSize: row.input_size,
    labels: JSON.parse(row.labels_json) as string[],
    ballClasses: JSON.parse(row.ball_classes_json) as number[],
    byteLength: row.byte_length,
    createdAt: row.created_at,
    fileUrl: `/api/custom-models/${row.id}/file`,
  }
}

function modelsFor(sessionId: string) {
  const rows = database()
    .prepare('SELECT * FROM custom_models WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as ModelRow[]
  return rows.map(toModel)
}

export function readModel(id: string) {
  const row = database().prepare('SELECT * FROM custom_models WHERE id = ?').get(id) as ModelRow | undefined
  return row ? toModel(row) : undefined
}

export type ModelDetails = Pick<CustomModel, 'name' | 'inputSize' | 'labels' | 'ballClasses'>

export async function saveModel(sessionId: string, id: string, details: ModelDetails, bytes: Buffer) {
  if (!sessionById(sessionId)) return undefined
  if (readModel(id)) return 'conflict' as const
  await writeFile(mediaPath(id), bytes)
  try {
    database()
      .prepare(
        `INSERT INTO custom_models (id, session_id, name, input_size, labels_json, ball_classes_json, byte_length, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        details.name,
        details.inputSize,
        JSON.stringify(details.labels),
        JSON.stringify(details.ballClasses),
        bytes.byteLength,
        Date.now(),
      )
  } catch (error) {
    await unlink(mediaPath(id)).catch(() => undefined)
    throw error
  }
  return getSession(sessionId)
}

export function updateModel(id: string, details: ModelDetails) {
  const model = readModel(id)
  if (!model) return undefined
  database()
    .prepare('UPDATE custom_models SET name = ?, input_size = ?, labels_json = ?, ball_classes_json = ? WHERE id = ?')
    .run(details.name, details.inputSize, JSON.stringify(details.labels), JSON.stringify(details.ballClasses), id)
  return getSession(model.sessionId)
}

export async function deleteModel(id: string) {
  const model = readModel(id)
  if (!model) return undefined
  database().prepare('DELETE FROM custom_models WHERE id = ?').run(id)
  await unlink(mediaPath(id)).catch(() => undefined)
  return getSession(model.sessionId)
}

export function readWorkoutBook(sessionId: string) {
  if (!sessionById(sessionId)) return undefined
  const rows = database()
    .prepare('SELECT id, deleted, workout_json FROM workouts WHERE session_id = ? ORDER BY updated_at DESC')
    .all(sessionId) as { id: string; deleted: number; workout_json: string }[]
  const workouts: Workout[] = []
  const deleted: string[] = []
  for (const row of rows) {
    if (row.deleted) deleted.push(row.id)
    else workouts.push(JSON.parse(row.workout_json) as Workout)
  }
  const exercises = (
    database().prepare('SELECT exercise_json FROM exercises WHERE session_id = ?').all(sessionId) as { exercise_json: string }[]
  ).map((row) => JSON.parse(row.exercise_json) as Exercise)
  return { workouts, exercises, deleted }
}

type StoredWorkout = { session_id: string; updated_at: number; deleted: number; workout_json: string }

function storedWorkout(id: string) {
  return database().prepare('SELECT session_id, updated_at, deleted, workout_json FROM workouts WHERE id = ?').get(id) as
    | StoredWorkout
    | undefined
}

// Two phones can edit the same workout; the newer edit wins and a deletion stays deleted.
export function saveWorkout(sessionId: string, workout: Workout) {
  if (!sessionById(sessionId)) return undefined
  const stored = storedWorkout(workout.id)
  if (stored && stored.session_id !== sessionId) return 'conflict' as const
  if (stored && (stored.deleted || stored.updated_at >= workout.updatedAt)) {
    return stored.deleted ? null : (JSON.parse(stored.workout_json) as Workout)
  }
  database()
    .prepare(
      `INSERT INTO workouts (id, session_id, updated_at, deleted, workout_json) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, workout_json = excluded.workout_json`,
    )
    .run(workout.id, sessionId, workout.updatedAt, JSON.stringify(workout))
  return workout
}

export function deleteWorkout(sessionId: string, id: string) {
  if (!sessionById(sessionId)) return undefined
  const stored = storedWorkout(id)
  if (stored && stored.session_id !== sessionId) return 'conflict' as const
  database()
    .prepare(
      `INSERT INTO workouts (id, session_id, updated_at, deleted, workout_json) VALUES (?, ?, ?, 1, '{}')
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1, workout_json = '{}'`,
    )
    .run(id, sessionId, Date.now())
  return true
}

export function saveExercise(sessionId: string, exercise: Exercise) {
  if (!sessionById(sessionId)) return undefined
  const stored = database().prepare('SELECT session_id FROM exercises WHERE id = ?').get(exercise.id) as
    | { session_id: string }
    | undefined
  if (stored && stored.session_id !== sessionId) return 'conflict' as const
  database()
    .prepare(
      `INSERT INTO exercises (id, session_id, exercise_json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET exercise_json = excluded.exercise_json`,
    )
    .run(exercise.id, sessionId, JSON.stringify(exercise))
  return exercise
}

export function deleteExercise(sessionId: string, id: string) {
  if (!sessionById(sessionId)) return undefined
  database().prepare('DELETE FROM exercises WHERE id = ? AND session_id = ?').run(id, sessionId)
  return true
}

type TrainingRow = {
  id: string
  session_id: string
  source_asset_id: string | null
  frame_time: number | null
  width: number
  height: number
  created_at: number
  boxes_json: string
  split: string
}

function toTrainingImage(row: TrainingRow): TrainingImage {
  const image: TrainingImage = {
    id: row.id,
    sessionId: row.session_id,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    boxes: JSON.parse(row.boxes_json) as TrainingBox[],
    split: row.split === 'val' ? 'val' : 'train',
    fileUrl: `/api/training-images/${row.id}/file`,
  }
  if (row.source_asset_id) image.sourceAssetId = row.source_asset_id
  if (row.frame_time != null) image.frameTime = row.frame_time
  return image
}

export const DEFAULT_CLASSES = ['ball', 'player']

export function readTraining(sessionId: string) {
  if (!sessionById(sessionId)) return undefined
  const row = database().prepare('SELECT classes_json FROM training_sets WHERE session_id = ?').get(sessionId) as
    | { classes_json: string }
    | undefined
  const images = (
    database().prepare('SELECT * FROM training_images WHERE session_id = ? ORDER BY created_at').all(sessionId) as TrainingRow[]
  ).map(toTrainingImage)
  return { classes: row ? (JSON.parse(row.classes_json) as string[]) : DEFAULT_CLASSES, images }
}

export function saveClasses(sessionId: string, classes: string[]) {
  if (!sessionById(sessionId)) return undefined
  database()
    .prepare(
      'INSERT INTO training_sets (session_id, classes_json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET classes_json = excluded.classes_json',
    )
    .run(sessionId, JSON.stringify(classes))
  return readTraining(sessionId)
}

export function readTrainingImage(id: string) {
  const row = database().prepare('SELECT * FROM training_images WHERE id = ?').get(id) as TrainingRow | undefined
  return row ? toTrainingImage(row) : undefined
}

export async function addTrainingImage(
  sessionId: string,
  image: Omit<TrainingImage, 'sessionId' | 'fileUrl' | 'createdAt'>,
  bytes: Buffer,
) {
  if (!sessionById(sessionId)) return undefined
  if (readTrainingImage(image.id)) return 'conflict' as const
  await writeFile(mediaPath(image.id), bytes)
  database()
    .prepare(
      `INSERT INTO training_images (id, session_id, source_asset_id, frame_time, width, height, created_at, boxes_json, split)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      image.id,
      sessionId,
      image.sourceAssetId ?? null,
      image.frameTime ?? null,
      image.width,
      image.height,
      Date.now(),
      JSON.stringify(image.boxes),
      image.split,
    )
  return readTrainingImage(image.id)
}

export function updateTrainingImage(id: string, boxes: TrainingBox[], split: TrainingSplit) {
  if (!readTrainingImage(id)) return undefined
  database().prepare('UPDATE training_images SET boxes_json = ?, split = ? WHERE id = ?').run(JSON.stringify(boxes), split, id)
  return readTrainingImage(id)
}

export async function deleteTrainingImage(id: string) {
  if (!readTrainingImage(id)) return false
  database().prepare('DELETE FROM training_images WHERE id = ?').run(id)
  await unlink(mediaPath(id)).catch(() => undefined)
  return true
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

/** The stored hash of a session's key: null for an open session, undefined for no such session. */
export function sessionKeyHash(id: string) {
  const row = database().prepare('SELECT key_hash FROM sessions WHERE id = ?').get(id) as { key_hash: string | null } | undefined
  return row ? row.key_hash : undefined
}

export function setSessionKeyHash(id: string, hash: string) {
  database().prepare('UPDATE sessions SET key_hash = ?, updated_at = ? WHERE id = ?').run(hash, Date.now(), id)
}

export function assetSession(id: string) {
  const row = database().prepare('SELECT session_id FROM assets WHERE id = ?').get(id) as { session_id: string } | undefined
  return row?.session_id
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
