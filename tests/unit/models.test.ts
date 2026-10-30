import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classCountFrom, parseNames, readOnnxMeta } from '../../src/vision/onnxMeta.ts'
import { decodeYolo } from '../../src/vision/yolo.ts'

function head(rows: number, anchors: number, set: (put: (anchor: number, row: number, value: number) => void) => void) {
  const data = new Float32Array(rows * anchors)
  set((anchor, row, value) => (data[row * anchors + anchor] = value))
  return data
}

describe('YOLO decoding', () => {
  it('reads the COCO head and filters to one class', () => {
    const data = head(84, 2, (put) => {
      for (const [row, value] of [[0, 320], [1, 320], [2, 100], [3, 100], [4, 0.91]] as const) put(0, row, value)
      for (const [row, value] of [[0, 500], [1, 200], [2, 20], [3, 20], [36, 0.18]] as const) put(1, row, value)
    })
    const all = decodeYolo(data, [1, 84, 2], 320, 240)
    assert.deepEqual(all.map((item) => item.label), ['person'])
    assert.ok(Math.abs(all[0]!.box.x - 135) < 1 && Math.abs(all[0]!.box.y - 95) < 1)
    assert.deepEqual(decodeYolo(data, [1, 84, 2], 320, 240, 640, { classes: [32], minScore: 0.15 }).map((item) => item.label), ['sports ball'])
  })

  it('reads a two-class custom head in either layout', () => {
    const data = head(6, 2, (put) => {
      for (const [row, value] of [[0, 320], [1, 320], [2, 20], [3, 20], [4, 0.7]] as const) put(0, row, value)
      for (const [row, value] of [[0, 100], [1, 200], [2, 60], [3, 150], [5, 0.8]] as const) put(1, row, value)
    })
    const options = { classCount: 2, labels: ['ball', 'player'] }
    assert.deepEqual(decodeYolo(data, [1, 6, 2], 640, 640, 640, options).map((item) => item.label), ['player', 'ball'])
    const last = new Float32Array(12)
    for (let anchor = 0; anchor < 2; anchor += 1) for (let row = 0; row < 6; row += 1) last[anchor * 6 + row] = data[row * 2 + anchor]!
    assert.deepEqual(decodeYolo(last, [1, 2, 6], 640, 640, 640, options).map((item) => item.label), ['player', 'ball'])
  })
})

// Writes just enough ONNX protobuf for the metadata reader: metadata entries and graph shapes.
function varint(value: number) {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 128) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest)
  return bytes
}
const field = (number: number, payload: number[]) => [...varint(number * 8 + 2), ...varint(payload.length), ...payload]
const text = (value: string) => [...new TextEncoder().encode(value)]
const valueInfo = (name: string, dims: number[]) =>
  field(1, text(name)).concat(
    field(2, field(1, field(2, dims.flatMap((dim) => field(1, [...varint(1 * 8), ...varint(dim)]))))),
  )

function onnxFile(names: string, dims: number[]) {
  const graph = [...field(11, valueInfo('images', [1, 3, 640, 640])), ...field(12, valueInfo('output0', dims))]
  const bytes = [8, 8, ...field(14, [...field(1, text('names')), ...field(2, text(names))]), ...field(7, graph)]
  return new Uint8Array(bytes).buffer
}

describe('ONNX metadata', () => {
  it('reads class names, input size, and class count', () => {
    const meta = readOnnxMeta(onnxFile("{0: 'ball', 1: 'player'}", [1, 6, 8400]))
    assert.deepEqual(meta.names, ['ball', 'player'])
    assert.equal(meta.inputSize, 640)
    assert.deepEqual(meta.outputDims, [1, 6, 8400])
    assert.equal(classCountFrom(meta), 2)
  })

  it('names gaps and rejects files that are not ONNX', () => {
    assert.deepEqual(parseNames("{0: 'a', 2: \"c\"}"), ['a', 'class 1', 'c'])
    assert.throws(() => readOnnxMeta(new TextEncoder().encode('just some text, not a model').buffer), /not an ONNX model/)
  })
})
