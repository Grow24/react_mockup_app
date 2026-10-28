import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AiSnapshot } from '../types'
import { drawAnnotations, frameRect } from '../vision/draw'

export function AnnotationCanvas({
  frameRef,
  sourceWidth,
  sourceHeight,
  snapshot,
}: {
  frameRef: RefObject<HTMLElement | null>
  sourceWidth: number
  sourceHeight: number
  snapshot: AiSnapshot | null
}) {
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
    const frame = frameRef.current
    if (!canvas || !frame) return
    const bounds = frameRect(size.width, size.height, sourceWidth, sourceHeight)
    const dpr = window.devicePixelRatio || 1
    canvas.style.left = `${bounds.x}px`
    canvas.style.top = `${bounds.y}px`
    canvas.style.width = `${bounds.width}px`
    canvas.style.height = `${bounds.height}px`
    canvas.width = Math.max(1, Math.round(bounds.width * dpr))
    canvas.height = Math.max(1, Math.round(bounds.height * dpr))
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, bounds.width, bounds.height)
    if (!snapshot || bounds.width < 2) return
    drawAnnotations(context, bounds.width, bounds.height, sourceWidth, sourceHeight, snapshot)
  }, [frameRef, size, snapshot, sourceWidth, sourceHeight])

  return <canvas ref={canvasRef} className="annotation" aria-hidden="true" />
}
