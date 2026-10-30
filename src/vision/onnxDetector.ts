import type { Detection } from '../types'
import { COCO_MODEL, specOf, type DetectorModel } from './models'
import type { DecodeOptions } from './yolo'

export type OnnxBackend = { name: 'webgpu' | 'wasm'; threads: number }

type Ready = { type: 'ready'; key: string; backend: OnnxBackend }
type Failed = { type: 'error'; key: string; message: string }
type Result = {
  type: 'result'
  id: number
  detections: Detection[]
  inferenceMs: number
  error?: string
}

let worker: Worker | null = null
let nextId = 0
let busy = false
let backend: OnnxBackend | null = null
const loading = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }>()
const waiters = new Map<number, { resolve: (value: { detections: Detection[]; inferenceMs: number }) => void; reject: (error: Error) => void }>()

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
    else waiter.resolve({ detections: message.detections, inferenceMs: message.inferenceMs })
  }
  worker.onerror = () => {
    failAll(new Error('The ONNX worker stopped.'))
  }
  return worker
}

export function prepareOnnx(model: DetectorModel = COCO_MODEL) {
  const existing = loading.get(model.id)
  if (existing) return existing.promise
  let resolve: () => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  promise.catch(() => undefined)
  loading.set(model.id, { promise, resolve, reject })
  ensureWorker().postMessage({ type: 'load', spec: specOf(model) })
  return promise
}

export function onnxBackend() {
  return backend
}

export function resetOnnx() {
  worker?.terminate()
  worker = null
  busy = false
  failAll(new Error('ONNX was reset.'))
}

export async function detectSource(
  source: CanvasImageSource,
  width: number,
  height: number,
  options: DecodeOptions & { model?: DetectorModel } = {},
) {
  if (busy || width < 2 || height < 2) return null
  busy = true
  const { model = COCO_MODEL, ...decode } = options
  try {
    await prepareOnnx(model)
    const bitmap = await createImageBitmap(source)
    const id = ++nextId
    return await new Promise<{ detections: Detection[]; inferenceMs: number }>((resolve, reject) => {
      waiters.set(id, { resolve, reject })
      ensureWorker().postMessage({ type: 'detect', id, spec: specOf(model), bitmap, width, height, options: decode }, [
        bitmap,
      ])
    })
  } finally {
    busy = false
  }
}
