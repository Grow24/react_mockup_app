import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatWhen } from '../format'
import { useSession } from '../session/context'

export function Results() {
  const { assets, removeAsset } = useSession()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = assets.find((asset) => asset.id === selectedId) ?? assets[0]

  return (
    <section className="screen">
      <div className="screen-intro">
        <h2>Results</h2>
        <p>
          Saved photos and videos from this visit. Refreshing the page clears them. The Three.js
          skeleton arrives when pose landmarks exist.
        </p>
      </div>

      {assets.length === 0 || !selected ? (
        <article className="card empty-card">
          <h3>Nothing captured yet</h3>
          <p className="muted">Take a photo or record a short video on the camera screen.</p>
          <Link className="primary link-button" to="/">
            Open camera
          </Link>
        </article>
      ) : (
        <div className="layout">
          <article className="card playback">
            <header className="card-head">
              <h3>{selected.kind === 'photo' ? 'Photo' : 'Video'}</h3>
              <button type="button" className="text-button" onClick={() => removeAsset(selected.id)}>
                Remove
              </button>
            </header>
            <figure>
              {selected.kind === 'photo' ? (
                <img src={selected.url} alt={`Photo from ${selected.cameraLabel}`} />
              ) : (
                <video key={selected.id} src={selected.url} controls playsInline />
              )}
              <figcaption>
                {selected.cameraLabel} · {formatWhen(selected.createdAt)}
                {selected.width && selected.height ? ` · ${selected.width}×${selected.height}` : ''}
              </figcaption>
            </figure>
            <p className="muted">3D pose view is not connected yet. This player shows the real capture.</p>
          </article>

          <aside className="side">
            <article className="card">
              <header className="card-head">
                <h3>This session</h3>
                <span className="pill">{assets.length}</span>
              </header>
              <ul className="asset-list">
                {assets.map((asset) => (
                  <li key={asset.id}>
                    <button
                      type="button"
                      className={asset.id === selected.id ? 'asset active' : 'asset'}
                      onClick={() => setSelectedId(asset.id)}
                    >
                      <span>{asset.kind === 'photo' ? 'Photo' : 'Video'}</span>
                      <small>
                        {formatWhen(asset.createdAt)} · {asset.cameraLabel}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            </article>
          </aside>
        </div>
      )}
    </section>
  )
}
