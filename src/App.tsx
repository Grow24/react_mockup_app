import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'

// Each screen is its own chunk; Three.js, OpenCV glue, and the labeler load only where they are used.
const CameraExplorer = lazy(() => import('./pages/CameraExplorer').then((module) => ({ default: module.CameraExplorer })))
const AiProcessing = lazy(() => import('./pages/AiProcessing').then((module) => ({ default: module.AiProcessing })))
const Results = lazy(() => import('./pages/Results').then((module) => ({ default: module.Results })))
const Workouts = lazy(() => import('./pages/Workouts').then((module) => ({ default: module.Workouts })))
const Training = lazy(() => import('./pages/Training').then((module) => ({ default: module.Training })))

export default function App() {
  return (
    <Shell>
      <Suspense fallback={<p className="muted">Opening…</p>}>
        <Routes>
        <Route path="/" element={<CameraExplorer />} />
        <Route path="/ai" element={<AiProcessing />} />
        <Route path="/results" element={<Results />} />
        <Route path="/workouts/*" element={<Workouts />} />
        <Route path="/training" element={<Training />} />
        <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  )
}
