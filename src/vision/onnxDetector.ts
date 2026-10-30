import type { Detection } from '../types'
import type { DecodeOptions } from './yolo'

export type OnnxBackend = { name: 'webgpu' | 'wasm'; threads: number }

type Ready = { type: 'ready'; backend: OnnxBackend }
type Failed = { type: 'error'; message: string }
type Result = {
  type: 'result'
  id: number
  detections: Detection[]
  inferenceMs: number
  error?: string
}

let worker: Worker | null = null
let loading: Promise<void> | null = null
let readyResolve: (() => void) | null = null
let readyReject: ((error: Error) => void) | null = null
let nextId = 0
let busy = false
let backend: OnnxBackend | null = null
const waiters = new Map<number, { resolve: (value: { detections: Detection[]; inferenceMs: number }) => void; reject: (error: Error) => void }>()

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./onnx.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<Ready | Failed | Result>) => {
    const message = event.data
    if (message.type === 'ready') {
      backend = message.backend
      readyResolve?.()
      return
    }
    if (message.type === 'error') {
      readyReject?.(new Error(message.message))
      loading = null
      return
    }
    const waiter = waiters.get(message.id)
    if (!waiter) return
    waiters.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error))
    else waiter.resolve({ detections: message.detections, inferenceMs: message.inferenceMs })
  }
  worker.onerror = () => {
    readyReject?.(new Error('The ONNX worker stopped.'))
    loading = null
  }
  return worker
}

export function prepareOnnx() {
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
      ensureWorker().postMessage({ type: 'load' })
    })
  }
  return loading
}

export function onnxBackend() {
  return backend
}

export function resetOnnx() {
  worker?.terminate()
  worker = null
  loading = null
  readyResolve = null
  readyReject = null
  busy = false
  for (const waiter of waiters.values()) waiter.reject(new Error('ONNX was reset.'))
  waiters.clear()
}

export async function detectSource(
  source: CanvasImageSource,
  width: number,
  height: number,
  options?: DecodeOptions,
) {
  if (busy || width < 2 || height < 2) return null
  busy = true
  try {
    await prepareOnnx()
    const bitmap = await createImageBitmap(source)
    const id = ++nextId
    return await new Promise<{ detections: Detection[]; inferenceMs: number }>((resolve, reject) => {
      waiters.set(id, { resolve, reject })
      ensureWorker().postMessage({ type: 'detect', id, bitmap, width, height, options }, [bitmap])
    })
  } finally {
    busy = false
  }
}
