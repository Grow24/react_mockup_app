import { Navigate, Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { AiProcessing } from './pages/AiProcessing'
import { CameraExplorer } from './pages/CameraExplorer'
import { Results } from './pages/Results'

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<CameraExplorer />} />
        <Route path="/ai" element={<AiProcessing />} />
        <Route path="/results" element={<Results />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  )
}
