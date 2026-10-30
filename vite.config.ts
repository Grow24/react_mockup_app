import { type ChildProcess, spawn } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Kept on globalThis so a Vite config reload waits for the old API to free port 8787.
type Api = { child?: ChildProcess; stopping?: Promise<void> }
const api: Api = ((globalThis as { __pbmpApi?: Api }).__pbmpApi ??= {})

function stopApi() {
  const running = api.child
  api.child = undefined
  if (running && running.exitCode === null && running.signalCode === null) {
    api.stopping = new Promise<void>((resolve) => {
      running.once('exit', () => resolve())
      running.kill()
    })
  }
  return api.stopping ?? Promise.resolve()
}

// PBMP_API_PORT lets the browser tests run their own API next to a dev server already on 8787.
const apiPort = process.env.PBMP_API_PORT || '8787'

async function startApi() {
  await stopApi()
  api.child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: apiPort, PBMP_PORT: apiPort },
  })
}

function pbmpBackend(): Plugin {
  return {
    name: 'pbmp-backend',
    configureServer(server) {
      let queue = Promise.resolve()
      const restart = () => {
        queue = queue.then(startApi).catch((error: unknown) => console.error(error))
      }
      restart()
      server.watcher.on('change', (file) => {
        if (/[\\/](server|shared)[\\/][^\\/]+\.ts$/.test(file)) restart()
      })
      server.httpServer?.on('close', () => void stopApi())
      process.once('exit', () => api.child?.kill())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pbmpBackend()],
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
})
