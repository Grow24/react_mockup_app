import * as ort from 'onnxruntime-web/webgpu'
import type { ModelSpec } from './models'
import { decodeYolo, decodeYoloPose, letterbox, type DecodeOptions } from './yolo'

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/'
// Threads need SharedArrayBuffer, which the browser only allows on a cross-origin isolated page.
const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1
ort.env.wasm.numThreads = threads

type OnnxBackend = { name: 'webgpu' | 'wasm'; threads: number }

const KEEP_MODELS = 2
const sessions = new Map<string, Promise<ort.InferenceSession>>()
let choice: Promise<OnnxBackend['name']> | null = null
let backend: OnnxBackend = { name: 'wasm', threads }

type Adapter = { isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } }

// A software WebGPU adapter is far slower than WASM threads, so it is not worth trying.
async function gpuReady() {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<Adapter | null> } }).gpu
  if (!gpu) return false
  try {
    const adapter = await gpu.requestAdapter()
    return Boolean(adapter) && !adapter?.isFallbackAdapter && !adapter?.info?.isFallbackAdapter
  } catch {
    return false
  }
}

async function timeRun(candidate: ort.InferenceSession, size: number) {
  const input = new ort.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size])
  const feeds = { [candidate.inputNames[0]!]: input }
  await candidate.run(feeds)
  const started = performance.now()
  await candidate.run(feeds)
  return performance.now() - started
}

// Some GPUs are slower than four WASM threads, so the first model decides which backend wins here.
async function create(bytes: ArrayBuffer, spec: ModelSpec) {
  if (!choice) {
    let resolve: (name: OnnxBackend['name']) => void = () => undefined
    choice = new Promise((done) => (resolve = done))
    let wasm: ort.InferenceSession
    try {
      wasm = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
    } catch (error) {
      choice = null
      resolve('wasm')
      throw error
    }
    if (await gpuReady()) {
      try {
        const gpu = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] })
        if ((await timeRun(gpu, spec.inputSize)) < (await timeRun(wasm, spec.inputSize))) {
          await wasm.release()
          backend = { name: 'webgpu', threads }
          resolve('webgpu')
          return gpu
        }
        await gpu.release()
      } catch (error) {
        console.warn('WebGPU could not run this model, using WASM.', error)
      }
    }
    backend = { name: 'wasm', threads }
    resolve('wasm')
    return wasm
  }
  const name = await choice
  try {
    return await ort.InferenceSession.create(bytes, { executionProviders: [name] })
  } catch (error) {
    if (name === 'wasm') throw error
    return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
  }
}

function loadSession(spec: ModelSpec) {
  const cached = sessions.get(spec.key)
  if (cached) {
    sessions.delete(spec.key)
    sessions.set(spec.key, cached)
    return cached
  }
  const loading = (async () => {
    const response = await fetch(spec.url)
    if (!response.ok) throw new Error('The ONNX model could not be downloaded.')
    return create(await response.arrayBuffer(), spec)
  })()
  loading.catch(() => sessions.delete(spec.key))
  sessions.set(spec.key, loading)
  while (sessions.size > KEEP_MODELS) {
    const [oldest, session] = sessions.entries().next().value as [string, Promise<ort.InferenceSession>]
    sessions.delete(oldest)
    void session.then((item) => item.release()).catch(() => undefined)
  }
  return loading
}

function tensorFrom(bitmap: ImageBitmap, srcWidth: number, srcHeight: number, size: number) {
  const fitted = letterbox(srcWidth, srcHeight, size)
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The ONNX worker could not draw the frame.')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  ctx.drawImage(bitmap, fitted.padX, fitted.padY, fitted.resizedW, fitted.resizedH)
  bitmap.close()
  const image = ctx.getImageData(0, 0, size, size)
  const input = new Float32Array(3 * size * size)
  const plane = size * size
  for (let pixel = 0, index = 0; pixel < image.data.length; pixel += 4, index += 1) {
    input[index] = image.data[pixel]! / 255
    input[plane + index] = image.data[pixel + 1]! / 255
    input[plane * 2 + index] = image.data[pixel + 2]! / 255
  }
  return new ort.Tensor('float32', input, [1, 3, size, size])
}

type Message =
  | { type: 'load'; spec: ModelSpec }
  | {
      type: 'detect'
      id: number
      spec: ModelSpec
      bitmap: ImageBitmap
      width: number
      height: number
      options?: DecodeOptions
    }

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data
  if (message.type === 'load') {
    loadSession(message.spec)
      .then(() => self.postMessage({ type: 'ready', key: message.spec.key, backend }))
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : 'The ONNX model could not start.'
        self.postMessage({ type: 'error', key: message.spec.key, message: text })
      })
    return
  }
  if (message.type !== 'detect') return
  const { id, spec, bitmap, width, height, options } = message
  const started = performance.now()
  loadSession(spec)
    .then(async (loaded) => {
      const feeds: Record<string, ort.Tensor> = {}
      feeds[loaded.inputNames[0]!] = tensorFrom(bitmap, width, height, spec.inputSize)
      const output = await loaded.run(feeds)
      const first = output[loaded.outputNames[0]!]
      if (spec.task === 'pose') {
        const people = first
          ? decodeYoloPose(first.data as Float32Array, first.dims, width, height, spec.inputSize, options?.minScore ?? 0.3)
          : []
        self.postMessage({ type: 'result', id, detections: [], people, inferenceMs: performance.now() - started })
        return
      }
      const detections = first
        ? decodeYolo(first.data as Float32Array, first.dims, width, height, spec.inputSize, {
            ...options,
            classCount: spec.classCount,
            labels: spec.labels,
          })
        : []
      self.postMessage({ type: 'result', id, detections, inferenceMs: performance.now() - started })
    })
    .catch((error: unknown) => {
      bitmap.close()
      const text = error instanceof Error ? error.message : 'ONNX inference failed.'
      self.postMessage({ type: 'result', id, detections: [], inferenceMs: 0, error: text })
    })
}
