import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// The app runs on its own ports and data folder, so a dev server on 5173/8787 keeps working.
export const E2E_PORT = 5199
const API_PORT = '8799'
// One fresh data folder per run. Workers load this file again, so they reuse the folder from the env.
process.env.PBMP_E2E_DATA ??= mkdtempSync(path.join(tmpdir(), 'pbmp-e2e-'))

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 1600 },
    permissions: ['camera'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--use-file-for-fake-video-capture=e2e/.cache/court-lines.y4m',
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
      ],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 1600 } } },
    // Safari's engine: only the isolation check, since WebKit has no fake camera. It needs system
    // libraries (npx playwright install --with-deps webkit), so it runs in CI or when asked for.
    ...(process.env.CI || process.env.PBMP_E2E_WEBKIT
      ? [
          {
            name: 'webkit',
            testMatch: 'isolation.spec.ts',
            use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 1600 }, permissions: [], launchOptions: { args: [] } },
          },
        ]
      : []),
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PBMP_API_PORT: API_PORT, PBMP_DATA_DIR: process.env.PBMP_E2E_DATA },
  },
})
