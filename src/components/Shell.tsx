import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useSession } from '../session/context'

const TABS = [
  { to: '/', label: 'Camera', end: true },
  { to: '/ai', label: 'AI', end: false },
  { to: '/results', label: 'Results', end: false },
  { to: '/workouts', label: 'Workouts', end: false },
  { to: '/training', label: 'Training', end: false },
]

function SessionLine() {
  const { sessionId, backend } = useSession()
  if (!sessionId) return null
  const href = `${window.location.origin}/?session=${sessionId}`
  return (
    <p className="session-line">
      {backend === 'online' ? 'On the server' : 'This browser only'}
      <a href={href}>{sessionId}</a>
    </p>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const { assets } = useSession()

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">PBMP Camera</p>
          <h1>Camera module</h1>
          <SessionLine />
        </div>
        <nav className="tabs" aria-label="Screens">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) => (isActive ? 'tab active' : 'tab')}
            >
              {tab.label}
              {tab.to === '/results' && assets.length > 0 ? (
                <span className="count">{assets.length}</span>
              ) : null}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="main">{children}</main>
    </div>
  )
}
