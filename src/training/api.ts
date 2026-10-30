import type { TrainingBox, TrainingImage, TrainingSet, TrainingSplit } from '../../shared/contracts.ts'

async function errorText(response: Response) {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error || response.statusText
  } catch {
    return response.statusText
  }
}

async function json<T>(request: Promise<Response>) {
  const response = await request
  if (!response.ok) throw new Error(await errorText(response))
  return (await response.json()) as T
}

export function fetchTraining(sessionId: string) {
  return json<TrainingSet>(fetch(`/api/sessions/${sessionId}/training`, { cache: 'no-store' }))
}

export function saveClasses(sessionId: string, classes: string[]) {
  return json<TrainingSet>(
    fetch(`/api/sessions/${sessionId}/training/classes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classes }),
    }),
  )
}

export type NewTrainingImage = {
  id: string
  blob: Blob
  width: number
  height: number
  split: TrainingSplit
  boxes?: TrainingBox[]
  sourceAssetId?: string
  frameTime?: number
}

export function uploadTrainingImage(sessionId: string, image: NewTrainingImage) {
  const { blob, ...meta } = image
  const form = new FormData()
  form.set('file', blob, 'frame.jpg')
  form.set('meta', JSON.stringify({ boxes: [], ...meta }))
  return json<TrainingImage>(fetch(`/api/sessions/${sessionId}/training/images`, { method: 'POST', body: form }))
}

export function saveTrainingImage(id: string, boxes: TrainingBox[], split: TrainingSplit) {
  return json<TrainingImage>(
    fetch(`/api/training-images/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes, split }),
    }),
  )
}

export async function deleteTrainingImage(id: string) {
  await json<{ ok: true }>(fetch(`/api/training-images/${id}`, { method: 'DELETE' }))
}

export function exportUrl(sessionId: string, labeledOnly: boolean) {
  return `/api/sessions/${sessionId}/training/export${labeledOnly ? '?labeled=1' : ''}`
}

export type RoboflowResult = { uploaded: number; annotated: number; failed: { name: string; error: string }[] }

export function uploadToRoboflow(sessionId: string, apiKey: string, project: string) {
  return json<RoboflowResult>(
    fetch(`/api/sessions/${sessionId}/training/roboflow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, project }),
    }),
  )
}

// About one image in five goes to validation, fixed by its id so it never moves between exports.
export function splitFor(id: string): TrainingSplit {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 5 === 0 ? 'val' : 'train'
}
