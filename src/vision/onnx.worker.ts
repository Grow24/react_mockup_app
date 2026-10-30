import * as ort from 'onnxruntime-web/webgpu'
import { decodeYolo, letterbox, YOLO_INPUT, YOLO_MODEL_URL, type DecodeOptions } from './yolo'

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/'
// Threads need SharedArrayBuffer, which the browser only allows on a cross-origin isolated page.
const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1
ort.env.wasm.numThreads = threads

type OnnxBackend = { name: 'webgpu' | 'wasm'; threads: number }

let session: ort.InferenceSession | null = null
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

async function timeRun(candidate: ort.InferenceSession) {
  const input = new ort.Tensor('float32', new Float32Array(3 * YOLO_INPUT * YOLO_INPUT), [1, 3, YOLO_INPUT, YOLO_INPUT])
  const feeds = { [candidate.inputNames[0]!]: input }
  await candidate.run(feeds)
  const started = performance.now()
  await candidate.run(feeds)
  return performance.now() - started
}

// Some GPUs are slower than four WASM threads, so the faster backend on this device wins.
async function loadSession() {
  if (session) return session
  const response = await fetch(YOLO_MODEL_URL)
  if (!response.ok) throw new Error('The ONNX model could not be downloaded.')
  const bytes = await response.arrayBuffer()
  const wasm = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
  if (await gpuReady()) {
    try {
      const gpu = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] })
      const [gpuMs, wasmMs] = [await timeRun(gpu), await timeRun(wasm)]
      if (gpuMs < wasmMs) {
        await wasm.release()
        session = gpu
        backend = { name: 'webgpu', threads }
        return session
      }
      await gpu.release()
    } catch (error) {
      console.warn('WebGPU could not run YOLOv8n, using WASM.', error)
    }
  }
  session = wasm
  backend = { name: 'wasm', threads }
  return session
}

function tensorFrom(bitmap: ImageBitmap, srcWidth: number, srcHeight: number) {
  const fitted = letterbox(srcWidth, srcHeight, YOLO_INPUT)
  const canvas = new OffscreenCanvas(YOLO_INPUT, YOLO_INPUT)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The ONNX worker could not draw the frame.')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, YOLO_INPUT, YOLO_INPUT)
  ctx.drawImage(bitmap, fitted.padX, fitted.padY, fitted.resizedW, fitted.resizedH)
  bitmap.close()
  const image = ctx.getImageData(0, 0, YOLO_INPUT, YOLO_INPUT)
  const input = new Float32Array(3 * YOLO_INPUT * YOLO_INPUT)
  const plane = YOLO_INPUT * YOLO_INPUT
  for (let pixel = 0, index = 0; pixel < image.data.length; pixel += 4, index += 1) {
    input[index] = image.data[pixel]! / 255
    input[plane + index] = image.data[pixel + 1]! / 255
    input[plane * 2 + index] = image.data[pixel + 2]! / 255
  }
  return new ort.Tensor('float32', input, [1, 3, YOLO_INPUT, YOLO_INPUT])
}

self.onmessage = (
  event: MessageEvent<{
    type: string
    id?: number
    bitmap?: ImageBitmap
    width?: number
    height?: number
    options?: DecodeOptions
  }>,
) => {
  const message = event.data
  if (message.type === 'load') {
    loadSession()
      .then(() => self.postMessage({ type: 'ready', backend }))
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : 'The ONNX model could not start.'
        self.postMessage({ type: 'error', message: text })
      })
    return
  }
  if (message.type !== 'detect' || !message.bitmap || message.id == null || !message.width || !message.height) return
  const bitmap = message.bitmap
  const id = message.id
  const width = message.width
  const height = message.height
  const options = message.options
  const started = performance.now()
  loadSession()
    .then(async (loaded) => {
      const feeds: Record<string, ort.Tensor> = {}
      feeds[loaded.inputNames[0]!] = tensorFrom(bitmap, width, height)
      const output = await loaded.run(feeds)
      const first = output[loaded.outputNames[0]!]
      const detections = first
        ? decodeYolo(first.data as Float32Array, first.dims, width, height, YOLO_INPUT, options)
        : []
      self.postMessage({ type: 'result', id, detections, inferenceMs: performance.now() - started })
    })
    .catch((error: unknown) => {
      bitmap.close()
      const text = error instanceof Error ? error.message : 'ONNX inference failed.'
      self.postMessage({ type: 'result', id, detections: [], inferenceMs: 0, error: text })
    })
}
