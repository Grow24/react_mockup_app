import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { COURT_AREAS, landmarksProblem } from '../shared/court.ts'
import { DATASET_README, dataYaml, TRAIN_SCRIPT, vocXml, yoloLabel } from './dataset.ts'
import { tarGzip, untarGzip } from './tar.ts'
import { uploadToRoboflow } from './roboflow.ts'
import { zip, type ZipEntry } from './zip.ts'
import {
  deleteAsset,
  getSession,
  listModels,
  openStore,
  readAssetFile,
  addTrainingImage,
  applyRestore,
  backupFiles,
  createTake,
  dataStats,
  restoreFolder,
  deleteExercise,
  deleteTrainingImage,
  deleteModel,
  deleteWorkout,
  latestTake,
  mediaPath,
  readModel,
  readTraining,
  readTrainingImage,
  readWorkoutBook,
  saveClasses,
  updateTrainingImage,
  saveExercise,
  saveModel,
  saveWorkout,
  updateModel,
  type ModelDetails,
  saveBallTrack,
  savePoseTrack,
  saveMotionTrack,
  saveCourt,
  saveAsset,
  saveCameras,
  saveSession,
  assetSession,
  sessionKeyHash,
  setSessionKeyHash,
} from './store.ts'
import {
  BALL_TRACK_LIMIT,
  COCO_KEYPOINTS,
  MAX_PEOPLE,
  POSE_TRACK_LIMIT,
  MAX_MODEL_BYTES,
  TRAINING_LIMITS,
  WORKOUT_LIMITS,
  TAKE_LEAD_MS,
  TAKE_SECONDS,
  type AiSnapshot,
  type BallPoint,
  type BallTrack,
  type PersonPose,
  type PoseTrack,
  type MotionTrack,
  type CameraRecord,
  type CourtCalibration,
  type CourtPreset,
  type Device,
  type Exercise,
  type ExerciseKind,
  type TrainingBox,
  type TrainingImage,
  type TrainingSplit,
  type Workout,
  type WorkoutEntry,
  type WorkoutSet,
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Key')
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function isUuid(value: string) {
  return UUID.test(value)
}

const MAX_BALL_TRACK_JSON = 4_000_000
const MAX_POSE_TRACK_JSON = 12_000_000

async function readBody(req: IncomingMessage, limit = MAX_JSON) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) return undefined
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
  if (court.estimatedPoints != null && court.estimatedPoints !== 0 && court.estimatedPoints !== 1) return undefined
  const estimated = court.estimatedPoints ?? 0
  const imagePoints = []
  for (const [index, item] of court.imagePoints.entries()) {
    if (!item || typeof item !== 'object') return undefined
    const point = item as Partial<CourtCalibration['imagePoints'][number]>
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
    const margin = index >= 4 - estimated ? 10 * Math.max(court.sourceWidth, court.sourceHeight) : 50
    if (point.x! < -margin || point.y! < -margin || point.x! > court.sourceWidth + margin || point.y! > court.sourceHeight + margin) {
      return undefined
    }
    imagePoints.push({ x: point.x!, y: point.y! })
  }
  const next: CourtCalibration = {
    preset: court.preset as CourtPreset,
    assetId: court.assetId,
    sourceWidth: court.sourceWidth,
    sourceHeight: court.sourceHeight,
    imagePoints,
  }
  if (court.landmarks != null) {
    if (!Array.isArray(court.landmarks) || court.landmarks.some((id) => typeof id !== 'string')) return undefined
    if (landmarksProblem(next.preset, court.landmarks)) return undefined
    next.landmarks = court.landmarks.slice()
  }
  if (court.callArea != null) {
    if (!COURT_AREAS[next.preset].some((area) => area.id === court.callArea)) return undefined
    next.callArea = court.callArea
  }
  if (estimated) next.estimatedPoints = estimated
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

const PLAYER = /^(near|far)(-2)?$/

