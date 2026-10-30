import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { BALL_TRACK_LIMIT, type SessionDetail, type TrainingSet, type Workout } from '../../shared/contracts.ts'
import { json, send, startServer, uuid, type TestServer } from '../helpers/server.ts'

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z',
  'base64',
)

let server: TestServer
let roboflow: Server
const roboflowLog: { path: string; query: URLSearchParams; body: string }[] = []

before(async () => {
  roboflow = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const url = new URL(req.url ?? '/', 'http://x')
    roboflowLog.push({ path: url.pathname, query: url.searchParams, body: Buffer.concat(chunks).toString() })
    res.setHeader('Content-Type', 'application/json')
    if (url.searchParams.get('api_key') !== 'test_key_123456') {
      res.statusCode = 401
      res.end(JSON.stringify({ error: { message: 'This API key does not exist.' } }))
      return
    }
    res.end(JSON.stringify(url.pathname.endsWith('/upload') ? { success: true, id: `img${roboflowLog.length}` } : { success: true }))
  })
  await new Promise<void>((resolve) => roboflow.listen(0, '127.0.0.1', resolve))
  const address = roboflow.address() as { port: number }
  server = await startServer({ ROBOFLOW_API_URL: `http://127.0.0.1:${address.port}` })
})

after(async () => {
  await server?.stop()
  await new Promise((resolve) => roboflow?.close(resolve))
})

let key = ''

async function newSession() {
  const id = uuid()
  const { status, body } = await json<SessionDetail>(send(server.base, 'POST', '/api/sessions', { id, device: { id: uuid(), label: 'test' } }))
  assert.equal(status, 200)
  assert.ok(body.locked && body.key, 'a new session is private and comes with its key')
  key = body.key!
  return body
}

// The tests act as a native app, which sends the key as a header.
function withKey(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'X-Session-Key': key } }
}

function call(method: string, pathname: string, body?: unknown) {
  return send(server.base, method, pathname, body, { 'X-Session-Key': key })
}

function multipart(meta: unknown, file: Buffer, type: string) {
  const form = new FormData()
  form.set('meta', JSON.stringify(meta))
  form.set('file', new Blob([new Uint8Array(file)], { type }), 'file')
  return form
}

