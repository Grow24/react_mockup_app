import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AiSnapshot } from '../types'
import { useSession } from '../session/context'
import { AiContext, type AiStatus, type PoseMode } from './context'
import { loadEngines, resetEngines, type DelegateName, type Engines } from './engine'
import { findModel } from './models'
import { prepareOnnx, preparePeople, resetOnnx } from './onnxDetector'
import { OBJECT_MODEL_ID, type ObjectDetectorId } from './yolo'

const ENABLED_KEY = 'pbmp-ai-enabled'
const CONFIDENCE_KEY = 'pbmp-ai-confidence'
const DETECTOR_KEY = 'pbmp-object-detector'
const POSE_MODE_KEY = 'pbmp-pose-mode'

function readPoseMode(): PoseMode {
  try {
    return localStorage.getItem(POSE_MODE_KEY) === 'people' ? 'people' : 'single'
  } catch {
    return 'single'
  }
}

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
    return localStorage.getItem(DETECTOR_KEY) || OBJECT_MODEL_ID
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
  const { models } = useSession()
  const [enabled, setEnabledState] = useState(readEnabled)
  const [confidence, setConfidenceState] = useState(readConfidence)
  const [chosenDetector, setObjectDetectorState] = useState<ObjectDetectorId>(readDetector)
  const [poseMode, setPoseModeState] = useState<PoseMode>(readPoseMode)
  const [peopleReady, setPeopleReady] = useState(false)
  // A custom model that was removed from the session falls back to MediaPipe.
  const objectModel = chosenDetector === OBJECT_MODEL_ID ? null : findModel(models, chosenDetector)
  const objectDetector = objectModel ? chosenDetector : OBJECT_MODEL_ID
  const [error, setError] = useState<string | null>(null)
  const [delegate, setDelegate] = useState<DelegateName | null>(null)
  const [latest, setLatest] = useState<AiSnapshot | null>(null)
  const [engines, setEngines] = useState<Engines | null>(null)
  const [onnxReadyId, setOnnxReadyId] = useState<string | null>(null)
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

  const setPoseMode = useCallback((next: PoseMode) => {
    writeSetting(POSE_MODE_KEY, next)
    setPoseModeState(next)
    setError(null)
  }, [])

  const retry = useCallback(() => {
    resetEngines()
    resetOnnx()
    setEngines(null)
    setOnnxReadyId(null)
    setPeopleReady(false)
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

  const modelId = objectModel?.id ?? null
  const modelRef = useRef(objectModel)
  useEffect(() => {
    modelRef.current = objectModel
  })

  useEffect(() => {
    const model = modelRef.current
    if (!enabled || !model) return
    let cancelled = false
    prepareOnnx(model)
      .then(() => {
        if (!cancelled) setOnnxReadyId(model.id)
      })
      .catch((caught) => {
        if (cancelled) return
        console.error(caught)
        setError(loadError(caught))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, modelId, attempt])

  useEffect(() => {
    if (!enabled || poseMode !== 'people') return
    let cancelled = false
    preparePeople()
      .then(() => {
        if (!cancelled) setPeopleReady(true)
      })
      .catch((caught) => {
        if (cancelled) return
        console.error(caught)
        setError(loadError(caught))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, poseMode, attempt])

  const status: AiStatus = !enabled
    ? 'off'
    : error
      ? 'error'
      : !engines || (objectModel && onnxReadyId !== objectModel.id) || (poseMode === 'people' && !peopleReady)
        ? 'loading'
        : 'ready'

  const value = useMemo(
    () => ({
      enabled,
      confidence,
      objectDetector,
      objectModel,
      poseMode,
      status,
      error,
      delegate,
      latest,
      engines,
      setEnabled,
      setConfidence,
      setObjectDetector,
      setPoseMode,
      retry,
      publish,
      readSnapshot,
    }),
    [
      enabled,
      confidence,
      objectDetector,
      objectModel,
      poseMode,
      status,
      error,
      delegate,
      latest,
      engines,
      setEnabled,
      setConfidence,
      setObjectDetector,
      setPoseMode,
      retry,
      publish,
      readSnapshot,
    ],
  )

  return <AiContext.Provider value={value}>{children}</AiContext.Provider>
}
