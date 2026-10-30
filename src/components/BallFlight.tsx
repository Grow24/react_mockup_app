import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { COURT_PRESETS, type BallTrack, type CourtCalibration, type CourtPreset } from '../../shared/contracts.ts'
import { flightBounces, peakHeight, positionAt, velocityAt, type Flight, type FlightFit, type Vec3 } from '../vision/flight'
import { fitFlightsInWorker } from '../vision/flightFit'
import { predictFlight, type Prediction } from '../vision/physics'

const PREDICT_SECONDS = 2
const PAUSE_SECONDS = 0.6

function describeSpot(preset: CourtPreset, p: Vec3) {
  const { widthMeters, lengthMeters } = COURT_PRESETS[preset]
  const outside = p.x < -0.5 || p.y < -0.5 || p.x > widthMeters + 0.5 || p.y > lengthMeters + 0.5
  return `${p.x.toFixed(1)} m from the left line, ${p.y.toFixed(1)} m from the near line${outside ? ' (outside the court)' : ''}`
}

function predictionText(preset: CourtPreset, prediction: Prediction) {
  const firstBounce = prediction.bounces[0]
  if (prediction.obstacle && (!firstBounce || prediction.obstacle.t <= firstBounce.t)) {
    return `Rapier: the ball hits the ${prediction.obstacle.name} at ${prediction.obstacle.t.toFixed(1)} s.`
  }
  if (!firstBounce) return `Rapier: no bounce in the next ${PREDICT_SECONDS} s.`
  return `Rapier: next bounce at ${firstBounce.t.toFixed(1)} s, ${describeSpot(preset, firstBounce.p)}.`
}

