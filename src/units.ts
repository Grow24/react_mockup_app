import { useSyncExternalStore } from 'react'

export type Units = 'm' | 'ft'

const UNITS_KEY = 'pbmp-units'
const FEET_PER_METER = 3.28084
const listeners = new Set<() => void>()

function read(): Units {
  try {
    return localStorage.getItem(UNITS_KEY) === 'ft' ? 'ft' : 'm'
  } catch {
    return 'm'
  }
}

let current: Units = typeof window === 'undefined' ? 'm' : read()

export function setUnits(next: Units) {
  current = next
  try {
    localStorage.setItem(UNITS_KEY, next)
  } catch {
    // The choice still applies for this visit.
  }
  for (const listener of listeners) listener()
}

export function useUnits() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => 'm' as Units,
  )
}

export function length(meters: number, units: Units, digits = 1) {
  return units === 'ft' ? `${(meters * FEET_PER_METER).toFixed(digits)} ft` : `${meters.toFixed(digits)} m`
}

export function speed(metersPerSecond: number, units: Units) {
  return units === 'ft' ? `${(metersPerSecond * 2.23694).toFixed(0)} mph` : `${(metersPerSecond * 3.6).toFixed(0)} km/h`
}

// Court coordinates as one line: x along the near baseline from the left doubles sideline, y toward
// the far baseline, z up from the ground.
export function xyz(p: { x: number; y: number; z?: number }, units: Units) {
  const value = (meters: number) => (units === 'ft' ? (meters * FEET_PER_METER).toFixed(1) : meters.toFixed(2))
  const parts = [`x ${value(p.x)}`, `y ${value(p.y)}`]
  if (p.z != null) parts.push(`z ${value(p.z)}`)
  return `${parts.join(' · ')} ${units}`
}

export function toMeters(value: number, units: Units) {
  return units === 'ft' ? value / FEET_PER_METER : value
}
