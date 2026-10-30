import type { CourtPreset } from '../../shared/contracts.ts'
import { airChoices, saveAirChoice } from '../vision/air'

export function AirSelect({ preset, value, onChange }: { preset: CourtPreset; value: string; onChange: (id: string) => void }) {
  return (
    <label className="field">
      <span>Prediction physics</span>
      <select
        value={value}
        onChange={(event) => {
          saveAirChoice(event.target.value)
          onChange(event.target.value)
        }}
      >
        {airChoices(preset).map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  )
}