describe('sessions and media', () => {
  it('answers health and the server clock', async () => {
    assert.deepEqual((await json(fetch(`${server.base}/api/health`))).body, { ok: true })
    const { body } = await json<{ now: number }>(fetch(`${server.base}/api/time`))
    assert.ok(Math.abs(body.now - Date.now()) < 5000)
  })

  it('stores a video with its phone, take, and start time, and serves byte ranges', async () => {
    const session = await newSession()
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251))
    const assetId = uuid()
    const deviceId = uuid()
    const meta = { id: assetId, kind: 'video', mimeType: 'video/webm', createdAt: Date.now(), cameraLabel: 'Cam', width: 640, height: 360, snapshot: null, deviceId, takeId: uuid(), startedAt: Date.now() }
    const uploaded = await json<SessionDetail>(fetch(`${server.base}/api/sessions/${session.id}/assets`, withKey({ method: 'POST', body: multipart(meta, bytes, 'video/webm') })))
    assert.equal(uploaded.status, 200)
    assert.equal(uploaded.body.assets[0]!.deviceId, deviceId)
    const ranged = await fetch(`${server.base}/api/assets/${assetId}/file`, withKey({ headers: { Range: 'bytes=100-199' } }))
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-range'), 'bytes 100-199/4096')
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(100, 200))
    assert.equal((await fetch(`${server.base}/api/assets/${assetId}/file`, withKey({ headers: { Range: 'bytes=9000-' } }))).status, 416)

    const court = { preset: 'tennis-doubles', assetId, deviceId, sourceWidth: 640, sourceHeight: 360, imagePoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }] }
    const withCourt = await json<SessionDetail>(call('PUT', `/api/sessions/${session.id}/court`, court))
    assert.equal(withCourt.body.courts[0]!.deviceId, deviceId)
    const half = { ...court, landmarks: ['singles-near-left', 'singles-near-right', 'service-near-right', 'service-near-left'], callArea: 'singles' }
    const withHalf = await json<SessionDetail>(call('PUT', `/api/sessions/${session.id}/court`, half))
    assert.deepEqual(withHalf.body.courts[0]!.landmarks, half.landmarks)
    assert.equal(withHalf.body.courts[0]!.callArea, 'singles')
    const inLine = { ...court, landmarks: ['doubles-near-left', 'center-mark-near', 'doubles-near-right', 'tee-far'] }
    assert.equal((await call('PUT', `/api/sessions/${session.id}/court`, inLine)).status, 400)
    assert.equal((await call('PUT', `/api/sessions/${session.id}/court`, { ...court, callArea: 'pitch' })).status, 400)
    await call('PUT', `/api/sessions/${session.id}/court`, court)
    const track = { assetId, modelId: 'yolov8n-coco-onnx', sourceWidth: 640, sourceHeight: 360, sampleFps: 10, duration: 1, createdAt: 1, points: [{ t: 0, x: 1, y: 2, radius: 3, score: 0.5, bounce: true }], live: true }
    const withTrack = await json<SessionDetail>(call('PUT', `/api/assets/${assetId}/ball-track`, track))
    assert.equal(withTrack.body.ballTracks[0]!.live, true)
    assert.equal((await call('PUT', `/api/assets/${assetId}/ball-track`, { ...track, sampleFps: 0 })).status, 400)
    const long = Array.from({ length: BALL_TRACK_LIMIT }, (_, index) => ({ t: index / 30, x: 320.5, y: 180.25, radius: 12.5, score: 0.875 }))
    const longTrack = { ...track, sampleFps: 30, duration: BALL_TRACK_LIMIT / 30, live: false, points: long }
    const saved = await json<SessionDetail>(call('PUT', `/api/assets/${assetId}/ball-track`, longTrack))
    assert.equal(saved.status, 200, '11 minutes at 30 frames per second fits')
    assert.equal(saved.body.ballTracks[0]!.points.length, BALL_TRACK_LIMIT)
    assert.equal((await call('PUT', `/api/assets/${assetId}/ball-track`, { ...longTrack, points: [...long, long[0]] })).status, 400)

    assert.equal((await call('DELETE', `/api/assets/${assetId}`)).status, 200)
    const after = await json<SessionDetail>(fetch(`${server.base}/api/sessions/${session.id}`, withKey()))
    assert.equal(after.body.assets.length, 0)
    assert.equal(after.body.ballTracks.length, 0, 'the track goes with its video')
    assert.equal((await fetch(`${server.base}/api/sessions/${uuid()}`, withKey())).status, 404)
  })

  it('schedules synced takes a moment ahead', async () => {
    const session = await newSession()
    const take = await json<{ id: string; startAt: number }>(call('POST', `/api/sessions/${session.id}/takes`, { seconds: 10 }))
    assert.ok(take.body.startAt - Date.now() > 1500)
    assert.equal((await call('POST', `/api/sessions/${session.id}/takes`, { seconds: 7 })).status, 400)
    const latest = await json<{ take: { id: string } }>(fetch(`${server.base}/api/sessions/${session.id}/takes/latest`, withKey()))
    assert.equal(latest.body.take.id, take.body.id)
  })
})

describe('workouts', () => {
  it('keeps the newer edit, keeps deletions, and rejects bad sets', async () => {
    const session = await newSession()
    const id = uuid()
    const version = (name: string, updatedAt: number, reps: number = 5): Workout => ({
      id,
      name,
      startedAt: 1000,
      updatedAt,
      entries: [{ id: 'e1', exerciseId: 'back-squat', sets: [{ id: 's1', reps, weightKg: 100, done: true }] }],
    })
    const path = `/api/sessions/${session.id}/workouts/${id}`
    assert.equal((await json<{ saved: Workout }>(call('PUT', path, version('Legs', 2000)))).body.saved.name, 'Legs')
    assert.equal((await json<{ saved: Workout }>(call('PUT', path, version('Old', 1500)))).body.saved.name, 'Legs')
    assert.equal((await call('PUT', path, version('Bad', 3000, 2.5))).status, 400)
    await call('DELETE', path)
    assert.equal((await json<{ saved: Workout | null }>(call('PUT', path, version('Again', 9e12)))).body.saved, null)
    const exerciseId = uuid()
    await call('PUT', `/api/sessions/${session.id}/exercises/${exerciseId}`, { id: exerciseId, name: 'Serve', kind: 'timed', muscles: [], equipment: '', cue: '' })
    const book = await json<{ workouts: Workout[]; exercises: unknown[]; deleted: string[] }>(fetch(`${server.base}/api/sessions/${session.id}/workouts`, withKey()))
    assert.deepEqual([book.body.workouts.length, book.body.exercises.length, book.body.deleted], [0, 1, [id]])
  })
})

