import * as ort from 'onnxruntime-web/wasm'
import { decodeYolo, letterbox, YOLO_INPUT, YOLO_MODEL_URL, type DecodeOptions } from './yolo'

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/'
ort.env.wasm.numThreads = 1

let session: ort.InferenceSession | null = null

async function loadSession() {
  if (session) return session
  const response = await fetch(YOLO_MODEL_URL)
  if (!response.ok) throw new Error('The ONNX model could not be downloaded.')
  const bytes = await response.arrayBuffer()
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
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
      .then(() => self.postMessage({ type: 'ready' }))
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
