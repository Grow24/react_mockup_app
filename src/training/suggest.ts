import type { Detection, TrainingBox } from '../../shared/contracts.ts'

const ALIASES: [RegExp, RegExp][] = [
  [/ball/i, /ball/i],
  [/player|person|athlete|people/i, /^person$/i],
  [/racket|racquet/i, /racket/i],
  [/bat/i, /bat\b/i],
]

// Which of the training classes a model label belongs to, by name or by a close sports alias.
export function classForLabel(label: string, classes: string[]) {
  const exact = classes.findIndex((name) => name.toLowerCase() === label.toLowerCase())
  if (exact >= 0) return exact
  for (const [classPattern, labelPattern] of ALIASES) {
    if (!labelPattern.test(label)) continue
    const index = classes.findIndex((name) => classPattern.test(name))
    if (index >= 0) return index
  }
  return -1
}

export function suggestBoxes(detections: Detection[], classes: string[], minScore = 0.3): TrainingBox[] {
  return detections.flatMap((detection) => {
    const classId = classForLabel(detection.label, classes)
    if (classId < 0 || detection.score < minScore) return []
    return [{ classId, ...detection.box }]
  })
}