describe('custom models', () => {
  it('stores an ONNX file with its classes and refuses private links', async () => {
    const session = await newSession()
    const modelId = uuid()
    const fake = Buffer.concat([Buffer.from([0x08, 0x08]), Buffer.alloc(64)])
    const details = { id: modelId, name: 'Balls', inputSize: 640, labels: ['ball', 'player'], ballClasses: [0] }
    const saved = await json<SessionDetail>(fetch(`${server.base}/api/sessions/${session.id}/models`, withKey({ method: 'POST', body: multipart(details, fake, 'application/octet-stream') })))
    assert.equal(saved.body.models[0]!.name, 'Balls')
    const notOnnx = await fetch(`${server.base}/api/sessions/${session.id}/models`, withKey({ method: 'POST', body: multipart({ ...details, id: uuid() }, Buffer.from('text'), 'text/plain') }))
    assert.equal(notOnnx.status, 400)
    assert.deepEqual(Buffer.from(await (await fetch(`${server.base}/api/custom-models/${modelId}/file`, withKey())).arrayBuffer()), fake)
    const edited = await json<SessionDetail>(call('PUT', `/api/custom-models/${modelId}`, { ...details, ballClasses: [0, 1] }))
    assert.deepEqual(edited.body.models[0]!.ballClasses, [0, 1])
    for (const link of ['http://example.com/m.onnx', 'https://localhost/m.onnx', 'https://127.0.0.1/m.onnx', 'https://10.0.0.5/m.onnx', 'nope']) {
      assert.equal((await fetch(`${server.base}/api/fetch-model?session=${session.id}&url=${encodeURIComponent(link)}`, withKey())).status, 400, link)
    }
    await call('DELETE', `/api/custom-models/${modelId}`)
    assert.equal((await fetch(`${server.base}/api/custom-models/${modelId}/file`, withKey())).status, 404)
  })
})

describe('training sets', () => {
  it('labels frames, exports a YOLO zip, and uploads to Roboflow', async () => {
    const session = await newSession()
    const base = `/api/sessions/${session.id}/training`
    assert.deepEqual((await json<TrainingSet>(fetch(server.base + base, withKey()))).body.classes, ['ball', 'player'])
    await call('PUT', `${base}/classes`, { classes: ['ball', 'player', 'racket'] })
    const imageId = uuid()
    const meta = { id: imageId, width: 640, height: 360, split: 'train', boxes: [{ classId: 0, x: 300, y: 160, width: 20, height: 20 }] }
    assert.equal((await fetch(`${server.base}${base}/images`, withKey({ method: 'POST', body: multipart(meta, JPEG, 'image/jpeg') }))).status, 200)
    const bad = { ...meta, id: uuid(), boxes: [{ classId: 9, x: 1, y: 1, width: 5, height: 5 }] }
    assert.equal((await fetch(`${server.base}${base}/images`, withKey({ method: 'POST', body: multipart(bad, JPEG, 'image/jpeg') }))).status, 400)
    assert.equal((await call('PUT', `${base}/classes`, { classes: ['ball'] })).status, 200, 'class 0 is still there')
    await call('PUT', `${base}/classes`, { classes: ['ball', 'player', 'racket'] })

    const archive = Buffer.from(await (await fetch(`${server.base}${base}/export`, withKey())).arrayBuffer())
    const listing = archive.toString('latin1')
    for (const name of ['data.yaml', 'train.py', 'images/train/00001-', 'labels/train/00001-']) assert.ok(listing.includes(name), name)
    assert.ok(listing.includes('0 0.484375 0.472222 0.031250 0.055556'))

    const failed = await json<{ uploaded: number; failed: { error: string }[] }>(call('POST', `${base}/roboflow`, { apiKey: 'wrong_key_000', project: 'balls' }))
    assert.equal(failed.body.failed[0]!.error, 'This API key does not exist.')
    const uploaded = await json<{ uploaded: number }>(call('POST', `${base}/roboflow`, { apiKey: 'test_key_123456', project: 'balls' }))
    assert.equal(uploaded.body.uploaded, 1)
    const annotation = roboflowLog.find((entry) => entry.path.includes('/annotate/') && entry.query.get('api_key') === 'test_key_123456')!
    assert.match(annotation.body, /<name>ball<\/name>/)
    assert.equal(roboflowLog.find((entry) => entry.path.endsWith('/upload') && entry.query.get('api_key') === 'test_key_123456')!.query.get('split'), 'train')
  })
})

