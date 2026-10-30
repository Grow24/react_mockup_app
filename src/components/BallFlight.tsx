import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { COURT_PRESETS, type BallTrack, type CourtCalibration, type CourtPreset } from '../../shared/contracts.ts'
import { courtArea, courtLines } from '../../shared/court.ts'
import { flightBounces, peakHeight, positionAt, velocityAt, type Flight, type FlightFit, type Vec3 } from '../vision/flight'
import { fitFlightsInWorker } from '../vision/flightFit'
import { flightPaths, PREDICT_SECONDS, predictionText, describeSpot, type PathSample } from '../vision/flightText'
import { airFor, readAirChoice } from '../vision/air'
import { airText, predictFlight, type Air, type Prediction } from '../vision/physics'
import { AirSelect } from './AirSelect'

const PAUSE_SECONDS = 0.6

export function FlightView({
  preset,
  callArea,
  paths,
  bounces,
  prediction,
  cameras,
}: {
  preset: CourtPreset
  callArea?: string
  paths: PathSample[][]
  bounces: Vec3[]
  prediction: Prediction | null
  cameras: Vec3[]
}) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const drawn = paths.filter((path) => path.length > 1)
    if (!host || drawn.length === 0) return
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
    const area = courtArea(preset, callArea)
    const shaded = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(area.x1 - area.x0, area.y1 - area.y0)),
      keep(new THREE.MeshBasicMaterial({ color: 0x3f8f7c })),
    )
    shaded.rotation.x = -Math.PI / 2
    shaded.position.copy(place({ x: (area.x0 + area.x1) / 2, y: (area.y0 + area.y1) / 2, z: 0.002 }))
    scene.add(shaded)
    const lineMaterial = keep(new THREE.LineBasicMaterial({ color: 0xf6f1ea }))
    const dashedMaterial = keep(new THREE.LineDashedMaterial({ color: 0xf6f1ea, dashSize: 0.3, gapSize: 0.25 }))
    for (const line of courtLines(preset)) {
      const drawn = new THREE.Line(
        keep(
          new THREE.BufferGeometry().setFromPoints([
            place({ ...line.from, z: 0.005 }),
            place({ ...line.to, z: 0.005 }),
          ]),
        ),
        line.dashed ? dashedMaterial : lineMaterial,
      )
      if (line.dashed) drawn.computeLineDistances()
      scene.add(drawn)
    }
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

    const markerGeometry = keep(new THREE.SphereGeometry(0.25, 16, 16))
    const markerMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xf7fffe }))
    const sightMaterial = keep(new THREE.LineDashedMaterial({ color: 0x8a8178, dashSize: 0.5, gapSize: 0.4 }))
    for (const cameraAt of cameras) {
      const marker = new THREE.Mesh(markerGeometry, markerMaterial)
      marker.position.copy(place(cameraAt))
      scene.add(marker)
      scene.add(
        new THREE.Line(
          keep(new THREE.BufferGeometry().setFromPoints([place(cameraAt), place({ x: width / 2, y: length / 2, z: 0 })])),
          sightMaterial,
        ).computeLineDistances(),
      )
    }

    const pathMaterial = keep(new THREE.LineBasicMaterial({ color: 0xf3d38a }))
    const bounceGeometry = keep(new THREE.SphereGeometry(0.14, 16, 16))
    const seenBounce = keep(new THREE.MeshBasicMaterial({ color: 0xf3d38a }))
    for (const path of drawn) {
      scene.add(
        new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(path.map((sample) => place(sample.p)))), pathMaterial),
      )
    }
    for (const bounce of bounces) {
      const dot = new THREE.Mesh(bounceGeometry, seenBounce)
      dot.position.copy(place(bounce))
      scene.add(dot)
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
    const start = drawn[0]![0]!.t
    const seenEnd = drawn[drawn.length - 1]!.at(-1)!.t
    const end = prediction?.path[prediction.path.length - 1]?.t ?? seenEnd
    const ballAt = (t: number) => {
      const path = drawn.find((item) => t >= item[0]!.t && t <= item.at(-1)!.t)
      if (path) return path.find((sample) => sample.t >= t)?.p ?? null
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
  }, [preset, callArea, paths, bounces, prediction, cameras])

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
  const paths = useMemo(() => flightPaths(flights), [flights])
  const seenBounces = useMemo(() => flightBounces(flights).map((bounce) => bounce.p), [flights])
  const cameras = useMemo(() => (fit ? [fit.camera.position] : []), [fit])
  const last = flights[flights.length - 1]
  const [airId, setAirId] = useState(() => readAirChoice(court.preset))
  const air = airFor(court.preset, airId)
  const [predicted, setPredicted] = useState<{ from: Flight; air: Air; prediction: Prediction } | null>(null)
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
    predictFlight(court.preset, { t: last.to, p: positionAt(last, last.to), v: velocityAt(last, last.to) }, PREDICT_SECONDS, air)
      .then((prediction) => {
        if (!current) return
        setPredicted({ from: last, air, prediction })
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
  }, [court.preset, last, air])

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
        The camera could not be placed from these court points. Check that each click matches the point named
        for it, in the same order.
      </p>
    )
  }

  const prediction = predicted && predicted.from === last && predicted.air === air ? predicted.prediction : null
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
              {flight.rmsPx.toFixed(1)} px
              {flight.reliable
                ? ` · height ±${(flight.heightSigma * 100).toFixed(0)} cm`
                : flight.heightSigma > 0.5 && Number.isFinite(flight.heightSigma)
                  ? ` (height uncertain by ±${flight.heightSigma.toFixed(1)} m from one camera, not drawn)`
                  : ' (poor fit, not drawn)'}
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
            3D bounce {index + 1} at {bounce.t.toFixed(2)} s: {describeSpot(court.preset, bounce.p, court.callArea)}
          </li>
        ))}
      </ul>
      {flights.length > 0 ? (
        <>
          <FlightView
            preset={court.preset}
            callArea={court.callArea}
            paths={paths}
            bounces={seenBounces}
            prediction={prediction}
            cameras={cameras}
          />
          <AirSelect preset={court.preset} value={airId} onChange={setAirId} />
          {prediction ? <p className="note">{predictionText(court.preset, prediction, court.callArea)}</p> : null}
          {!prediction && !error ? <p className="muted">Loading Rapier physics.</p> : null}
          <p className="muted">
            Gold is the tracked flight, teal is the Rapier prediction after the video ends, and the white dot
            is the camera. {airText(air)}
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
