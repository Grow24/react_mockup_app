import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  BALL_TRACK_LIMIT,
  type BallPoint,
  type BallTrack,
  type CourtCalibration,
} from '../../shared/contracts.ts'
import { candidatesFrom, courtFitsTrack, linkBallTrack, type BallFrame } from './ball'
import { flightBounces, groundFromImage, lineCall, projectPoint } from './flight'
import { fitFlightsInWorker } from './flightFit'
import type { DetectorModel } from './models'
import { detectSource, onnxBackend, prepareOnnx, type OnnxBackend } from './onnxDetector'

const WINDOW_SECONDS = 4
const KEEP_SECONDS = 15 * 60
const FIT_EVERY_SECONDS = 0.5
const SAME_BOUNCE_SECONDS = 0.25
const SHOW_BOUNCES = 6
const MIN_SCORE = 0.15

export type LiveBounce = {
  t: number
  image: { x: number; y: number }
  meters: { x: number; y: number } | null
  call: 'in' | 'out' | null
  confirmed: boolean
}

export type LiveBallView = {
  now: number
  width: number
  height: number
  points: BallPoint[]
  bounces: LiveBounce[]
}

export type LiveBallStatus = 'off' | 'loading' | 'live' | 'error'

function seconds() {
  return performance.now() / 1000
}

function asTrack(
  frames: BallFrame[],
  from: number,
  width: number,
  height: number,
  fps: number,
  duration: number,
  modelId: string,
) {
  const shifted = frames.map((frame) => ({ t: frame.t - from, candidates: frame.candidates }))
  const track: BallTrack = {
    assetId: '',
    modelId,
    sourceWidth: width,
    sourceHeight: height,
    sampleFps: Math.min(60, Math.max(1, Math.round(fps))),
    duration,
    createdAt: Date.now(),
    points: linkBallTrack(shifted, width, height).slice(0, BALL_TRACK_LIMIT),
    live: true,
  }
  return track
}

