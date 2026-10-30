import type { CourtCalibration } from '../../shared/contracts.ts'
import { courtImageLines, originAxes } from './cameraPose.ts'
import { cameraFromCourt } from './flight.ts'

type Overlay = { lines: ReturnType<typeof courtImageLines>; axes: ReturnType<typeof originAxes> }

const cache = new WeakMap<CourtCalibration, Overlay>()

function overlayFor(court: CourtCalibration): Overlay {
  let found = cache.get(court)
  if (!found) {
    found = { lines: courtImageLines(court), axes: originAxes(court, cameraFromCourt(court)) }
    cache.set(court, found)
  }
  return found
}

// Draws every court line over a frame, even where the court runs out of view, and the court's
// origin with one meter along x, y, and z. scaleX and scaleY map court-photo pixels to the canvas.
export function drawCourtOverlay(context: CanvasRenderingContext2D, court: CourtCalibration, scaleX: number, scaleY: number) {
  const { lines, axes } = overlayFor(court)
  context.save()
  context.lineWidth = 1.5
  context.strokeStyle = 'rgba(127, 216, 207, 0.8)'
  for (const line of lines) {
    context.beginPath()
    line.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x * scaleX, point.y * scaleY)
      else context.lineTo(point.x * scaleX, point.y * scaleY)
    })
    context.stroke()
  }
  if (axes) {
    const origin = { x: axes.origin.x * scaleX, y: axes.origin.y * scaleY }
    const arrows: [string, string, { x: number; y: number } | null][] = [
      ['x', '#e0603c', axes.x],
      ['y', '#7fd8cf', axes.y],
      ['z', '#f3d38a', axes.z],
    ]
    context.lineWidth = 3
    context.font = '700 12px "Avenir Next", "Segoe UI", sans-serif'
    for (const [name, color, tip] of arrows) {
      if (!tip) continue
      const end = { x: tip.x * scaleX, y: tip.y * scaleY }
      context.strokeStyle = color
      context.fillStyle = color
      context.beginPath()
      context.moveTo(origin.x, origin.y)
      context.lineTo(end.x, end.y)
      context.stroke()
      context.fillText(name, end.x + 4, end.y - 4)
    }
    context.fillStyle = '#fffdf9'
    context.beginPath()
    context.arc(origin.x, origin.y, 4, 0, Math.PI * 2)
    context.fill()
    context.fillText('(0, 0, 0)', origin.x + 6, origin.y + 14)
  }
  context.restore()
}
