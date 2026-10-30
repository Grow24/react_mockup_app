import { useEffect, useRef, useState, type RefObject } from 'react'
import type { CourtCalibration } from '../../shared/contracts.ts'
import { drawCourtOverlay } from '../vision/courtOverlay'
import { frameRect } from '../vision/draw'
import type { LiveBallView } from '../vision/useLiveBall'
import { useUnits, xyz } from '../units'

const TRAIL_SECONDS = 1
const CURRENT_SECONDS = 0.5
const BOUNCE_SECONDS = 3

export function LiveBallOverlay({
  frameRef,
  view,
  court,
}: {
  frameRef: RefObject<HTMLVideoElement | null>
  view: LiveBallView | null
  court: CourtCalibration | null
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const units = useUnits()
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const measure = () => setSize({ width: frame.clientWidth, height: frame.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [frameRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = view?.width ?? 0
    const height = view?.height ?? 0
    const bounds = frameRect(size.width, size.height, width, height)
    const dpr = window.devicePixelRatio || 1
    canvas.style.left = `${bounds.x}px`
    canvas.style.top = `${bounds.y}px`
    canvas.style.width = `${bounds.width}px`
    canvas.style.height = `${bounds.height}px`
    canvas.width = Math.max(1, Math.round(bounds.width * dpr))
    canvas.height = Math.max(1, Math.round(bounds.height * dpr))
    const context = canvas.getContext('2d')
    if (!context || !view || bounds.width < 2) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    const sx = bounds.width / width
    const sy = bounds.height / height
    if (court && Math.abs(court.sourceWidth / court.sourceHeight - width / height) / (width / height) <= 0.02) {
      drawCourtOverlay(context, court, bounds.width / court.sourceWidth, bounds.height / court.sourceHeight)
    }
    const trail = view.points.filter((point) => view.now - point.t <= TRAIL_SECONDS)
    context.lineWidth = 3
    context.lineCap = 'round'
    for (let index = 1; index < trail.length; index += 1) {
      const from = trail[index - 1]!
      const to = trail[index]!
      if (to.t - from.t > 0.4) continue
      context.strokeStyle = `rgba(243, 211, 138, ${0.3 + (0.7 * index) / trail.length})`
      context.beginPath()
      context.moveTo(from.x * sx, from.y * sy)
      context.lineTo(to.x * sx, to.y * sy)
      context.stroke()
    }
    const latest = view.points.at(-1)
    if (latest && view.now - latest.t <= CURRENT_SECONDS) {
      context.strokeStyle = '#f3d38a'
      context.beginPath()
      context.arc(latest.x * sx, latest.y * sy, Math.max(8, latest.radius * sx + 4), 0, Math.PI * 2)
      context.stroke()
    }
    context.font = '700 12px "Avenir Next", "Segoe UI", sans-serif'
    context.textAlign = 'center'
    for (const bounce of view.bounces) {
      if (view.now - bounce.t > BOUNCE_SECONDS) continue
      const x = bounce.image.x * sx
      const y = bounce.image.y * sy
      context.fillStyle = bounce.call === 'out' ? '#e0603c' : bounce.call === 'in' ? '#7fd8cf' : '#f3d38a'
      context.beginPath()
      context.arc(x, y, 6, 0, Math.PI * 2)
      context.fill()
      if (bounce.call) context.fillText(bounce.call.toUpperCase(), x, y - 10)
    }
    if (view.ballNow) {
      const label = xyz(view.ballNow.p, units)
      const x = view.ballNow.image.x * sx
      const y = view.ballNow.image.y * sy
      context.textAlign = 'left'
      const textWidth = context.measureText(label).width
      const left = Math.min(bounds.width - textWidth - 6, Math.max(4, x + 12))
      const top = Math.max(16, y - 10)
      context.fillStyle = 'rgba(22, 19, 16, 0.75)'
      context.fillRect(left - 4, top - 13, textWidth + 8, 18)
      context.fillStyle = '#f3d38a'
      context.fillText(label, left, top)
    }
  }, [size, view, court, units])

  return <canvas ref={canvasRef} className="annotation" aria-hidden="true" />
}