// Runs YOLOv8n on the live preview as fast as this device allows, links the hits into a trail,
// and calls bounces in or out on this phone's court.
export function useLiveBall(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  court: CourtCalibration | null,
  model: DetectorModel,
) {
  const [status, setStatus] = useState<LiveBallStatus>('off')
  const [error, setError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [view, setView] = useState<LiveBallView | null>(null)
  const [backend, setBackend] = useState<OnnxBackend | null>(null)
  const framesRef = useRef<BallFrame[]>([])
  const sizeRef = useRef({ width: 0, height: 0 })
  const bouncesRef = useRef<LiveBounce[]>([])
  const fpsRef = useRef(0)
  const courtRef = useRef(court)
  const modelRef = useRef(model)

  useEffect(() => {
    courtRef.current = court
    modelRef.current = model
  })

  useEffect(() => {
    if (!enabled) return
    let active = true
    let fitting = false
    let lastFit = 0
    const stamps: number[] = []
    framesRef.current = []
    bouncesRef.current = []

    const remember = (bounce: LiveBounce) => {
      const list = bouncesRef.current
      const same = list.findIndex((item) => Math.abs(item.t - bounce.t) <= SAME_BOUNCE_SECONDS)
      if (same >= 0) {
        if (list[same]!.confirmed && !bounce.confirmed) return
        list[same] = bounce
      } else {
        list.push(bounce)
        list.sort((a, b) => a.t - b.t)
      }
      if (list.length > 50) list.splice(0, list.length - 50)
    }

    const placed = (image: { x: number; y: number }, width: number, height: number) => {
      const current = courtRef.current
      if (!current || Math.abs(current.sourceWidth / current.sourceHeight - width / height) / (width / height) > 0.02) {
        return { meters: null, call: null }
      }
      const toCourt = groundFromImage(current)
      const meters = toCourt?.({ x: (image.x * current.sourceWidth) / width, y: (image.y * current.sourceHeight) / height }) ?? null
      return { meters, call: meters ? lineCall(current.preset, meters) : null }
    }

    const confirm = (recent: BallFrame[], from: number, width: number, height: number) => {
      const current = courtRef.current
      if (!current || fitting) return
      const track = asTrack(recent, from, width, height, fpsRef.current || 1, recent.at(-1)!.t - from, modelRef.current.id)
      if (!courtFitsTrack(track, current)) return
      fitting = true
      fitFlightsInWorker(track, current)
        .then((fit) => {
          if (!active || !fit) return
          const settledFrom = from + SAME_BOUNCE_SECONDS
          const settledTo = from + track.duration - SAME_BOUNCE_SECONDS
          bouncesRef.current = bouncesRef.current.filter(
            (bounce) => bounce.confirmed || bounce.t < settledFrom || bounce.t > settledTo,
          )
          for (const bounce of flightBounces(fit.flights.filter((flight) => flight.reliable))) {
            const image = projectPoint(fit.camera, bounce.p)
            remember({
              t: bounce.t + from,
              image: image
                ? { x: (image.x * width) / current.sourceWidth, y: (image.y * height) / current.sourceHeight }
                : { x: 0, y: 0 },
              meters: { x: bounce.p.x, y: bounce.p.y },
              call: lineCall(current.preset, bounce.p),
              confirmed: true,
            })
          }
        })
        .catch((caught) => console.error(caught))
        .finally(() => {
          fitting = false
        })
    }

    const loop = async () => {
      setStatus('loading')
      setError(null)
      const chosen = modelRef.current
      if (chosen.ballClasses.length === 0) {
        setStatus('error')
        setError(`Pick which classes are the ball for ${chosen.name} on the AI screen.`)
        return
      }
      try {
        await prepareOnnx(chosen)
      } catch (caught) {
        if (!active) return
        setStatus('error')
        setError(caught instanceof Error ? caught.message : 'YOLOv8n could not start.')
        return
      }
      if (!active) return
      setBackend(onnxBackend())
      setStatus('live')
      while (active) {
        const video = videoRef.current
        if (!video || video.readyState < 2 || video.videoWidth < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 100))
          continue
        }
        const width = video.videoWidth
        const height = video.videoHeight
        const t = seconds()
        let result: Awaited<ReturnType<typeof detectSource>> = null
        try {
          result = await detectSource(video, width, height, { model: chosen, classes: chosen.ballClasses, minScore: MIN_SCORE })
        } catch (caught) {
          console.error(caught)
        }
        if (!active) return
        if (!result) {
          await new Promise((resolve) => window.setTimeout(resolve, 30))
          continue
        }
        if (width !== sizeRef.current.width || height !== sizeRef.current.height) {
          sizeRef.current = { width, height }
          framesRef.current = []
          bouncesRef.current = []
        }
        const frames = framesRef.current
        frames.push({ t, candidates: candidatesFrom(result.detections) })
        while (frames.length > 0 && t - frames[0]!.t > KEEP_SECONDS) frames.shift()
        stamps.push(t)
        while (stamps.length > 0 && t - stamps[0]! > 2) stamps.shift()
        fpsRef.current = stamps.length > 1 ? (stamps.length - 1) / (stamps.at(-1)! - stamps[0]!) : 0

        const from = t - WINDOW_SECONDS
        const recent = frames.filter((frame) => frame.t >= from)
        const points = linkBallTrack(recent, width, height)
        for (const point of points) {
          if (!point.bounce) continue
          const ground = { x: point.x, y: point.y + point.radius }
          remember({ t: point.t, image: ground, ...placed(ground, width, height), confirmed: false })
        }
        if (t - lastFit >= FIT_EVERY_SECONDS && recent.length >= 8) {
          lastFit = t
          confirm(recent, recent[0]!.t, width, height)
        }
        setFps(fpsRef.current)
        setView({
          now: t,
          width,
          height,
          points,
          bounces: bouncesRef.current.slice(-SHOW_BOUNCES),
        })
      }
    }
    void loop()
    return () => {
      active = false
      setStatus('off')
      setView(null)
      setFps(0)
    }
  }, [enabled, videoRef, model.id])

  // The recording clock starts at the recorder's start event, measured on the same clock as the frames.
  function trackBetween(assetId: string, fromMs: number, toMs: number): BallTrack | null {
    const from = fromMs / 1000
    const to = toMs / 1000
    const frames = framesRef.current.filter((frame) => frame.t >= from && frame.t <= to)
    const { width, height } = sizeRef.current
    if (frames.length < 2 || width < 2) return null
    const track = asTrack(frames, from, width, height, frames.length / Math.max(0.001, to - from), to - from, modelRef.current.id)
    return { ...track, assetId }
  }

  return { status, error, fps, view, backend, trackBetween }
}
