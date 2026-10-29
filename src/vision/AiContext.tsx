import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AiSnapshot } from '../types'
import { AiContext, type AiStatus } from './context'
import { loadEngines, resetEngines, type DelegateName, type Engines } from './engine'
import { prepareOnnx, resetOnnx } from './onnxDetector'
import { OBJECT_MODEL_ID, ONNX_MODEL_ID, type ObjectDetectorId } from './yolo'

const ENABLED_KEY = 'pbmp-ai-enabled'
const CONFIDENCE_KEY = 'pbmp-ai-confidence'
const DETECTOR_KEY = 'pbmp-object-detector'

function readEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

function readConfidence() {
  try {
    const raw = localStorage.getItem(CONFIDENCE_KEY)
    if (!raw) return 0.5
    const value = Number(raw)
    if (!Number.isFinite(value)) return 0.5
    return Math.min(0.9, Math.max(0.3, value))
  } catch {
    return 0.5
  }
}

function readDetector(): ObjectDetectorId {
  try {
    return localStorage.getItem(DETECTOR_KEY) === ONNX_MODEL_ID ? ONNX_MODEL_ID : OBJECT_MODEL_ID
  } catch {
    return OBJECT_MODEL_ID
  }
}

function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // The switch still works for this visit when storage is blocked.
  }
}

function loadError(error: unknown) {
  const raw = error instanceof Error ? error.message : ''
  if (/fetch|network|Failed to fetch|NetworkError|404/i.test(raw)) {
    return 'The AI models could not be downloaded. Check the connection, then try again. Capture still works.'
  }
  return 'AI could not start in this browser. Capture still works.'
}

export function AiProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(readEnabled)
  const [confidence, setConfidenceState] = useState(readConfidence)
  const [objectDetector, setObjectDetectorState] = useState<ObjectDetectorId>(readDetector)
  const [error, setError] = useState<string | null>(null)
  const [delegate, setDelegate] = useState<DelegateName | null>(null)
  const [latest, setLatest] = useState<AiSnapshot | null>(null)
  const [engines, setEngines] = useState<Engines | null>(null)
  const [onnxReady, setOnnxReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const latestRef = useRef<AiSnapshot | null>(null)
  const enabledRef = useRef(enabled)

  const publish = useCallback((snapshot: AiSnapshot) => {
    latestRef.current = snapshot
    setLatest(snapshot)
  }, [])

  const readSnapshot = useCallback(() => {
    if (!enabledRef.current) return null
    return latestRef.current
  }, [])

  const setEnabled = useCallback((next: boolean) => {
    enabledRef.current = next
    writeSetting(ENABLED_KEY, next ? '1' : '0')
    setEnabledState(next)
    setError(null)
    if (!next) {
      latestRef.current = null
      setLatest(null)
    }
  }, [])

  const setConfidence = useCallback((next: number) => {
    const clamped = Math.min(0.9, Math.max(0.3, next))
    writeSetting(CONFIDENCE_KEY, String(clamped))
    setConfidenceState(clamped)
  }, [])

  const setObjectDetector = useCallback((next: ObjectDetectorId) => {
    writeSetting(DETECTOR_KEY, next)
    setObjectDetectorState(next)
    setError(null)
  }, [])

  const retry = useCallback(() => {
    resetEngines()
    resetOnnx()
    setEngines(null)
    setOnnxReady(false)
    setAttempt((current) => current + 1)
    setEnabled(true)
  }, [setEnabled])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    loadEngines()
      .then((loaded) => {
        if (cancelled) return
        setEngines(loaded)
        setDelegate(loaded.delegate)
      })
      .catch((caught) => {
        if (cancelled) return
        console.error(caught)
        setEngines(null)
        setError(loadError(caught))
      })

    return () => {
      cancelled = true
    }
  }, [enabled, attempt])

  useEffect(() => {
    if (!enabled || objectDetector !== ONNX_MODEL_ID) return
    let cancelled = false
    prepareOnnx()
      .then(() => {
        if (!cancelled) setOnnxReady(true)
      })
      .catch((caught) => {
        if (cancelled) return
        console.error(caught)
        setOnnxReady(false)
        setError(loadError(caught))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, objectDetector, attempt])

  const status: AiStatus = !enabled
    ? 'off'
    : error
      ? 'error'
      : !engines || (objectDetector === ONNX_MODEL_ID && !onnxReady)
        ? 'loading'
        : 'ready'

  const value = useMemo(
    () => ({
      enabled,
      confidence,
      objectDetector,
      status,
      error,
      delegate,
      latest,
      engines,
      setEnabled,
      setConfidence,
      setObjectDetector,
      retry,
      publish,
      readSnapshot,
    }),
    [
      enabled,
      confidence,
      objectDetector,
      status,
      error,
      delegate,
      latest,
      engines,
      setEnabled,
      setConfidence,
      setObjectDetector,
      retry,
      publish,
      readSnapshot,
    ],
  )

  return <AiContext.Provider value={value}>{children}</AiContext.Provider>
}