function asPerson(value: unknown, width: number, height: number): PersonPose | undefined {
  if (!value || typeof value !== 'object') return undefined
  const person = value as Partial<PersonPose>
  const box = person.box
  if (!box || typeof box !== 'object') return undefined
  if (
    !finiteIn(box.x, -width, width * 2) ||
    !finiteIn(box.y, -height, height * 2) ||
    !finiteIn(box.width, 0, width * 2) ||
    !finiteIn(box.height, 0, height * 2) ||
    !finiteIn(person.score, 0, 1)
  ) {
    return undefined
  }
  if (!Array.isArray(person.keypoints) || person.keypoints.length !== COCO_KEYPOINTS.length * 3) return undefined
  for (let index = 0; index < person.keypoints.length; index += 3) {
    if (
      !finiteIn(person.keypoints[index], -width, width * 2) ||
      !finiteIn(person.keypoints[index + 1], -height, height * 2) ||
      !finiteIn(person.keypoints[index + 2], 0, 1)
    ) {
      return undefined
    }
  }
  const next: PersonPose = {
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    score: person.score,
    keypoints: person.keypoints.slice(),
  }
  if (person.player != null) {
    if (typeof person.player !== 'string' || !PLAYER.test(person.player)) return undefined
    next.player = person.player
  }
  return next
}

function asPoseTrack(value: unknown, assetId: string): PoseTrack | undefined {
  if (!value || typeof value !== 'object') return undefined
  const track = value as Partial<PoseTrack>
  if (track.assetId !== assetId) return undefined
  if (typeof track.modelId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(track.modelId)) return undefined
  if (!finiteIn(track.sourceWidth, 2, 8000) || !finiteIn(track.sourceHeight, 2, 8000)) return undefined
  if (!finiteIn(track.sampleFps, 1, 60) || !finiteIn(track.duration, 0, 3600)) return undefined
  if (!finiteIn(track.createdAt, 0, Number.MAX_SAFE_INTEGER)) return undefined
  if (!Array.isArray(track.frames) || track.frames.length > POSE_TRACK_LIMIT) return undefined
  const frames: PoseTrack['frames'] = []
  for (const item of track.frames) {
    if (!item || typeof item !== 'object' || !finiteIn(item.t, 0, 3600)) return undefined
    if (!Array.isArray(item.people) || item.people.length > MAX_PEOPLE) return undefined
    const people: PersonPose[] = []
    for (const person of item.people) {
      const parsed = asPerson(person, track.sourceWidth, track.sourceHeight)
      if (!parsed) return undefined
      people.push(parsed)
    }
    frames.push({ t: item.t, people })
  }
  return {
    assetId,
    modelId: track.modelId,
    sourceWidth: track.sourceWidth,
    sourceHeight: track.sourceHeight,
    sampleFps: track.sampleFps,
    duration: track.duration,
    createdAt: track.createdAt,
    frames,
  }
}