function FlightView({
  preset,
  flights,
  prediction,
  cameraAt,
}: {
  preset: CourtPreset
  flights: Flight[]
  prediction: Prediction | null
  cameraAt: Vec3
}) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || flights.length === 0) return
    const { widthMeters: width, lengthMeters: length } = COURT_PRESETS[preset]
    const place = (p: Vec3) => new THREE.Vector3(p.x - width / 2, p.z, length / 2 - p.y)
    const disposables: { dispose: () => void }[] = []
    const keep = <T extends { dispose: () => void }>(item: T) => {
      disposables.push(item)
      return item
    }

    const scene = new THREE.Scene()
    const view = new THREE.PerspectiveCamera(40, 1, 0.1, 400)
    view.position.set(width * 1.1, Math.max(9, length * 0.45), length * 0.95)
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setClearColor(0x161310)
    host.appendChild(renderer.domElement)
    const controls = new OrbitControls(view, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0.5, 0)
    controls.maxDistance = 90
    controls.minDistance = 3

    const surround = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(width + 16, length + 16)),
      keep(new THREE.MeshBasicMaterial({ color: 0x3a3f46 })),
    )
    surround.rotation.x = -Math.PI / 2
    surround.position.y = -0.01
    scene.add(surround)
    const court = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(width, length)),
      keep(new THREE.MeshBasicMaterial({ color: 0x2e6b4a })),
    )
    court.rotation.x = -Math.PI / 2
    scene.add(court)
    const lineMaterial = keep(new THREE.LineBasicMaterial({ color: 0xf6f1ea }))
    const corners = [
      { x: 0, y: 0, z: 0.005 },
      { x: width, y: 0, z: 0.005 },
      { x: width, y: length, z: 0.005 },
      { x: 0, y: length, z: 0.005 },
    ].map(place)
    scene.add(new THREE.LineLoop(keep(new THREE.BufferGeometry().setFromPoints(corners)), lineMaterial))
    scene.add(
      new THREE.Line(
        keep(
          new THREE.BufferGeometry().setFromPoints([
            place({ x: 0, y: length / 2, z: 0.005 }),
            place({ x: width, y: length / 2, z: 0.005 }),
          ]),
        ),
        lineMaterial,
      ),
    )
    if (preset === 'tennis-doubles') {
      const net = new THREE.Mesh(
        keep(new THREE.PlaneGeometry(width + 1.83, 0.914)),
        keep(new THREE.MeshBasicMaterial({ color: 0xf6f1ea, transparent: true, opacity: 0.35, side: THREE.DoubleSide })),
      )
      net.position.copy(place({ x: width / 2, y: length / 2, z: 0.457 }))
      scene.add(net)
    } else {
      const stumpGeometry = keep(new THREE.BoxGeometry(0.23, 0.71, 0.04))
      const stumpMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xe8d9b8 }))
      for (const y of [0, length]) {
        const stumps = new THREE.Mesh(stumpGeometry, stumpMaterial)
        stumps.position.copy(place({ x: width / 2, y, z: 0.356 }))
        scene.add(stumps)
      }
    }

    const cameraMarker = new THREE.Mesh(
      keep(new THREE.SphereGeometry(0.25, 16, 16)),
      keep(new THREE.MeshBasicMaterial({ color: 0xf7fffe })),
    )
    cameraMarker.position.copy(place(cameraAt))
    scene.add(cameraMarker)
    scene.add(
      new THREE.Line(
        keep(new THREE.BufferGeometry().setFromPoints([place(cameraAt), place({ x: width / 2, y: length / 2, z: 0 })])),
        keep(new THREE.LineDashedMaterial({ color: 0x8a8178, dashSize: 0.5, gapSize: 0.4 })),
      ).computeLineDistances(),
    )

    const pathMaterial = keep(new THREE.LineBasicMaterial({ color: 0xf3d38a }))
    const bounceGeometry = keep(new THREE.SphereGeometry(0.14, 16, 16))
    const seenBounce = keep(new THREE.MeshBasicMaterial({ color: 0xf3d38a }))
    for (const flight of flights) {
      const samples: THREE.Vector3[] = []
      for (let t = flight.from; t < flight.to; t += 1 / 60) samples.push(place(positionAt(flight, t)))
      samples.push(place(positionAt(flight, flight.to)))
      scene.add(new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(samples)), pathMaterial))
      if (flight.endBounce != null) {
        const dot = new THREE.Mesh(bounceGeometry, seenBounce)
        dot.position.copy(place(positionAt(flight, flight.endBounce)))
        scene.add(dot)
      }
    }
    if (prediction) {
      scene.add(
        new THREE.Line(
          keep(new THREE.BufferGeometry().setFromPoints(prediction.path.map((sample) => place(sample.p)))),
          keep(new THREE.LineDashedMaterial({ color: 0x7fd8cf, dashSize: 0.3, gapSize: 0.2 })),
        ).computeLineDistances(),
      )
      const predicted = keep(new THREE.MeshBasicMaterial({ color: 0x7fd8cf }))
      for (const bounce of prediction.bounces) {
        const dot = new THREE.Mesh(bounceGeometry, predicted)
        dot.position.copy(place(bounce.p))
        scene.add(dot)
      }
    }

    const ball = new THREE.Mesh(
      keep(new THREE.SphereGeometry(0.12, 16, 16)),
      keep(new THREE.MeshBasicMaterial({ color: 0xd8ec4a })),
    )
    scene.add(ball)
    const start = flights[0]!.from
    const seenEnd = flights[flights.length - 1]!.to
    const end = prediction?.path[prediction.path.length - 1]?.t ?? seenEnd
    const ballAt = (t: number) => {
      const flight = flights.find((item) => t >= item.from && t <= item.to)
      if (flight) return positionAt(flight, t)
      if (prediction && t > seenEnd) {
        const next = prediction.path.find((sample) => sample.t >= t)
        if (next) return next.p
      }
      return null
    }

    const resize = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (w < 2 || h < 2) return
      view.aspect = w / h
      view.updateProjectionMatrix()
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(w, h, false)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    const clock = new THREE.Clock()
    let frame = 0
    const loop = () => {
      frame = requestAnimationFrame(loop)
      const span = end - start + PAUSE_SECONDS
      const t = start + (clock.getElapsedTime() % span)
      const at = ballAt(t)
      ball.visible = at !== null
      if (at) ball.position.copy(place(at))
      controls.update()
      renderer.render(scene, view)
    }
    loop()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      for (const item of disposables) item.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [preset, flights, prediction, cameraAt])

  return (
    <div
      ref={hostRef}
      className="skeleton-view flight-view"
      tabIndex={0}
      role="img"
      aria-label="3D ball flight. Drag to rotate."
    />
  )
}

