import { NavLink } from 'react-router-dom'
import { useState, type ReactNode } from 'react'
import { shareLink } from '../session/api'
import { useSession } from '../session/context'

const TABS = [
  { to: '/', label: 'Camera', end: true },
  { to: '/ai', label: 'AI', end: false },
  { to: '/results', label: 'Results', end: false },
  { to: '/workouts', label: 'Workouts', end: false },
  { to: '/training', label: 'Training', end: false },
]

function SessionLine() {
  const { sessionId, backend, locked, makePrivate } = useSession()
  const [note, setNote] = useState<string | null>(null)
  if (!sessionId) return null
  const href = shareLink(sessionId, locked)
  if (backend !== 'online') {
    return (
      <p className="session-line">
        This browser only <a href={href}>{sessionId}</a>
      </p>
    )
  }
  return (
    <div className="session-line">
      {locked ? (
        <>
          <span className="pill">Private</span> Anyone with this link can open the session:{' '}
          <a href={href}>{sessionId}</a>{' '}
          <button
            type="button"
            className="text-button session-copy"
            onClick={() =>
              void navigator.clipboard
                .writeText(href)
                .then(() => setNote('Link copied. Share it only with your own phones and team.'))
                .catch(() => setNote('Copy the link from the address of this session.'))
            }
          >
            Copy link
          </button>
        </>
      ) : (
        <>
          Open session: anyone with <a href={href}>{sessionId}</a> can see and change it.{' '}
          <button
            type="button"
            className="text-button session-copy"
            onClick={() =>
              void makePrivate()
                .then(() => setNote('Private now. Share the new link; the old one no longer opens it on other browsers.'))
                .catch((error: unknown) => setNote(error instanceof Error ? error.message : 'It could not be made private.'))
            }
          >
            Make private
          </button>
        </>
      )}
      {note ? <span className="session-note"> {note}</span> : null}
    </div>
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
