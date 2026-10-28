import type { AiSnapshot, PosePoint } from '../types'

const COLORS = ['#f3d38a', '#9ee8e2', '#f0b7a4', '#d7c4f2']

const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 7],
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 8],
  [9, 10],
  [11, 12],
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 29],
  [27, 31],
  [29, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [28, 32],
  [30, 32],
]

export function frameRect(
  elementWidth: number,
  elementHeight: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  if (elementWidth <= 0 || elementHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(elementWidth / sourceWidth, elementHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    x: (elementWidth - width) / 2,
    y: (elementHeight - height) / 2,
    width,
    height,
  }
}

function colorFor(label: string) {
  let hash = 0
  for (const char of label) hash = (hash + char.charCodeAt(0)) % COLORS.length
  return COLORS[hash] ?? COLORS[0]
}

function pointAt(point: PosePoint, width: number, height: number) {
  return { x: point.x * width, y: point.y * height }
}

export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  snapshot: AiSnapshot,
) {
  if (width < 2 || height < 2 || sourceWidth < 2 || sourceHeight < 2) return
  const scaleX = width / sourceWidth
  const scaleY = height / sourceHeight

  ctx.lineWidth = 2
  ctx.font = '13px "Avenir Next", "Segoe UI", sans-serif'
  ctx.textBaseline = 'top'

  for (const detection of snapshot.detections) {
    const x = detection.box.x * scaleX
    const y = detection.box.y * scaleY
    const boxWidth = detection.box.width * scaleX
    const boxHeight = detection.box.height * scaleY
    const color = colorFor(detection.label)
    ctx.strokeStyle = color
    ctx.strokeRect(x, y, boxWidth, boxHeight)
    const caption = `${detection.label} ${Math.round(detection.score * 100)}%`
    const padX = 6
    const textWidth = ctx.measureText(caption).width
    const chipHeight = 20
    const chipY = y > chipHeight + 2 ? y - chipHeight : y
    ctx.fillStyle = color
    ctx.fillRect(x, chipY, textWidth + padX * 2, chipHeight)
    ctx.fillStyle = '#1c1916'
    ctx.fillText(caption, x + padX, chipY + 3)
  }

  const pose = snapshot.pose
  if (pose.filter((point) => point.visibility >= 0.5).length < 4) return

  ctx.strokeStyle = '#9ee8e2'
  ctx.fillStyle = '#f7fffe'
  ctx.lineWidth = 3
  ctx.beginPath()
  for (const [start, end] of POSE_CONNECTIONS) {
    const a = pose[start]
    const b = pose[end]
    if (!a || !b || a.visibility < 0.4 || b.visibility < 0.4) continue
    const from = pointAt(a, width, height)
    const to = pointAt(b, width, height)
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
  }
  ctx.stroke()

  for (const point of pose) {
    if (point.visibility < 0.5) continue
    const at = pointAt(point, width, height)
    ctx.beginPath()
    ctx.arc(at.x, at.y, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }
}