export function BallFlight({ track, court }: { track: BallTrack; court: CourtCalibration }) {
  const [fitted, setFitted] = useState<{ track: BallTrack; court: CourtCalibration; fit: FlightFit | null } | null>(
    null,
  )
  const fit = fitted && fitted.track === track && fitted.court === court ? fitted.fit : undefined
  const flights = useMemo(() => fit?.flights.filter((flight) => flight.reliable) ?? [], [fit])
  const last = flights[flights.length - 1]
  const [predicted, setPredicted] = useState<{ from: Flight; prediction: Prediction } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    fitFlightsInWorker(track, court)
      .then((next) => {
        if (current) setFitted({ track, court, fit: next })
      })
      .catch((caught) => {
        if (!current) return
        console.error(caught)
        setError(caught instanceof Error ? caught.message : 'The 3D flight could not be fitted.')
      })
    return () => {
      current = false
    }
  }, [track, court])

  useEffect(() => {
    if (!last) return
    let current = true
    predictFlight(court.preset, { t: last.to, p: positionAt(last, last.to), v: velocityAt(last, last.to) }, PREDICT_SECONDS)
      .then((prediction) => {
        if (!current) return
        setPredicted({ from: last, prediction })
        setError(null)
      })
      .catch((caught) => {
        if (!current) return
        console.error(caught)
        setError(caught instanceof Error ? caught.message : 'Rapier could not run.')
      })
    return () => {
      current = false
    }
  }, [court.preset, last])

  if (fit === undefined) {
    return error ? (
      <p className="warn" role="alert">
        {error}
      </p>
    ) : (
      <p className="muted">Fitting the 3D flight.</p>
    )
  }

  if (!fit) {
    return (
      <p className="muted">
        The camera could not be placed from these corners. Check that they were clicked in order: Near left,
        Near right, Far right, Far left.
      </p>
    )
  }

  const prediction = predicted && predicted.from === last ? predicted.prediction : null
  const position = fit.camera.position
  return (
    <div className="still-pose">
      <h4>3D flight</h4>
      <p className="muted">
        Camera placed {position.z.toFixed(1)} m high, {Math.abs(position.y).toFixed(1)} m{' '}
        {position.y < 0 ? 'behind' : 'past'} the near line
        {fit.camera.focalEstimated ? '' : ' (focal length guessed, so heights are rough)'}. Each flight
        between bounces or hits is fitted to gravity, which gives the height one camera cannot see.
      </p>
      <ul className="label-list">
        {fit.flights.map((flight, index) => {
          const v = velocityAt(flight, flight.from)
          return (
            <li key={flight.t0}>
              Flight {index + 1} · {flight.from.toFixed(2)}–{flight.to.toFixed(2)} s · peak{' '}
              {peakHeight(flight).toFixed(1)} m · {(Math.hypot(v.x, v.y, v.z) * 3.6).toFixed(0)} km/h · fit{' '}
              {flight.rmsPx.toFixed(1)} px{flight.reliable ? '' : ' (poor fit, not drawn)'}
            </li>
          )
        })}
        {fit.skipped > 0 ? (
          <li>
            {fit.skipped === 1 ? '1 stretch' : `${fit.skipped} stretches`} did not look like a flight (held,
            rolling, or misdetected) and {fit.skipped === 1 ? 'was' : 'were'} left out
          </li>
        ) : null}
        {flightBounces(flights).map((bounce, index) => (
          <li key={bounce.t}>
            3D bounce {index + 1} at {bounce.t.toFixed(2)} s: {describeSpot(court.preset, bounce.p)}
          </li>
        ))}
      </ul>
      {flights.length > 0 ? (
        <>
          <FlightView preset={court.preset} flights={flights} prediction={prediction} cameraAt={position} />
          {prediction ? <p className="note">{predictionText(court.preset, prediction)}</p> : null}
          {!prediction && !error ? <p className="muted">Loading Rapier physics.</p> : null}
          <p className="muted">
            Gold is the tracked flight, teal is the Rapier prediction after the video ends, and the white dot
            is the camera. No spin or air drag is modeled.
          </p>
        </>
      ) : (
        <p className="muted">No flight fitted well enough to draw in 3D.</p>
      )}
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
