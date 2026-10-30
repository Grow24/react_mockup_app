import type { TrainingBox, TrainingImage } from '../shared/contracts.ts'

// Turns a labeled set into what Ultralytics and Roboflow read: YOLO text labels, data.yaml,
// Pascal VOC XML, and a training script that ends in an ONNX export the app can load.

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value))
}

export function yoloLabel(boxes: TrainingBox[], width: number, height: number) {
  return boxes
    .map((box) => {
      const x = clamp(box.x, 0, width)
      const y = clamp(box.y, 0, height)
      const w = clamp(box.x + box.width, 0, width) - x
      const h = clamp(box.y + box.height, 0, height) - y
      if (w <= 0 || h <= 0) return null
      const values = [(x + w / 2) / width, (y + h / 2) / height, w / width, h / height].map((value) => value.toFixed(6))
      return `${box.classId} ${values.join(' ')}`
    })
    .filter((line): line is string => line !== null)
    .join('\n')
}

function quoteYaml(text: string) {
  return `'${text.replace(/'/g, "''")}'`
}

export function dataYaml(classes: string[]) {
  return [
    'path: .',
    'train: images/train',
    'val: images/val',
    `nc: ${classes.length}`,
    'names:',
    ...classes.map((name, index) => `  ${index}: ${quoteYaml(name)}`),
    '',
  ].join('\n')
}

function escapeXml(text: string) {
  return text.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!)
}

export function vocXml(fileName: string, image: Pick<TrainingImage, 'width' | 'height' | 'boxes'>, classes: string[]) {
  const objects = image.boxes.map((box) => {
    const xmin = Math.round(clamp(box.x, 0, image.width))
    const ymin = Math.round(clamp(box.y, 0, image.height))
    const xmax = Math.round(clamp(box.x + box.width, 0, image.width))
    const ymax = Math.round(clamp(box.y + box.height, 0, image.height))
    return `  <object>
    <name>${escapeXml(classes[box.classId] ?? `class ${box.classId}`)}</name>
    <difficult>0</difficult>
    <bndbox><xmin>${xmin}</xmin><ymin>${ymin}</ymin><xmax>${xmax}</xmax><ymax>${ymax}</ymax></bndbox>
  </object>`
  })
  return `<annotation>
  <filename>${escapeXml(fileName)}</filename>
  <size><width>${image.width}</width><height>${image.height}</height><depth>3</depth></size>
${objects.join('\n')}
</annotation>
`
}

export const TRAIN_SCRIPT = `# Train a YOLOv8 detector on this dataset, then export it for PBMP Camera.
#   pip install ultralytics
#   python train.py
# Upload the ONNX file it prints on the AI screen, under Custom models.
from ultralytics import YOLO

model = YOLO("yolov8n.pt")
model.train(data="data.yaml", epochs=100, imgsz=640, patience=20)
path = model.export(format="onnx", imgsz=640)
print("ONNX model:", path)
`

export const DATASET_README = `PBMP Camera training set, in YOLO format.

images/train, images/val   the frames, as JPEG
labels/train, labels/val   one text file per frame: class x_center y_center width height, 0 to 1
data.yaml                  class names and folders, for Ultralytics
train.py                   trains YOLOv8n and exports best.onnx

After training, add the exported .onnx file on the AI screen under Custom models.
`
