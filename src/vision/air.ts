import type { CourtPreset } from '../../shared/contracts.ts'
import { NO_AIR, STILL_AIR, type Air } from './physics.ts'

const AIR_KEY = 'pbmp-air'

export const AIR_CHOICES: { id: string; label: string; air: Air; tennisOnly?: boolean }[] = [
  { id: 'drag', label: 'Air drag, no spin', air: STILL_AIR },
  { id: 'topspin', label: 'Air drag and topspin', air: { drag: true, spin: 'topspin' }, tennisOnly: true },
  { id: 'slice', label: 'Air drag and slice', air: { drag: true, spin: 'slice' }, tennisOnly: true },
  { id: 'none', label: 'No air (gravity only)', air: NO_AIR },
]

export function airChoices(preset: CourtPreset) {
  return AIR_CHOICES.filter((choice) => preset === 'tennis-doubles' || !choice.tennisOnly)
}

export function readAirChoice(preset: CourtPreset) {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(AIR_KEY)
  } catch {
    // Private mode: the default applies.
  }
  return (airChoices(preset).find((choice) => choice.id === stored) ?? airChoices(preset)[0]!).id
}

export function saveAirChoice(id: string) {
  try {
    localStorage.setItem(AIR_KEY, id)
  } catch {
    // The choice still applies for this visit.
  }
}

export function airFor(preset: CourtPreset, id: string): Air {
  return (airChoices(preset).find((choice) => choice.id === id) ?? airChoices(preset)[0]!).air
}
