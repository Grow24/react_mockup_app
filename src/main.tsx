import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import { SessionProvider } from './session/SessionContext.tsx'
import { AiProvider } from './vision/AiContext.tsx'
import { WorkoutProvider } from './workout/WorkoutContext.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <AiProvider>
          <WorkoutProvider>
            <App />
          </WorkoutProvider>
        </AiProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
