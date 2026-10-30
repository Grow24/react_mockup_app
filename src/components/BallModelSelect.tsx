import type { DetectorModel } from '../vision/models'

export function BallModelSelect({
  model,
  choices,
  onChange,
  disabled,
}: {
  model: DetectorModel
  choices: DetectorModel[]
  onChange: (id: string) => void
  disabled?: boolean
}) {
  return (
    <label className="field">
      <span>Ball model</span>
      <select value={model.id} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.name}
            {choice.ballClasses.length === 0
              ? ' (no ball class picked)'
              : choice.builtIn
                ? ''
                : ` · ${choice.ballClasses.map((index) => choice.labels[index]).join(', ')}`}
          </option>
        ))}
      </select>
    </label>
  )
}
