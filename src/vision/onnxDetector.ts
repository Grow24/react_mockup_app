import type { PersonPose } from '../../shared/contracts.ts'
import type { Detection } from '../types'
import { COCO_MODEL, PEOPLE_SPEC, specOf, type DetectorModel, type ModelSpec } from './models'
import type { DecodeOptions } from './yolo'

export type OnnxBackend = { name: 'webgpu' | 'wasm'; threads: number }

type Ready = { type: 'ready'; key: string; backend: OnnxBackend }
type Failed = { type: 'error'; key: string; message: string }
type Result = {
  type: 'result'
  id: number
  detections: Detection[]
  people?: PersonPose[]
  inferenceMs: number
  error?: string
}

type Reading = { detections: Detection[]; people: PersonPose[]; inferenceMs: number }

let worker: Worker | null = null
let nextId = 0
const busy = new Set<string>()
let backend: OnnxBackend | null = null
const loading = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }>()
const waiters = new Map<number, { resolve: (value: Reading) => void; reject: (error: Error) => void }>()

function failAll(error: Error) {
  for (const entry of loading.values()) entry.reject(error)
  loading.clear()
  for (const waiter of waiters.values()) waiter.reject(error)
  waiters.clear()
}

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./onnx.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<Ready | Failed | Result>) => {
    const message = event.data
    if (message.type === 'ready') {
      backend = message.backend
      loading.get(message.key)?.resolve()
      return
    }
    if (message.type === 'error') {
      loading.get(message.key)?.reject(new Error(message.message))
      loading.delete(message.key)
      return
    }
    const waiter = waiters.get(message.id)
    if (!waiter) return
    waiters.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error))
    else waiter.resolve({ detections: message.detections, people: message.people ?? [], inferenceMs: message.inferenceMs })
  }
  worker.onerror = () => {
    failAll(new Error('The ONNX worker stopped.'))
  }
  return worker
}

export function prepareOnnx(model: DetectorModel = COCO_MODEL) {
  return prepareSpec(specOf(model))
}

export function preparePeople() {
  return prepareSpec(PEOPLE_SPEC)
}

function prepareSpec(spec: ModelSpec) {
  const existing = loading.get(spec.key)
  if (existing) return existing.promise
  let resolve: () => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  promise.catch(() => undefined)
  loading.set(spec.key, { promise, resolve, reject })
  ensureWorker().postMessage({ type: 'load', spec })
  return promise
}

export function onnxBackend() {
  return backend
}

export function resetOnnx() {
  worker?.terminate()
  worker = null
  busy.clear()
  failAll(new Error('ONNX was reset.'))
}

export async function detectSource(
  source: CanvasImageSource,
  width: number,
  height: number,
  options: DecodeOptions & { model?: DetectorModel } = {},
) {
  const { model = COCO_MODEL, ...decode } = options
  return run(specOf(model), source, width, height, decode)
}

// Every person in the frame with 17 joints each, from YOLOv8n-pose.
export async function detectPeople(source: CanvasImageSource, width: number, height: number, minScore = 0.3) {
  const reading = await run(PEOPLE_SPEC, source, width, height, { minScore })
  return reading ? { people: reading.people, inferenceMs: reading.inferenceMs } : null
}

// One frame per model at a time; a caller that finds its model busy gets null and tries again.
async function run(spec: ModelSpec, source: CanvasImageSource, width: number, height: number, options: DecodeOptions) {
  if (busy.has(spec.key) || width < 2 || height < 2) return null
  busy.add(spec.key)
  try {
    await prepareSpec(spec)
    const bitmap = await createImageBitmap(source)
    const id = ++nextId
    return await new Promise<Reading>((resolve, reject) => {
      waiters.set(id, { resolve, reject })
      ensureWorker().postMessage({ type: 'detect', id, spec, bitmap, width, height, options }, [bitmap])
    })
  } finally {
    busy.delete(spec.key)
  }
}
