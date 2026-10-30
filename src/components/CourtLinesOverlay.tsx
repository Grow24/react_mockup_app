import { useEffect, useRef, useState, type RefObject } from 'react'
import type { CourtCalibration } from '../../shared/contracts.ts'
import { drawCourtOverlay } from '../vision/courtOverlay'
import { frameRect } from '../vision/draw'

// The marked court drawn over a photo or video, sized to the frame's letterboxed picture.
export function CourtLinesOverlay({
  frameRef,
  court,
  mediaWidth,
  mediaHeight,
}: {
  frameRef: RefObject<HTMLElement | null>
  court: CourtCalibration | null
  mediaWidth: number
  mediaHeight: number
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
    const bounds = frameRect(size.width, size.height, mediaWidth, mediaHeight)
    const dpr = window.devicePixelRatio || 1
    canvas.style.left = `${frame.offsetLeft + bounds.x}px`
    canvas.style.top = `${frame.offsetTop + bounds.y}px`
    canvas.style.width = `${bounds.width}px`
    canvas.style.height = `${bounds.height}px`
    canvas.width = Math.max(1, Math.round(bounds.width * dpr))
    canvas.height = Math.max(1, Math.round(bounds.height * dpr))
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, bounds.width, bounds.height)
    if (!court || bounds.width < 2 || mediaWidth < 2) return
    if (Math.abs(court.sourceWidth / court.sourceHeight - mediaWidth / mediaHeight) / (mediaWidth / mediaHeight) > 0.02) return
    drawCourtOverlay(context, court, bounds.width / court.sourceWidth, bounds.height / court.sourceHeight)
  }, [frameRef, court, mediaWidth, mediaHeight, size])

  return <canvas ref={canvasRef} className="annotation court-lines" aria-hidden="true" />
}
