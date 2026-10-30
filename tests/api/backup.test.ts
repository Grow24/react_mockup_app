import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import type { SessionDetail, Workout } from '../../shared/contracts.ts'
import { tarGzip, untarGzip } from '../../server/tar.ts'
import { json, send, startServer, uuid, type TestServer } from '../helpers/server.ts'

const TOKEN = 'test-admin-token-0123456789'
const admin = { Authorization: `Bearer ${TOKEN}` }
const servers: TestServer[] = []
after(async () => {
  for (const server of servers) await server.stop()
})

describe('tar archives', () => {
  it('round-trips files of any size', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'pbmp-tar-'))
    try {
      const big = Buffer.from(Array.from({ length: 1_300_017 }, (_, index) => (index * 7) % 256))
      writeFileSync(path.join(folder, 'a'), big)
      writeFileSync(path.join(folder, 'b'), '')
      const archive = tarGzip([
        { name: 'pbmp.sqlite', path: path.join(folder, 'a'), size: big.length, mtime: 0 },
        { name: 'media/empty', path: path.join(folder, 'b'), size: 0, mtime: 0 },
      ])
      const out = path.join(folder, 'out')
      assert.deepEqual(await untarGzip(archive, out, 10_000_000), ['pbmp.sqlite', 'media/empty'])
      assert.deepEqual(readFileSync(path.join(out, 'pbmp.sqlite')), big)
      assert.equal(readFileSync(path.join(out, 'media/empty')).length, 0)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('refuses names that climb out of the folder', async () => {
    const block = Buffer.alloc(512)
    block.write('../escape', 0)
    block.write('0000644\0', 100)
    block.write('00000000000\0', 124)
    block.write('0', 156)
    const folder = mkdtempSync(path.join(tmpdir(), 'pbmp-tar-'))
    try {
      await assert.rejects(untarGzip(Readable.from([gzipSync(Buffer.concat([block, Buffer.alloc(1024)]))]), folder, 1e6), /unsafe file name/)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('moving to a new host', () => {
  it('backs up one server and restores it on an empty one', async () => {
    const old = await startServer({ ADMIN_TOKEN: TOKEN })
    servers.push(old)
    const created = await json<SessionDetail>(send(old.base, 'POST', '/api/sessions', { id: uuid(), device: { id: uuid(), label: 'old host' } }))
    const session = created.body
    const key = { 'X-Session-Key': session.key! }
    const video = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 253))
    const assetId = uuid()
    const form = new FormData()
    form.set('meta', JSON.stringify({ id: assetId, kind: 'video', mimeType: 'video/webm', createdAt: 1, cameraLabel: 'Cam', snapshot: null }))
    form.set('file', new Blob([new Uint8Array(video)], { type: 'video/webm' }), 'v.webm')
    assert.equal((await fetch(`${old.base}/api/sessions/${session.id}/assets`, { method: 'POST', body: form, headers: key })).status, 200)
    const workout: Workout = { id: uuid(), name: 'Moved', startedAt: 1, updatedAt: 2, entries: [] }
    await send(old.base, 'PUT', `/api/sessions/${session.id}/workouts/${workout.id}`, workout, key)

    assert.equal((await fetch(`${old.base}/api/admin/stats`)).status, 404, 'no token, no admin')
    assert.equal((await fetch(`${old.base}/api/admin/stats`, { headers: { Authorization: 'Bearer wrong-token-0000000000' } })).status, 404)
    const before = await json<Record<string, number>>(fetch(`${old.base}/api/admin/stats`, { headers: admin }))
    assert.deepEqual([before.body.sessions, before.body.assets, before.body.workouts, before.body.mediaFiles], [1, 1, 1, 1])
    const backup = Buffer.from(await (await fetch(`${old.base}/api/admin/backup`, { headers: admin })).arrayBuffer())

    const fresh = await startServer({ ADMIN_TOKEN: TOKEN })
    servers.push(fresh)
    const restored = await json<Record<string, number>>(fetch(`${fresh.base}/api/admin/restore`, { method: 'POST', body: backup, headers: admin }))
    assert.equal(restored.status, 200)
    assert.deepEqual(restored.body, before.body)
    const file = await fetch(`${fresh.base}/api/assets/${assetId}/file`, { headers: key })
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), video, 'the video arrives byte for byte')
    assert.equal((await fetch(`${fresh.base}/api/sessions/${session.id}`)).status, 403, 'the session is still private')
    const book = await json<{ workouts: Workout[] }>(fetch(`${fresh.base}/api/sessions/${session.id}/workouts`, { headers: key }))
    assert.equal(book.body.workouts[0]!.name, 'Moved')

    const again = await fetch(`${fresh.base}/api/admin/restore`, { method: 'POST', body: backup, headers: admin })
    assert.equal(again.status, 409, 'a server with data is never overwritten')
  })
})
