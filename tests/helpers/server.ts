import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type TestServer = { base: string; dataDir: string; stop: () => Promise<void> }

// Starts the API on a free port with its own empty data folder, so tests never touch real data.
export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'pbmp-test-'))
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, ...env, PORT: String(port), PBMP_PORT: String(port), PBMP_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errors = ''
  child.stderr?.on('data', (chunk: Buffer) => (errors += chunk.toString()))
  const base = `http://127.0.0.1:${port}`
  const started = Date.now()
  for (;;) {
    if (child.exitCode != null) throw new Error(`The test server exited: ${errors}`)
    try {
      if ((await fetch(`${base}/api/models`)).ok) break
    } catch {
      // Not listening yet.
    }
    if (Date.now() - started > 15000) throw new Error(`The test server did not start: ${errors}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return {
    base,
    dataDir,
    stop: async () => {
      if (child.exitCode == null) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill()
        await exited
      }
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export function uuid() {
  return crypto.randomUUID()
}

export async function json<T = unknown>(response: Response | Promise<Response>) {
  const reply = await response
  const body = (await reply.json()) as T
  return { status: reply.status, body }
}

export function send(base: string, method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
