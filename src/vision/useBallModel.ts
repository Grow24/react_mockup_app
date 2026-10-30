import { useState } from 'react'
import { useSession } from '../session/context'
import { COCO_MODEL, findModel, modelChoices } from './models'

const BALL_MODEL_KEY = 'pbmp-ball-model'

function readChoice() {
  try {
    return localStorage.getItem(BALL_MODEL_KEY) || COCO_MODEL.id
  } catch {
    return COCO_MODEL.id
  }
}

// The model ball tracking uses on this phone: the built-in COCO model or one of the session's own.
export function useBallModel() {
  const { models } = useSession()
  const [chosen, setChosen] = useState(readChoice)
  const model = findModel(models, chosen) ?? COCO_MODEL
  const choose = (id: string) => {
    try {
      localStorage.setItem(BALL_MODEL_KEY, id)
    } catch {
      // The choice still applies for this visit.
    }
    setChosen(id)
  }
  return { model, choices: modelChoices(models), choose }
}