function asMotionTrack(value: unknown, assetId: string): MotionTrack | undefined {
  if (!value || typeof value !== 'object') return undefined
  const track = value as Partial<MotionTrack>
  if (track.assetId !== assetId || typeof track.referenceId !== 'string' || !isUuid(track.referenceId)) return undefined
  if (!finiteIn(track.sourceWidth, 2, 8000) || !finiteIn(track.sourceHeight, 2, 8000)) return undefined
  if (!finiteIn(track.sampleFps, 1, 60) || !finiteIn(track.duration, 0, 3600)) return undefined
  if (!finiteIn(track.createdAt, 0, Number.MAX_SAFE_INTEGER)) return undefined
  if (!Array.isArray(track.frames) || track.frames.length > POSE_TRACK_LIMIT) return undefined
  const frames: MotionTrack['frames'] = []
  for (const item of track.frames) {
    if (!item || typeof item !== 'object' || !finiteIn(item.t, 0, 3600) || !finiteIn(item.inliers, 0, 100000)) return undefined
    if (!Array.isArray(item.h) || item.h.length !== 9 || !item.h.every((value) => finiteIn(value, -1e7, 1e7))) return undefined
    frames.push({ t: item.t, h: item.h.slice(), inliers: item.inliers })
  }
  return {
    assetId,
    referenceId: track.referenceId,
    sourceWidth: track.sourceWidth,
    sourceHeight: track.sourceHeight,
    sampleFps: track.sampleFps,
    duration: track.duration,
    createdAt: track.createdAt,
    frames,
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
  if (snapshot.people != null) {
    if (!Array.isArray(snapshot.people) || snapshot.people.length > MAX_PEOPLE) return undefined
    const people: PersonPose[] = []
    for (const person of snapshot.people) {
      const parsed = asPerson(person, 8000, 8000)
      if (!parsed) return undefined
      people.push(parsed)
    }
    if (people.length > 0) next.people = people
  }
  if (typeof snapshot.objectModelId === 'string' && /^[a-z0-9-]{1,80}$/.test(snapshot.objectModelId)) {
    next.objectModelId = snapshot.objectModelId
  }
  return next
}

const SLUG = /^[a-z0-9-]{1,80}$/i

function asClasses(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > TRAINING_LIMITS.classes) return undefined
  const classes = value.map((item) => (typeof item === 'string' ? item.trim().slice(0, 60) : ''))
  if (classes.some((name) => !name) || new Set(classes).size !== classes.length) return undefined
  return classes
}

// Boxes are clamped into the image; empty or out-of-range ones make the request invalid.
function asBoxes(value: unknown, width: number, height: number, classCount: number): TrainingBox[] | undefined {
  if (!Array.isArray(value) || value.length > TRAINING_LIMITS.boxes) return undefined
  const boxes: TrainingBox[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const box = item as Partial<TrainingBox>
    const classId = box.classId
    if (typeof classId !== 'number' || !Number.isInteger(classId) || classId < 0 || classId >= classCount) return undefined
    const numbers = [box.x, box.y, box.width, box.height]
    if (numbers.some((number) => typeof number !== 'number' || !Number.isFinite(number))) return undefined
    const x = Math.min(width, Math.max(0, box.x!))
    const y = Math.min(height, Math.max(0, box.y!))
    const right = Math.min(width, Math.max(0, box.x! + box.width!))
    const bottom = Math.min(height, Math.max(0, box.y! + box.height!))
    if (right - x < 1 || bottom - y < 1) return undefined
    boxes.push({ classId, x, y, width: right - x, height: bottom - y })
  }
  return boxes
}

function asSplit(value: unknown): TrainingSplit | undefined {
  return value === 'train' || value === 'val' ? value : undefined
}

function trainingName(image: TrainingImage, index: number) {
  return `${String(index + 1).padStart(5, '0')}-${image.id.slice(0, 8)}.jpg`
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, WORKOUT_LIMITS.text) : ''
}

function measure(value: unknown, max: number, integer = false) {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return null
  if (integer && !Number.isInteger(value)) return null
  return value
}

function asWorkoutSet(value: unknown): WorkoutSet | undefined {
  if (!value || typeof value !== 'object') return undefined
  const set = value as Partial<WorkoutSet>
  if (typeof set.id !== 'string' || !SLUG.test(set.id) || typeof set.done !== 'boolean') return undefined
  const next: WorkoutSet = { id: set.id, done: set.done }
  const fields = [
    ['reps', 1000, true],
    ['weightKg', 1000, false],
    ['seconds', 86_400, false],
    ['meters', 1_000_000, false],
    ['rpe', 10, false],
    ['doneAt', Number.MAX_SAFE_INTEGER, true],
  ] as const
  for (const [key, max, integer] of fields) {
    const read = measure(set[key], max, integer)
    if (read === null) return undefined
    if (read !== undefined) next[key] = read
  }
  return next
}

