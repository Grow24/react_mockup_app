import type { CourtCalibration } from '../../shared/contracts.ts'
import { courtArea, courtLines } from '../../shared/court.ts'
import { courtPixelSize, mapPixel } from './court'

// The top-down court with its lines and the area that counts as in, at the map's own scale.
export function drawCourtLines(context: CanvasRenderingContext2D, court: Pick<CourtCalibration, 'preset' | 'callArea'>) {
  const preset = court.preset
  const size = courtPixelSize(preset)
  context.fillStyle = '#2e6b4a'
  context.fillRect(0, 0, size.width, size.height)
  const area = courtArea(preset, court.callArea)
  const corner = mapPixel(preset, { x: area.x0, y: area.y1 })
  const far = mapPixel(preset, { x: area.x1, y: area.y0 })
  context.fillStyle = 'rgba(127, 216, 207, 0.22)'
  context.fillRect(corner.x, corner.y, far.x - corner.x, far.y - corner.y)
  context.strokeStyle = '#f6f1ea'
  context.lineWidth = 2
  for (const line of courtLines(preset)) {
    const from = mapPixel(preset, line.from)
    const to = mapPixel(preset, line.to)
    context.setLineDash(line.dashed ? [6, 6] : [])
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
  }
  context.setLineDash([])
}
