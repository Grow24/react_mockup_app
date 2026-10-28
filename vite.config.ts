import { type ChildProcess, spawn } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function pbmpBackend(): Plugin {
  let child: ChildProcess | undefined
  return {
    name: 'pbmp-backend',
    configureServer(server) {
      if (child) return
      child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
        stdio: 'inherit',
        env: { ...process.env, PBMP_PORT: '8787' },
      })
      const stop = () => {
        if (child && !child.killed) child.kill()
      }
      server.httpServer?.on('close', stop)
      process.on('exit', stop)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pbmpBackend()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
