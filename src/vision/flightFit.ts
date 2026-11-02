import type { BallTrack, CourtCalibration } from '../../shared/contracts.ts'
import { mergeFits, splitForFitting, type FlightFit } from './flight'

type Reply = { id: number; fit?: FlightFit | null; error?: string }
type Waiter = { resolve: (fit: FlightFit | null) => void; reject: (error: Error) => void }

// An hour of ball takes a single worker most of a minute, so long tracks are fitted in pieces on
// several workers at once.
const SPLIT_FROM_POINTS = 3000
const MAX_WORKERS = 4

const pool: { worker: Worker; waiters: Map<number, Waiter> }[] = []
let nextId = 0
let turn = 0

function poolSize() {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1))
}

function workerAt(index: number) {
  const existing = pool[index]
  if (existing) return existing
  const worker = new Worker(new URL('./flight.worker.ts', import.meta.url), { type: 'module' })
  const slot = { worker, waiters: new Map<number, Waiter>() }
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const waiter = slot.waiters.get(event.data.id)
    if (!waiter) return
    slot.waiters.delete(event.data.id)
    if (event.data.error) waiter.reject(new Error(event.data.error))
    else waiter.resolve(event.data.fit ?? null)
  }
  worker.onerror = () => {
    for (const waiter of slot.waiters.values()) waiter.reject(new Error('The 3D flight worker stopped.'))
    slot.waiters.clear()
    worker.terminate()
    if (pool[index] === slot) delete pool[index]
  }
  pool[index] = slot
  return slot
}

function fitOn(index: number, track: BallTrack, court: CourtCalibration) {
  const id = ++nextId
  const slot = workerAt(index)
  return new Promise<FlightFit | null>((resolve, reject) => {
    slot.waiters.set(id, { resolve, reject })
    slot.worker.postMessage({ id, track, court })
  })
}

export async function fitFlightsInWorker(track: BallTrack, court: CourtCalibration) {
  const size = poolSize()
  if (track.points.length < SPLIT_FROM_POINTS || size === 1) {
    turn = (turn + 1) % size
    return fitOn(turn, track, court)
  }
  const pieces = splitForFitting(track.points, size)
  const fits = await Promise.all(pieces.map((points, index) => fitOn(index, { ...track, points }, court)))
  return mergeFits(fits.filter((fit): fit is FlightFit => !!fit))
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