describe('private sessions', () => {
  it('needs the key for every kind of data', async () => {
    const session = await newSession()
    const assetId = uuid()
    const meta = { id: assetId, kind: 'photo', mimeType: 'image/jpeg', createdAt: Date.now(), cameraLabel: 'Cam', snapshot: null }
    await fetch(`${server.base}/api/sessions/${session.id}/assets`, withKey({ method: 'POST', body: multipart(meta, JPEG, 'image/jpeg') }))
    const blocked = [
      ['GET', `/api/sessions/${session.id}`],
      ['GET', `/api/assets/${assetId}/file`],
      ['DELETE', `/api/assets/${assetId}`],
      ['GET', `/api/sessions/${session.id}/workouts`],
      ['GET', `/api/sessions/${session.id}/training`],
      ['GET', `/api/sessions/${session.id}/takes/latest`],
      ['GET', `/api/fetch-model?session=${session.id}&url=${encodeURIComponent('https://example.com/a.onnx')}`],
    ] as const
    for (const [method, pathname] of blocked) {
      assert.equal((await send(server.base, method, pathname)).status, 403, `${method} ${pathname} without a key`)
      assert.equal((await send(server.base, method, pathname, undefined, { 'X-Session-Key': 'wrong' })).status, 403, `${method} ${pathname} with a wrong key`)
    }
    assert.equal((await send(server.base, 'POST', '/api/sessions', { id: session.id, device: { id: uuid(), label: 'x' } })).status, 403)
    assert.equal((await fetch(`${server.base}/api/fetch-model?url=x`)).status, 400, 'the model proxy works for a session only')
    assert.equal((await fetch(`${server.base}/api/assets/${assetId}/file`, withKey())).status, 200, 'the photo is still there')
  })

  it('turns a shared link into a cookie that also loads media', async () => {
    const session = await newSession()
    const assetId = uuid()
    const meta = { id: assetId, kind: 'photo', mimeType: 'image/jpeg', createdAt: Date.now(), cameraLabel: 'Cam', snapshot: null }
    await fetch(`${server.base}/api/sessions/${session.id}/assets`, withKey({ method: 'POST', body: multipart(meta, JPEG, 'image/jpeg') }))
    assert.equal((await send(server.base, 'POST', `/api/sessions/${session.id}/unlock`, { key: 'not-the-key' })).status, 403)
    const unlocked = await send(server.base, 'POST', `/api/sessions/${session.id}/unlock`, { key })
    assert.equal(unlocked.status, 200)
    const cookie = unlocked.headers.get('set-cookie')!
    assert.match(cookie, /HttpOnly; SameSite=Lax/)
    const jar = { Cookie: cookie.split(';')[0]! }
    assert.equal((await fetch(`${server.base}/api/assets/${assetId}/file`, { headers: jar })).status, 200)
    assert.equal((await fetch(`${server.base}/api/sessions/${session.id}`, { headers: jar })).status, 200)
  })

  it('keeps an old open session open until it is made private', async () => {
    const id = uuid()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(`${server.dataDir}/pbmp.sqlite`)
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('INSERT INTO sessions (id, created_at, updated_at, device_json) VALUES (?, ?, ?, ?)').run(id, 1, 1, JSON.stringify({ id: uuid(), label: 'old', userAgent: '' }))
    db.close()
    const open = await json<SessionDetail>(fetch(`${server.base}/api/sessions/${id}`))
    assert.equal(open.status, 200)
    assert.equal(open.body.locked, false)
    const locked = await json<SessionDetail>(send(server.base, 'POST', `/api/sessions/${id}/lock`))
    assert.ok(locked.body.locked && locked.body.key)
    assert.equal((await fetch(`${server.base}/api/sessions/${id}`)).status, 403)
    assert.equal((await fetch(`${server.base}/api/sessions/${id}`, { headers: { 'X-Session-Key': locked.body.key! } })).status, 200)
    assert.equal((await send(server.base, 'POST', `/api/sessions/${id}/lock`, undefined, { 'X-Session-Key': locked.body.key! })).status, 409)
  })
})