function asWorkout(value: unknown, id: string): Workout | undefined {
  if (!value || typeof value !== 'object') return undefined
  const workout = value as Partial<Workout>
  if (workout.id !== id) return undefined
  const startedAt = measure(workout.startedAt, Number.MAX_SAFE_INTEGER, true)
  const updatedAt = measure(workout.updatedAt, Number.MAX_SAFE_INTEGER, true)
  const finishedAt = measure(workout.finishedAt, Number.MAX_SAFE_INTEGER, true)
  if (startedAt == null || updatedAt == null || finishedAt === null) return undefined
  if (!Array.isArray(workout.entries) || workout.entries.length > WORKOUT_LIMITS.entries) return undefined
  const entries: WorkoutEntry[] = []
  for (const item of workout.entries) {
    if (!item || typeof item !== 'object') return undefined
    const entry = item as Partial<WorkoutEntry>
    if (typeof entry.id !== 'string' || !SLUG.test(entry.id)) return undefined
    if (typeof entry.exerciseId !== 'string' || !SLUG.test(entry.exerciseId)) return undefined
    if (!Array.isArray(entry.sets) || entry.sets.length > WORKOUT_LIMITS.sets) return undefined
    const sets = entry.sets.map(asWorkoutSet)
    if (sets.some((set) => !set)) return undefined
    const next: WorkoutEntry = { id: entry.id, exerciseId: entry.exerciseId, sets: sets as WorkoutSet[] }
    if (text(entry.note)) next.note = text(entry.note)
    entries.push(next)
  }
  const next: Workout = { id, name: text(workout.name) || 'Workout', startedAt, updatedAt, entries }
  if (finishedAt !== undefined) next.finishedAt = finishedAt
  if (text(workout.note)) next.note = text(workout.note)
  return next
}

const EXERCISE_KINDS: ExerciseKind[] = ['strength', 'bodyweight', 'cardio', 'timed']

function asExercise(value: unknown, id: string): Exercise | undefined {
  if (!value || typeof value !== 'object') return undefined
  const exercise = value as Partial<Exercise>
  if (exercise.id !== id || !text(exercise.name) || !EXERCISE_KINDS.includes(exercise.kind as ExerciseKind)) return undefined
  const muscles = Array.isArray(exercise.muscles) ? exercise.muscles.map(text).filter(Boolean).slice(0, 12) : []
  return {
    id,
    name: text(exercise.name).slice(0, 80),
    kind: exercise.kind as ExerciseKind,
    muscles,
    equipment: text(exercise.equipment).slice(0, 80),
    cue: text(exercise.cue),
  }
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

// A session key is 256 random bits. Only its hash is stored. Browsers hold it in an HttpOnly
// cookie so <img> and <video> requests carry it; native apps send it as X-Session-Key.
function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex')
}

function keyCookie(sessionId: string) {
  return `pbmp_key_${sessionId.replace(/-/g, '')}`
}

function presentedKey(req: IncomingMessage, sessionId: string) {
  const header = req.headers['x-session-key']
  if (typeof header === 'string' && header) return header
  const name = keyCookie(sessionId)
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return null
}

function keyMatches(hash: string, key: string | null) {
  if (!key) return false
  const given = Buffer.from(hashKey(key), 'hex')
  const stored = Buffer.from(hash, 'hex')
  return given.length === stored.length && timingSafeEqual(given, stored)
}

function canUseSession(req: IncomingMessage, sessionId: string) {
  const hash = sessionKeyHash(sessionId)
  if (hash === undefined) return 'missing' as const
  return hash === null || keyMatches(hash, presentedKey(req, sessionId)) ? ('allowed' as const) : ('denied' as const)
}

