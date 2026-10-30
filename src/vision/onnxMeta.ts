// Reads class names, input size, and tensor shapes from an ONNX file without loading the weights.
// Only the few protobuf fields needed are decoded; everything else, including the weights, is skipped.

export type OnnxMeta = {
  names: string[] | null
  inputSize: number | null
  inputDims: number[] | null
  outputDims: number[] | null
}

type Field = { number: number; wire: number; value: number; start: number; end: number }

function readVarint(bytes: Uint8Array, at: number) {
  let value = 0
  let scale = 1
  let offset = at
  for (;;) {
    if (offset >= bytes.length) throw new Error('The ONNX file ends early.')
    const byte = bytes[offset]!
    offset += 1
    value += (byte & 0x7f) * scale
    if (byte < 0x80) return { value, next: offset }
    scale *= 128
    if (scale > 2 ** 63) throw new Error('The ONNX file has a broken number.')
  }
}

function* fields(bytes: Uint8Array, start: number, end: number): Generator<Field> {
  let offset = start
  while (offset < end) {
    const key = readVarint(bytes, offset)
    const number = Math.floor(key.value / 8)
    const wire = key.value % 8
    offset = key.next
    if (wire === 0) {
      const varint = readVarint(bytes, offset)
      yield { number, wire, value: varint.value, start: offset, end: varint.next }
      offset = varint.next
    } else if (wire === 2) {
      const length = readVarint(bytes, offset)
      const begin = length.next
      const finish = begin + length.value
      if (finish > end) throw new Error('The ONNX file ends early.')
      yield { number, wire, value: length.value, start: begin, end: finish }
      offset = finish
    } else if (wire === 1) {
      offset += 8
    } else if (wire === 5) {
      offset += 4
    } else {
      throw new Error('This file is not an ONNX model.')
    }
  }
}

const text = new TextDecoder()

function readString(bytes: Uint8Array, field: Field) {
  return text.decode(bytes.subarray(field.start, field.end))
}

function readEntry(bytes: Uint8Array, field: Field) {
  let key = ''
  let value = ''
  for (const inner of fields(bytes, field.start, field.end)) {
    if (inner.number === 1 && inner.wire === 2) key = readString(bytes, inner)
    if (inner.number === 2 && inner.wire === 2) value = readString(bytes, inner)
  }
  return { key, value }
}

// ValueInfoProto.type -> TypeProto.tensor_type -> Tensor.shape -> TensorShapeProto.dim
function readDims(bytes: Uint8Array, valueInfo: Field) {
  for (const type of fields(bytes, valueInfo.start, valueInfo.end)) {
    if (type.number !== 2 || type.wire !== 2) continue
    for (const tensor of fields(bytes, type.start, type.end)) {
      if (tensor.number !== 1 || tensor.wire !== 2) continue
      for (const shape of fields(bytes, tensor.start, tensor.end)) {
        if (shape.number !== 2 || shape.wire !== 2) continue
        const dims: number[] = []
        for (const dim of fields(bytes, shape.start, shape.end)) {
          if (dim.number !== 1 || dim.wire !== 2) continue
          let size = -1
          for (const part of fields(bytes, dim.start, dim.end)) {
            if (part.number === 1 && part.wire === 0) size = part.value
          }
          dims.push(size)
        }
        return dims
      }
    }
  }
  return null
}

// Ultralytics writes names as a Python dict, for example {0: 'ball', 1: 'player'}.
export function parseNames(raw: string) {
  const found = new Map<number, string>()
  for (const match of raw.matchAll(/(\d+)\s*:\s*(['"])(.*?)\2/g)) found.set(Number(match[1]), match[3]!.trim())
  if (found.size === 0) return null
  const names: string[] = []
  for (let index = 0; index <= Math.max(...found.keys()); index += 1) names.push(found.get(index) ?? `class ${index}`)
  return names
}

export function readOnnxMeta(buffer: ArrayBuffer): OnnxMeta {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 16 || bytes[0] !== 0x08) throw new Error('This file is not an ONNX model.')
  const meta: OnnxMeta = { names: null, inputSize: null, inputDims: null, outputDims: null }
  let imgsz: number | null = null
  let sawGraph = false
  for (const field of fields(bytes, 0, bytes.length)) {
    if (field.number === 14 && field.wire === 2) {
      const entry = readEntry(bytes, field)
      if (entry.key === 'names') meta.names = parseNames(entry.value)
      if (entry.key === 'imgsz') {
        const size = Number(entry.value.match(/\d+/)?.[0])
        if (Number.isFinite(size) && size > 0) imgsz = size
      }
    }
    if (field.number === 7 && field.wire === 2) {
      sawGraph = true
      for (const part of fields(bytes, field.start, field.end)) {
        if (part.number === 11 && part.wire === 2 && !meta.inputDims) meta.inputDims = readDims(bytes, part)
        if (part.number === 12 && part.wire === 2 && !meta.outputDims) meta.outputDims = readDims(bytes, part)
      }
    }
  }
  if (!sawGraph) throw new Error('This file is not an ONNX model.')
  const side = meta.inputDims && meta.inputDims.length === 4 ? meta.inputDims[2]! : -1
  meta.inputSize = side > 0 ? side : imgsz
  return meta
}

// YOLOv8 rows are 4 box values plus one score per class; YOLOv5 adds an objectness row.
export function classCountFrom(meta: OnnxMeta) {
  const dims = meta.outputDims
  if (!dims || dims.length !== 3) return meta.names?.length ?? null
  const named = meta.names?.length
  for (const rows of [dims[1]!, dims[2]!]) {
    if (rows <= 4) continue
    if (named && (rows === named + 4 || rows === named + 5)) return named
  }
  const rows = Math.min(...[dims[1]!, dims[2]!].filter((value) => value > 4))
  return Number.isFinite(rows) ? rows - 4 : (named ?? null)
}
