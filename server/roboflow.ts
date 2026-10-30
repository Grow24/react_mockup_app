// Uploads labeled frames to a Roboflow project: the image first, then its boxes as Pascal VOC XML,
// which carries class names so Roboflow needs no separate label map.
const API = process.env.ROBOFLOW_API_URL || 'https://api.roboflow.com'
const PARALLEL = 3

export type RoboflowImage = { name: string; bytes: Buffer; split: 'train' | 'valid'; xml: string }
export type RoboflowResult = { uploaded: number; annotated: number; failed: { name: string; error: string }[] }

async function reply(response: Response) {
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Roboflow answers JSON; anything else is reported as the status line.
  }
  if (!response.ok || body.error) {
    const error = body.error
    const message =
      typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : `${response.status} ${response.statusText}`
    throw new Error(message)
  }
  return body
}

async function uploadOne(apiKey: string, project: string, image: RoboflowImage) {
  const query = new URLSearchParams({ api_key: apiKey, name: image.name, split: image.split })
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(image.bytes)], { type: 'image/jpeg' }), image.name)
  const uploaded = await reply(await fetch(`${API}/dataset/${project}/upload?${query}`, { method: 'POST', body: form }))
  const id = typeof uploaded.id === 'string' ? uploaded.id : null
  if (!id) throw new Error('Roboflow did not return an image id.')
  const annotation = new URLSearchParams({ api_key: apiKey, name: image.name.replace(/\.jpg$/i, '.xml') })
  await reply(
    await fetch(`${API}/dataset/${project}/annotate/${id}?${annotation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: image.xml,
    }),
  )
}

export async function uploadToRoboflow(apiKey: string, project: string, images: RoboflowImage[]): Promise<RoboflowResult> {
  const result: RoboflowResult = { uploaded: 0, annotated: 0, failed: [] }
  let next = 0
  const worker = async () => {
    while (next < images.length) {
      const image = images[next++]!
      try {
        await uploadOne(apiKey, project, image)
        result.uploaded += 1
        result.annotated += 1
      } catch (error) {
        result.failed.push({ name: image.name, error: error instanceof Error ? error.message : 'Upload failed' })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, images.length) }, worker))
  return result
}
