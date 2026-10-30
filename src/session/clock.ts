// Phones disagree about the time by seconds, so every phone measures its offset to the server
// and stamps recordings in server time.
export type ClockSync = { offsetMs: number; roundTripMs: number; at: number }

const SAMPLES = 6
const FRESH_MS = 60_000

let latest: ClockSync | null = null
let pending: Promise<ClockSync> | null = null

async function sample() {
  const sent = Date.now()
  const response = await fetch('/api/time', { cache: 'no-store' })
  const received = Date.now()
  if (!response.ok) throw new Error('The server clock did not answer.')
  const { now } = (await response.json()) as { now: number }
  return { offsetMs: now - (sent + received) / 2, roundTripMs: received - sent, at: received }
}

export function syncClock(force = false) {
  if (!force && latest && Date.now() - latest.at < FRESH_MS) return Promise.resolve(latest)
  if (!pending) {
    pending = (async () => {
      let best: ClockSync | null = null
      for (let index = 0; index < SAMPLES; index += 1) {
        const next = await sample()
        if (!best || next.roundTripMs < best.roundTripMs) best = next
      }
      latest = best!
      return latest
    })().finally(() => {
      pending = null
    })
  }
  return pending
}

export function clockSync() {
  return latest
}

export function serverNow() {
  return Date.now() + (latest?.offsetMs ?? 0)
}
