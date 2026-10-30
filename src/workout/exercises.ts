import type { Exercise, ExerciseKind } from '../../shared/contracts.ts'

type Seed = [id: string, name: string, kind: ExerciseKind, muscles: string[], equipment: string, cue: string]

const SEEDS: Seed[] = [
  ['back-squat', 'Back squat', 'strength', ['quads', 'glutes', 'core'], 'Barbell', 'Brace, sit between the hips, knees track the toes.'],
  ['front-squat', 'Front squat', 'strength', ['quads', 'core'], 'Barbell', 'Elbows high, chest up, sit straight down.'],
  ['deadlift', 'Deadlift', 'strength', ['hamstrings', 'glutes', 'back'], 'Barbell', 'Bar over midfoot, push the floor away, lock out with the hips.'],
  ['romanian-deadlift', 'Romanian deadlift', 'strength', ['hamstrings', 'glutes'], 'Barbell', 'Soft knees, hips back until the hamstrings stretch.'],
  ['bench-press', 'Bench press', 'strength', ['chest', 'triceps', 'shoulders'], 'Barbell', 'Shoulder blades back, touch the lower chest, press up and back.'],
  ['incline-dumbbell-press', 'Incline dumbbell press', 'strength', ['chest', 'shoulders'], 'Dumbbells', 'Thirty degree bench, elbows under the wrists.'],
  ['overhead-press', 'Overhead press', 'strength', ['shoulders', 'triceps', 'core'], 'Barbell', 'Squeeze the glutes, press straight up, head through at the top.'],
  ['barbell-row', 'Barbell row', 'strength', ['back', 'biceps'], 'Barbell', 'Hinge to about forty five degrees, pull to the lower ribs.'],
  ['lat-pulldown', 'Lat pulldown', 'strength', ['back', 'biceps'], 'Cable', 'Pull the elbows down to the ribs, chest up.'],
  ['seated-cable-row', 'Seated cable row', 'strength', ['back', 'biceps'], 'Cable', 'Tall chest, pull the handle to the stomach.'],
  ['dumbbell-lunge', 'Dumbbell lunge', 'strength', ['quads', 'glutes'], 'Dumbbells', 'Long step, back knee to just above the floor.'],
  ['bulgarian-split-squat', 'Bulgarian split squat', 'strength', ['quads', 'glutes'], 'Dumbbells', 'Back foot on a bench, front shin near vertical.'],
  ['hip-thrust', 'Hip thrust', 'strength', ['glutes', 'hamstrings'], 'Barbell', 'Upper back on the bench, chin tucked, squeeze at the top.'],
  ['leg-press', 'Leg press', 'strength', ['quads', 'glutes'], 'Machine', 'Lower until the hips stay down, do not lock the knees.'],
  ['calf-raise', 'Standing calf raise', 'strength', ['calves'], 'Machine', 'Full stretch at the bottom, pause at the top.'],
  ['dumbbell-curl', 'Dumbbell curl', 'strength', ['biceps'], 'Dumbbells', 'Elbows still at the sides.'],
  ['triceps-pushdown', 'Triceps pushdown', 'strength', ['triceps'], 'Cable', 'Elbows pinned, straighten fully.'],
  ['lateral-raise', 'Lateral raise', 'strength', ['shoulders'], 'Dumbbells', 'Lead with the elbows to shoulder height.'],
  ['face-pull', 'Face pull', 'strength', ['shoulders', 'back'], 'Cable', 'Pull to the eyes, thumbs back.'],
  ['kettlebell-swing', 'Kettlebell swing', 'strength', ['glutes', 'hamstrings', 'core'], 'Kettlebell', 'Snap the hips, the arms just guide the bell.'],
  ['medicine-ball-rotational-throw', 'Rotational medicine ball throw', 'strength', ['core', 'shoulders'], 'Medicine ball', 'Load the back hip, throw through the trunk like a forehand.'],
  ['pull-up', 'Pull-up', 'bodyweight', ['back', 'biceps'], 'Bar', 'Dead hang to chin over the bar.'],
  ['push-up', 'Push-up', 'bodyweight', ['chest', 'triceps', 'core'], 'None', 'Straight line from head to heels.'],
  ['dip', 'Dip', 'bodyweight', ['chest', 'triceps'], 'Parallel bars', 'Lean slightly forward, shoulders below the elbows.'],
  ['bodyweight-squat', 'Bodyweight squat', 'bodyweight', ['quads', 'glutes'], 'None', 'Arms forward, sit deep with a flat back.'],
  ['box-jump', 'Box jump', 'bodyweight', ['quads', 'glutes', 'calves'], 'Box', 'Land softly, step down.'],
  ['lateral-bound', 'Lateral bound', 'bodyweight', ['glutes', 'quads'], 'None', 'Push off sideways, stick the landing on one leg.'],
  ['hanging-leg-raise', 'Hanging leg raise', 'bodyweight', ['core'], 'Bar', 'No swing, curl the pelvis up.'],
  ['plank', 'Plank', 'timed', ['core'], 'None', 'Elbows under the shoulders, squeeze the glutes.'],
  ['side-plank', 'Side plank', 'timed', ['core'], 'None', 'Hips high, body in one line.'],
  ['wall-sit', 'Wall sit', 'timed', ['quads'], 'Wall', 'Thighs parallel to the floor.'],
  ['shadow-swings', 'Shadow swings', 'timed', ['shoulders', 'core'], 'Racket or bat', 'Full swings with footwork, no ball.'],
  ['run', 'Run', 'cardio', ['legs'], 'None', 'Easy pace you could talk at.'],
  ['rowing-machine', 'Rowing machine', 'cardio', ['back', 'legs'], 'Rower', 'Legs, then body, then arms.'],
  ['bike', 'Bike', 'cardio', ['legs'], 'Bike', 'Steady cadence.'],
  ['court-sprints', 'Court sprints', 'cardio', ['legs'], 'Court', 'Baseline to net and back, touch each line.'],
  ['shuttle-run', 'Shuttle run', 'cardio', ['legs'], 'Cones', 'Low turns, push off the outside foot.'],
  ['jump-rope', 'Jump rope', 'timed', ['calves'], 'Rope', 'Small hops on the balls of the feet.'],
]

export const BUILT_IN_EXERCISES: Exercise[] = SEEDS.map(([id, name, kind, muscles, equipment, cue]) => ({
  id,
  name,
  kind,
  muscles,
  equipment,
  cue,
  builtIn: true,
}))

export const KIND_LABELS: Record<ExerciseKind, string> = {
  strength: 'Weights',
  bodyweight: 'Bodyweight',
  cardio: 'Cardio',
  timed: 'Timed',
}

// Rest before the next set, in seconds, by kind of exercise.
export const REST_SECONDS: Record<ExerciseKind, number> = { strength: 120, bodyweight: 90, cardio: 60, timed: 45 }

export function allExercises(custom: Exercise[]) {
  return [...BUILT_IN_EXERCISES, ...custom].sort((a, b) => a.name.localeCompare(b.name))
}

export function exerciseById(custom: Exercise[], id: string) {
  return BUILT_IN_EXERCISES.find((exercise) => exercise.id === id) ?? custom.find((exercise) => exercise.id === id) ?? null
}
