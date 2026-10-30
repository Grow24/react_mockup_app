import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

// A small streaming tar (ustar) writer and reader for data backups: regular files only, so a
// backup of gigabytes of video never has to sit in memory.

const BLOCK = 512

function octal(value: number, width: number) {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function header(name: string, size: number, mtime: number) {
  const block = Buffer.alloc(BLOCK)
  const encoded = Buffer.from(name, 'utf8')
  if (encoded.length > 100) throw new Error(`Backup file name is too long: ${name}`)
  encoded.copy(block, 0)
  block.write(octal(0o644, 8), 100, 'ascii')
  block.write(octal(0, 8), 108, 'ascii')
  block.write(octal(0, 8), 116, 'ascii')
  block.write(octal(size, 12), 124, 'ascii')
  block.write(octal(Math.floor(mtime / 1000), 12), 136, 'ascii')
  block.fill(' ', 148, 156)
  block.write('0', 156, 'ascii')
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(octal(sum, 7) + ' ', 148, 'ascii')
  return block
}

export type TarFile = { name: string; path: string; size: number; mtime: number }

export function tarGzip(files: TarFile[]) {
  async function* blocks() {
    for (const file of files) {
      yield header(file.name, file.size, file.mtime)
      let sent = 0
      for await (const chunk of createReadStream(file.path)) {
        sent += (chunk as Buffer).length
        yield chunk as Buffer
      }
      if (sent !== file.size) throw new Error(`${file.name} changed while it was being backed up.`)
      const pad = (BLOCK - (file.size % BLOCK)) % BLOCK
      if (pad) yield Buffer.alloc(pad)
    }
    yield Buffer.alloc(BLOCK * 2)
  }
  return Readable.from(blocks()).pipe(createGzip())
}

// Only plain relative names are written, so an archive cannot reach outside `target`.
function safeName(name: string) {
  const clean = path.posix.normalize(name)
  if (!clean || clean.startsWith('/') || clean.startsWith('..') || clean.includes('/../') || clean.includes('\0')) return null
  return clean
}

export async function untarGzip(source: Readable, target: string, maxBytes: number) {
  let buffer: Buffer = Buffer.alloc(0)
  let current: { stream: ReturnType<typeof createWriteStream>; left: number; pad: number } | null = null
  let total = 0
  let ended = false
  const names: string[] = []

  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      void (async () => {
        total += chunk.length
        if (total > maxBytes) throw new Error('The backup is larger than allowed.')
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
        for (;;) {
          if (current) {
            if (current.left > 0) {
              if (buffer.length === 0) break
              const piece = buffer.subarray(0, Math.min(current.left, buffer.length))
              buffer = buffer.subarray(piece.length)
              current.left -= piece.length
              if (!current.stream.write(piece)) await new Promise<void>((resolve) => current!.stream.once('drain', () => resolve()))
              continue
            }
            if (buffer.length < current.pad) break
            buffer = buffer.subarray(current.pad)
            const finished = current.stream
            current = null
            await new Promise<void>((resolve, reject) => finished.end((error?: Error | null) => (error ? reject(error) : resolve())))
            continue
          }
          if (ended || buffer.length < BLOCK) break
          const block = buffer.subarray(0, BLOCK)
          buffer = buffer.subarray(BLOCK)
          if (block.every((byte) => byte === 0)) {
            ended = true
            break
          }
          const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
          const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8)
          const type = String.fromCharCode(block[156] ?? 48)
          if (type !== '0' && type !== '\0') throw new Error('The backup has something other than plain files.')
          const clean = safeName(name)
          if (!clean) throw new Error(`The backup has an unsafe file name: ${name}`)
          const destination = path.join(target, clean)
          mkdirSync(path.dirname(destination), { recursive: true })
          names.push(clean)
          current = { stream: createWriteStream(destination), left: size, pad: (BLOCK - (size % BLOCK)) % BLOCK }
        }
      })().then(() => done(), done)
    },
    final(done) {
      done(current ? new Error('The backup ends in the middle of a file.') : null)
    },
  })
  await pipeline(source, createGunzip(), sink)
  return names
}
