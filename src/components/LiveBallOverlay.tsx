import { useEffect, useRef, useState, type RefObject } from 'react'
import { frameRect } from '../vision/draw'
import type { LiveBallView } from '../vision/useLiveBall'

const TRAIL_SECONDS = 1
const CURRENT_SECONDS = 0.5
const BOUNCE_SECONDS = 3

export function LiveBallOverlay({ frameRef, view }: { frameRef: RefObject<HTMLVideoElement | null>; view: LiveBallView | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
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
  }, [size, view])

  return <canvas ref={canvasRef} className="annotation" aria-hidden="true" />
}