function rememberKey(req: IncomingMessage, res: ServerResponse, sessionId: string, key: string) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || (req.socket as { encrypted?: boolean }).encrypted
  res.setHeader(
    'Set-Cookie',
    `${keyCookie(sessionId)}=${encodeURIComponent(key)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
  )
}

// Backups are off unless ADMIN_TOKEN is set; the token goes in an Authorization: Bearer header.
const MAX_RESTORE_BYTES = 50 * 1024 * 1024 * 1024

function adminAllowed(req: IncomingMessage) {
  const token = process.env.ADMIN_TOKEN ?? ''
  if (token.length < 16) return false
  const given = Buffer.from(createHash('sha256').update((req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')).digest('hex'), 'hex')
  const wanted = Buffer.from(createHash('sha256').update(token).digest('hex'), 'hex')
  return timingSafeEqual(given, wanted)
}

function newKey() {
  return randomBytes(32).toString('base64url')
}

// Which session a request belongs to, so one check guards every route.
function owningSession(parts: string[], url: URL) {
  const id = parts[2] ?? ''
  if (parts[1] === 'sessions' && parts.length >= 3 && isUuid(id)) return id
  if (!isUuid(id)) return url.pathname === '/api/fetch-model' ? (url.searchParams.get('session') ?? '') : null
  if (parts[1] === 'assets') return assetSession(id) ?? null
  if (parts[1] === 'custom-models') return readModel(id.toLowerCase())?.sessionId ?? null
  if (parts[1] === 'training-images') return readTrainingImage(id.toLowerCase())?.sessionId ?? null
  return null
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
    const access = canUseSession(req, id)
    if (access === 'denied') {
      sendJson(res, 403, { error: 'This session is private. Open it with its full link.' })
      return
    }
    if (access === 'missing') {
      const key = newKey()
      saveSession(id, device)
      setSessionKeyHash(id, hashKey(key))
      rememberKey(req, res, id, key)
      sendJson(res, 200, { ...getSession(id), key })
      return
    }
    sendJson(res, 200, getSession(id))
    return
  }

  // Opening a shared link: a correct key is kept as a cookie for this browser.
  if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'unlock' && parts.length === 4 && req.method === 'POST') {
    const id = parts[2] ?? ''
    const body = (await readBody(req)) as { key?: unknown } | undefined
    const hash = isUuid(id) ? sessionKeyHash(id) : undefined
    if (hash === undefined) {
      sendJson(res, 404, { error: 'Session was not found.' })
      return
    }
    const key = typeof body?.key === 'string' ? body.key : ''
    if (hash !== null && !keyMatches(hash, key)) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      sendJson(res, 403, { error: 'That session key is not right.' })
      return
    }
    if (hash !== null) rememberKey(req, res, id, key)
    sendJson(res, 200, getSession(id))
    return
  }

  if (parts[0] === 'api' && parts[1] === 'admin') {
    if (!adminAllowed(req)) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      sendJson(res, 404, { error: 'Not found.' })
      return
    }
    if (parts[2] === 'stats' && req.method === 'GET') {
      sendJson(res, 200, dataStats())
      return
    }
    if (parts[2] === 'backup' && req.method === 'GET') {
      const backup = backupFiles()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="pbmp-backup-${stamp}.tar.gz"`,
        'Cache-Control': 'no-store',
      })
      await pipeline(tarGzip(backup.files), res).catch((error) => {
        console.error('Backup stopped', error)
        res.destroy()
      })
      backup.cleanup()
      return
    }
    if (parts[2] === 'restore' && req.method === 'POST') {
      if (dataStats().sessions > 0) {
        sendJson(res, 409, { error: 'This server already has sessions, so it was not overwritten.' })
        return
      }
      const folder = restoreFolder()
      try {
        await untarGzip(req, folder, MAX_RESTORE_BYTES)
        sendJson(res, 200, applyRestore(folder))
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'The backup could not be restored.' })
      }
      return
    }
    sendJson(res, 404, { error: 'Not found.' })
    return
  }

  const owner = parts[0] === 'api' ? owningSession(parts, url) : null
  if (owner !== null) {
    const access = isUuid(owner) ? canUseSession(req, owner) : 'missing'
    if (access === 'missing' && url.pathname === '/api/fetch-model') {
      sendJson(res, 400, { error: 'Model links are fetched for a session.' })
      return
    }
    if (access === 'denied') {
      sendJson(res, 403, { error: 'This session is private. Open it with its full link.' })
      return
    }
  }

  // An open session from before keys existed can be made private; whoever holds the link today does it.
  if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'lock' && parts.length === 4 && req.method === 'POST') {
    const id = parts[2]!
    const hash = sessionKeyHash(id)
    if (hash === undefined) {
      sendJson(res, 404, { error: 'Session was not found.' })
      return
    }
    if (hash !== null) {
      sendJson(res, 409, { error: 'This session is already private.' })
      return
    }
    const key = newKey()
    setSessionKeyHash(id, hashKey(key))
    rememberKey(req, res, id, key)
    sendJson(res, 200, { ...getSession(id), key })
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

  if (parts[0] === 'api' && parts[1] === 'sessions' && isUuid(parts[2] ?? '') && (parts[3] === 'workouts' || parts[3] === 'exercises')) {
    const sessionId = parts[2]!
    if (parts[3] === 'workouts' && parts.length === 4 && req.method === 'GET') {
      const book = readWorkoutBook(sessionId)
      if (!book) {
        sendJson(res, 404, { error: 'Session was not found.' })
        return
      }
      sendJson(res, 200, book)
      return
    }
    const id = parts[4] ?? ''
    if (parts.length !== 5 || (parts[3] === 'workouts' ? !isUuid(id) : !SLUG.test(id))) {
      sendJson(res, 400, { error: 'The id is not valid.' })
      return
    }
    let result: unknown
    if (req.method === 'PUT') {
      const body = await readBody(req)
      if (!body) {
        sendJson(res, 413, { error: 'That is too large to save.' })
        return
      }
      const parsed = parts[3] === 'workouts' ? asWorkout(body, id) : asExercise(body, id)
      if (!parsed) {
        sendJson(res, 400, { error: parts[3] === 'workouts' ? 'The workout is not valid.' : 'The exercise is not valid.' })
        return
      }
      result =
        parts[3] === 'workouts' ? saveWorkout(sessionId, parsed as Workout) : saveExercise(sessionId, parsed as Exercise)
    } else if (req.method === 'DELETE') {
      result = parts[3] === 'workouts' ? deleteWorkout(sessionId, id) : deleteExercise(sessionId, id)
    } else {
      sendJson(res, 405, { error: 'Use PUT or DELETE.' })
      return
    }
    if (result === undefined) {
      sendJson(res, 404, { error: 'Session was not found.' })
      return
    }
    if (result === 'conflict') {
      sendJson(res, 409, { error: 'That id belongs to another session.' })
      return
    }
    sendJson(res, 200, { saved: result })
    return
  }

  if (parts[0] === 'api' && parts[1] === 'sessions' && isUuid(parts[2] ?? '') && parts[3] === 'training') {
    const sessionId = parts[2]!
    const set = readTraining(sessionId)
    if (!set) {
      sendJson(res, 404, { error: 'Session was not found.' })
      return
    }
    if (parts.length === 4 && req.method === 'GET') {
      sendJson(res, 200, set)
      return
    }
    if (parts.length === 5 && parts[4] === 'classes' && req.method === 'PUT') {
      const body = (await readBody(req)) as { classes?: unknown } | undefined
      const classes = asClasses(body?.classes)
      const highest = Math.max(-1, ...set.images.flatMap((image) => image.boxes.map((box) => box.classId)))
      if (!classes || classes.length <= highest) {
        sendJson(res, 400, { error: 'Classes must be unique names, and boxes already use the first ' + (highest + 1) + '.' })
        return
      }
      sendJson(res, 200, saveClasses(sessionId, classes))
      return
    }
    if (parts.length === 5 && parts[4] === 'images' && req.method === 'POST') {
      if (set.images.length >= TRAINING_LIMITS.images) {
        sendJson(res, 413, { error: `A training set holds up to ${TRAINING_LIMITS.images} images.` })
        return
      }
      const form = await (await formRequest(req)).formData()
      const file = form.get('file')
      const metaText = form.get('meta')
      if (!(file instanceof File) || typeof metaText !== 'string' || file.size > TRAINING_LIMITS.imageBytes) {
        sendJson(res, 400, { error: 'A JPEG of up to 20 MB and its details are required.' })
        return
      }
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(metaText) as Record<string, unknown>
      } catch {
        sendJson(res, 400, { error: 'Image details could not be read.' })
        return
      }
      const width = meta.width
      const height = meta.height
      const sizeOk = [width, height].every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 8 && value <= 8000)
      const boxes = sizeOk ? asBoxes(meta.boxes ?? [], width as number, height as number, set.classes.length) : undefined
      const split = asSplit(meta.split)
      const source = meta.sourceAssetId
      const frameTime = meta.frameTime
      if (
        typeof meta.id !== 'string' ||
        !isUuid(meta.id) ||
        !boxes ||
        !split ||
        (source != null && (typeof source !== 'string' || !isUuid(source))) ||
        (frameTime != null && !finiteIn(frameTime, 0, 86_400))
      ) {
        sendJson(res, 400, { error: 'Image details are not valid.' })
        return
      }
      const bytes = Buffer.from(await file.arrayBuffer())
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        sendJson(res, 400, { error: 'Training images must be JPEG.' })
        return
      }
      const image: Omit<TrainingImage, 'sessionId' | 'fileUrl' | 'createdAt'> = {
        id: meta.id.toLowerCase(),
        width: width as number,
        height: height as number,
        boxes,
        split,
      }
      if (typeof source === 'string') image.sourceAssetId = source
      if (typeof frameTime === 'number') image.frameTime = frameTime
      const saved = await addTrainingImage(sessionId, image, bytes)
      if (saved === 'conflict') {
        sendJson(res, 409, { error: 'That image id is already used.' })
        return
      }
      sendJson(res, 200, saved)
      return
    }
    if (parts.length === 5 && parts[4] === 'export' && req.method === 'GET') {
      const labeledOnly = url.searchParams.get('labeled') === '1'
      const images = set.images.filter((image) => !labeledOnly || image.boxes.length > 0)
      const entries: ZipEntry[] = [
        { name: 'data.yaml', data: Buffer.from(dataYaml(set.classes)) },
        { name: 'train.py', data: Buffer.from(TRAIN_SCRIPT) },
        { name: 'README.txt', data: Buffer.from(DATASET_README) },
      ]
      for (const [index, image] of images.entries()) {
        const name = trainingName(image, index)
        const stored = mediaPath(image.id)
        if (!existsSync(stored)) continue
        entries.push({ name: `images/${image.split}/${name}`, data: await readFile(stored) })
        entries.push({ name: `labels/${image.split}/${name.replace(/\.jpg$/, '.txt')}`, data: Buffer.from(yoloLabel(image.boxes, image.width, image.height)) })
      }
      const archive = zip(entries)
      cors(res)
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': archive.length,
        'Content-Disposition': `attachment; filename="pbmp-dataset-${sessionId.slice(0, 8)}.zip"`,
        'Cache-Control': 'no-store',
      })
      res.end(archive)
      return
    }
    if (parts.length === 5 && parts[4] === 'roboflow' && req.method === 'POST') {
      const body = (await readBody(req)) as { apiKey?: unknown; project?: unknown } | undefined
      const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
      const project = typeof body?.project === 'string' ? body.project.trim().toLowerCase() : ''
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(apiKey) || !/^[a-z0-9_-]{1,100}$/.test(project)) {
        sendJson(res, 400, { error: 'Enter a Roboflow API key and the project id from its URL.' })
        return
      }
      const images = []
      for (const [index, image] of set.images.entries()) {
        if (image.boxes.length === 0 || !existsSync(mediaPath(image.id))) continue
        const name = trainingName(image, index)
        images.push({
          name,
          bytes: await readFile(mediaPath(image.id)),
          split: image.split === 'val' ? ('valid' as const) : ('train' as const),
          xml: vocXml(name, image, set.classes),
        })
      }
      if (images.length === 0) {
        sendJson(res, 400, { error: 'Label at least one image first.' })
        return
      }
      sendJson(res, 200, await uploadToRoboflow(apiKey, project, images))
      return
    }
    sendJson(res, 404, { error: 'Not found.' })
    return
  }

  if (parts[0] === 'api' && parts[1] === 'training-images' && isUuid(parts[2] ?? '')) {
    const id = parts[2]!.toLowerCase()
    const image = readTrainingImage(id)
    if (!image) {
      sendJson(res, 404, { error: 'Training image was not found.' })
      return
    }
    if (parts.length === 4 && parts[3] === 'file' && req.method === 'GET') {
      const stored = mediaPath(id)
      cors(res)
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': statSync(stored).size, 'Cache-Control': 'public, max-age=31536000, immutable' })
      await pipeline(createReadStream(stored), res).catch(() => undefined)
      return
    }
    if (parts.length === 3 && req.method === 'PUT') {
      const body = (await readBody(req)) as { boxes?: unknown; split?: unknown } | undefined
      const classes = readTraining(image.sessionId)?.classes ?? []
      const boxes = asBoxes(body?.boxes, image.width, image.height, classes.length)
      const split = asSplit(body?.split ?? image.split)
      if (!boxes || !split) {
        sendJson(res, 400, { error: 'Boxes are not valid.' })
        return
      }
      sendJson(res, 200, updateTrainingImage(id, boxes, split))
      return
    }
    if (parts.length === 3 && req.method === 'DELETE') {
      await deleteTrainingImage(id)
      sendJson(res, 200, { ok: true })
      return
    }
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
      const body = await readBody(req, MAX_BALL_TRACK_JSON)
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

  if (
    parts[0] === 'api' &&
    parts[1] === 'assets' &&
    parts[3] === 'pose-track' &&
    parts.length === 4 &&
    (req.method === 'PUT' || req.method === 'DELETE')
  ) {
    const assetId = parts[2]!
    if (!isUuid(assetId)) {
      sendJson(res, 400, { error: 'Asset id is not valid.' })
      return
    }
    let track: PoseTrack | null = null
    if (req.method === 'PUT') {
      const body = await readBody(req, MAX_POSE_TRACK_JSON)
      if (!body) {
        sendJson(res, 413, { error: 'Pose track is too large.' })
        return
      }
      const parsed = asPoseTrack(body, assetId)
      if (!parsed) {
        sendJson(res, 400, { error: 'Pose track is not valid.' })
        return
      }
      track = parsed
    }
    const session = savePoseTrack(assetId, track)
    if (!session) {
      sendJson(res, 404, { error: 'File was not found.' })
      return
    }
    sendJson(res, 200, session)
    return
  }

  if (
    parts[0] === 'api' &&
    parts[1] === 'assets' &&
    parts[3] === 'motion-track' &&
    parts.length === 4 &&
    (req.method === 'PUT' || req.method === 'DELETE')
  ) {
    const assetId = parts[2]!
    if (!isUuid(assetId)) {
      sendJson(res, 400, { error: 'Asset id is not valid.' })
      return
    }
    let track: MotionTrack | null = null
    if (req.method === 'PUT') {
      const body = await readBody(req, MAX_BALL_TRACK_JSON)
      if (!body) {
        sendJson(res, 413, { error: 'Motion track is too large.' })
        return
      }
      const parsed = asMotionTrack(body, assetId)
      if (!parsed) {
        sendJson(res, 400, { error: 'Motion track is not valid.' })
        return
      }
      track = parsed
    }
    const session = saveMotionTrack(assetId, track)
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
    // Cross-origin isolation lets the ONNX worker use threads. require-corp works in Safari too; every
    // CDN file the app loads answers with CORS or Cross-Origin-Resource-Policy.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
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
