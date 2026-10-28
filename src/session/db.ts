import type { AiSnapshot, MediaKind } from '../types'

const DB_NAME = 'pbmp-camera'
const STORE = 'assets'

export type StoredAsset = {
  id: string
  kind: MediaKind
  mimeType: string
  createdAt: number
  cameraLabel: string
  width?: number
  height?: number
  snapshot?: AiSnapshot
  blob: Blob
}

let opening: Promise<IDBDatabase> | null = null

function openDb() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        opening = null
        reject(request.error ?? new Error('Could not open saved media.'))
      }
    })
  }
  return opening
}

function resultOf<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Saved media request failed.'))
  })
}

export async function loadStored() {
  const database = await openDb()
  const transaction = database.transaction(STORE, 'readonly')
  return resultOf(transaction.objectStore(STORE).getAll() as IDBRequest<StoredAsset[]>)
}

export async function saveStored(asset: StoredAsset) {
  const database = await openDb()
  const transaction = database.transaction(STORE, 'readwrite')
  await resultOf(transaction.objectStore(STORE).put(asset))
}

export async function deleteStored(id: string) {
  const database = await openDb()
  const transaction = database.transaction(STORE, 'readwrite')
  await resultOf(transaction.objectStore(STORE).delete(id))
}
