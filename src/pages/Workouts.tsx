import { NavLink, Route, Routes } from 'react-router-dom'
import { ExerciseLibrary } from '../components/workout/ExerciseLibrary'
import { OneRepMaxView } from '../components/workout/OneRepMaxView'
import { RestTimerBar } from '../components/workout/RestTimerBar'
import { WorkoutHistory } from '../components/workout/WorkoutHistory'
import { WorkoutLog } from '../components/workout/WorkoutLog'
import { WorkoutTimers } from '../components/workout/WorkoutTimers'
import { useSession } from '../session/context'
import { useWorkouts } from '../workout/context'

const SECTIONS = [
  { to: '/workouts', label: 'Log', end: true },
  { to: '/workouts/history', label: 'History', end: false },
  { to: '/workouts/exercises', label: 'Exercises', end: false },
  { to: '/workouts/timers', label: 'Timers', end: false },
  { to: '/workouts/max', label: '1RM', end: false },
]

export function Workouts() {
  const { backend } = useSession()
  const { pending } = useWorkouts()
  return (
    <section className="screen">
      <div className="screen-intro">
        <h2>Workouts</h2>
        <p>
          Log sets, reps, and weight, rest between sets, run interval drills, and watch your estimated max
          climb. Workouts are kept on this phone and in the shared session
          {backend === 'online'
            ? pending > 0
              ? `; ${pending} ${pending === 1 ? 'change is' : 'changes are'} still on the way to the server.`
              : '.'
            : '; the server is offline, so they are saved here until it is back.'}
        </p>
      </div>
      <nav className="tabs sub-tabs" aria-label="Workout sections">
        {SECTIONS.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            end={section.end}
            className={({ isActive }) => (isActive ? 'tab active' : 'tab')}
          >
            {section.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<WorkoutLog />} />
        <Route path="history" element={<WorkoutHistory />} />
        <Route path="exercises" element={<ExerciseLibrary />} />
        <Route path="timers" element={<WorkoutTimers />} />
        <Route path="max" element={<OneRepMaxView />} />
      </Routes>
      <RestTimerBar />
    </section>
  )
}
