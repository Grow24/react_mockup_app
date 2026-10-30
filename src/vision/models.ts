import { ONNX_MODEL_ID, PEOPLE_MODEL_ID, SPORTS_BALL_CLASS, type CustomModel } from '../../shared/contracts.ts'
import { COCO_LABELS, YOLO_INPUT, YOLO_MODEL_URL } from './yolo'

// Ultralytics YOLOv8n-pose (AGPL-3.0), about 13 MB, pinned to one commit.
export const PEOPLE_MODEL_URL =
  'https://cdn.jsdelivr.net/gh/FatemeZamanian/YOLOv8-pose-onnxruntime-web@7d205675a3b440d1761d520de70c45d841d16b6c/public/model/yolov8n-pose.onnx'

export type DetectorModel = {
  id: string
  name: string
  url: string
  inputSize: number
  labels: readonly string[]
  ballClasses: readonly number[]
  builtIn: boolean
}

export const COCO_MODEL: DetectorModel = {
  id: ONNX_MODEL_ID,
  name: 'YOLOv8n COCO (built in)',
  url: YOLO_MODEL_URL,
  inputSize: YOLO_INPUT,
  labels: COCO_LABELS,
  ballClasses: [SPORTS_BALL_CLASS],
  builtIn: true,
}

export function detectorModel(record: CustomModel): DetectorModel {
  return {
    id: record.id,
    name: record.name,
    url: record.fileUrl,
    inputSize: record.inputSize,
    labels: record.labels,
    ballClasses: record.ballClasses,
    builtIn: false,
  }
}

export function modelChoices(models: CustomModel[]) {
  return [COCO_MODEL, ...models.map(detectorModel)]
}

export function findModel(models: CustomModel[], id: string | null | undefined) {
  if (!id || id === COCO_MODEL.id) return COCO_MODEL
  const record = models.find((model) => model.id === id)
  return record ? detectorModel(record) : null
}

export type ModelSpec = { key: string; url: string; inputSize: number; classCount: number; labels: string[]; task?: 'pose' }

export const PEOPLE_SPEC: ModelSpec = {
  key: PEOPLE_MODEL_ID,
  url: PEOPLE_MODEL_URL,
  inputSize: YOLO_INPUT,
  classCount: 1,
  labels: ['person'],
  task: 'pose',
}

export function specOf(model: DetectorModel): ModelSpec {
  return {
    key: model.id,
    url: model.url,
    inputSize: model.inputSize,
    classCount: model.labels.length,
    labels: [...model.labels],
  }
}
