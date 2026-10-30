import type { BallTrack, CourtCalibration } from '../../shared/contracts.ts'
import type { FlightFit } from './flight'

type Reply = { id: number; fit?: FlightFit | null; error?: string }

let worker: Worker | null = null
let nextId = 0
const waiters = new Map<number, { resolve: (fit: FlightFit | null) => void; reject: (error: Error) => void }>()

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./flight.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const waiter = waiters.get(event.data.id)
    if (!waiter) return
    waiters.delete(event.data.id)
    if (event.data.error) waiter.reject(new Error(event.data.error))
    else waiter.resolve(event.data.fit ?? null)
  }
  worker.onerror = () => {
    for (const waiter of waiters.values()) waiter.reject(new Error('The 3D flight worker stopped.'))
    waiters.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

export function fitFlightsInWorker(track: BallTrack, court: CourtCalibration) {
  const id = ++nextId
  return new Promise<FlightFit | null>((resolve, reject) => {
    waiters.set(id, { resolve, reject })
    ensureWorker().postMessage({ id, track, court })
  })
}

const shared = new WeakMap<BallTrack, WeakMap<CourtCalibration, Promise<FlightFit | null>>>()

// The video overlay and the 3D panel ask for the same fit; it runs once per track and court.
export function sharedFlightFit(track: BallTrack, court: CourtCalibration) {
  let byCourt = shared.get(track)
  if (!byCourt) {
    byCourt = new WeakMap()
    shared.set(track, byCourt)
  }
  let pending = byCourt.get(court)
  if (!pending) {
    pending = fitFlightsInWorker(track, court)
    pending.catch(() => byCourt.delete(court))
    byCourt.set(court, pending)
  }
  return pending
}
