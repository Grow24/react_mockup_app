import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { COURT_PRESETS, type BallTrack, type CourtCalibration, type MotionTrack, type PoseTrack } from '../../shared/contracts.ts'
import { motionAt, multiplyHomography } from '../vision/motion'
import { courtLines, courtWorldPoints } from '../../shared/court.ts'
import { courtFitsTrack } from '../vision/ball'
import { cameraFromCourt, courtHomography, flightAt, positionAt, type FlightFit, type Vec3 } from '../vision/flight'
import { sharedFlightFit } from '../vision/flightFit'
import { feetOnCourt, frameAt, PERSON_BONES, personColor, personName } from '../vision/players'
import { DEFAULT_VIEW, liftPerson, parseViewCommand, viewPose, type ViewSpot } from '../vision/virtualCamera'
import { length, useUnits, xyz } from '../units'

type Pose = { position: Vec3; target: Vec3; label: string }
const PLAYER_SLOTS = 4

const GROUND_VERTEX = `
  varying vec2 vCourt;
  uniform vec2 halfSize;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vCourt = vec2(world.x + halfSize.x, halfSize.y - world.z);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

// Each ground point looks up its own pixel in the recorded frame through the court homography.
const GROUND_FRAGMENT = `
  varying vec2 vCourt;
  uniform sampler2D frame;
  uniform mat3 homography;
  uniform vec2 frameSize;
  uniform float facing;
  uniform float showVideo;
  uniform vec3 base;
  void main() {
    vec3 color = base;
    vec3 p = homography * vec3(vCourt, 1.0);
    if (showVideo > 0.5 && p.z * facing > 1e-6) {
      vec2 uv = p.xy / p.z / frameSize;
      if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) color = texture2D(frame, vec2(uv.x, 1.0 - uv.y)).rgb;
    }
    gl_FragColor = vec4(color, 1.0);
  }
`

export function VirtualView({
  videoRef,
  court,
  ballTrack,
  poseTrack,
  motion,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  court: CourtCalibration
  // Both with camera motion already taken out.
  ballTrack: BallTrack | null
  poseTrack: PoseTrack | null
  motion: MotionTrack | null
}) {
  const units = useUnits()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const readoutRef = useRef<HTMLUListElement | null>(null)
  const recorded = useMemo(() => cameraFromCourt(court), [court])
  const [spot, setSpot] = useState<ViewSpot>(DEFAULT_VIEW)
  const [pose, setPose] = useState<Pose>(() => ({ ...viewPose(court.preset, DEFAULT_VIEW), label: 'spot' }))
  const [command, setCommand] = useState('10 feet behind the baseline, 15 feet above, on the right side')
  const [note, setNote] = useState<string | null>(null)
  const [showVideo, setShowVideo] = useState(true)
  const [fit, setFit] = useState<FlightFit | null>(null)
  const poseRef = useRef(pose)
  const showVideoRef = useRef(showVideo)
  const stateRef = useRef({ fit, poseTrack, units, motion })

  useEffect(() => {
    poseRef.current = pose
    showVideoRef.current = showVideo
    stateRef.current = { fit, poseTrack, units, motion }
  })

  useEffect(() => {
    if (!ballTrack || !courtFitsTrack(ballTrack, court)) return
    let current = true
    sharedFlightFit(ballTrack, court)
      .then((next) => {
        if (current) setFit(next)
      })
      .catch((caught) => console.error(caught))
    return () => {
      current = false
    }
  }, [ballTrack, court])

  useEffect(() => {
    const host = hostRef.current
    const video = videoRef.current
    const h = courtHomography(court)
    if (!host || !video || !h) return
    const { widthMeters: width, lengthMeters: courtLength } = COURT_PRESETS[court.preset]
    const place = (p: Vec3) => new THREE.Vector3(p.x - width / 2, p.z, courtLength / 2 - p.y)
    const disposables: { dispose: () => void }[] = []
    const keep = <T extends { dispose: () => void }>(item: T) => {
      disposables.push(item)
      return item
    }

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x161310)
    const view = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 500)
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    host.appendChild(renderer.domElement)
    const controls = new OrbitControls(view, renderer.domElement)
    controls.enableDamping = true
    controls.maxDistance = 150

    const frameTexture = keep(new THREE.VideoTexture(video))
    const marked = courtWorldPoints(court)[0]!
    const facing = Math.sign(h[6]! * marked.x + h[7]! * marked.y + h[8]!) || 1
    const courtToPhoto = new THREE.Matrix3().set(h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, h[8]!)
    const groundMaterial = keep(
      new THREE.ShaderMaterial({
        vertexShader: GROUND_VERTEX,
        fragmentShader: GROUND_FRAGMENT,
        uniforms: {
          frame: { value: frameTexture },
          homography: { value: courtToPhoto.clone() },
          frameSize: { value: new THREE.Vector2(court.sourceWidth, court.sourceHeight) },
          facing: { value: facing },
          showVideo: { value: 1 },
          base: { value: new THREE.Color(0x2e6b4a) },
          halfSize: { value: new THREE.Vector2(width / 2, courtLength / 2) },
        },
      }),
    )
    const ground = new THREE.Mesh(keep(new THREE.PlaneGeometry(width + 20, courtLength + 24, 1, 1)), groundMaterial)
    ground.rotation.x = -Math.PI / 2
    scene.add(ground)

    const lineMaterial = keep(new THREE.LineBasicMaterial({ color: 0xf6f1ea, transparent: true, opacity: 0.85 }))
    for (const line of courtLines(court.preset)) {
      scene.add(
        new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints([place({ ...line.from, z: 0.01 }), place({ ...line.to, z: 0.01 })])), lineMaterial),
      )
    }
    if (court.preset === 'tennis-doubles') {
      const net = new THREE.Mesh(
        keep(new THREE.PlaneGeometry(width + 1.83, 0.914)),
        keep(new THREE.MeshBasicMaterial({ color: 0xf6f1ea, transparent: true, opacity: 0.3, side: THREE.DoubleSide })),
      )
      net.position.copy(place({ x: width / 2, y: courtLength / 2, z: 0.457 }))
      scene.add(net)
    }

    if (recorded) {
      const marker = new THREE.Mesh(keep(new THREE.SphereGeometry(0.25, 16, 16)), keep(new THREE.MeshBasicMaterial({ color: 0xf7fffe })))
      marker.position.copy(place(recorded.position))
      scene.add(marker)
    }

    const ball = new THREE.Mesh(keep(new THREE.SphereGeometry(0.12, 16, 16)), keep(new THREE.MeshBasicMaterial({ color: 0xd8ec4a })))
    const shadow = new THREE.Mesh(keep(new THREE.CircleGeometry(0.12, 20)), keep(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 })))
    shadow.rotation.x = -Math.PI / 2
    scene.add(ball, shadow)
    const trailGeometry = keep(new THREE.BufferGeometry())
    const trail = new THREE.Line(trailGeometry, keep(new THREE.LineBasicMaterial({ color: 0xf3d38a })))
    scene.add(trail)

    const players = Array.from({ length: PLAYER_SLOTS }, () => {
      const geometry = keep(new THREE.BufferGeometry())
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PERSON_BONES.length * 6), 3))
      const boneMaterial = keep(new THREE.LineBasicMaterial({ color: 0xc9c1b6 }))
      const headMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xc9c1b6 }))
      const bones = new THREE.LineSegments(geometry, boneMaterial)
      const head = new THREE.Mesh(keep(new THREE.SphereGeometry(0.12, 12, 12)), headMaterial)
      scene.add(bones, head)
      return { bones, head, geometry, boneMaterial, headMaterial }
    })

    let appliedPose: Pose | null = null
    let shownText = ''
    const resize = () => {
      const w = host.clientWidth
      const hgt = host.clientHeight
      if (w < 2 || hgt < 2) return
      view.aspect = w / hgt
      view.updateProjectionMatrix()
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(w, hgt, false)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    let frame = 0
    const loop = () => {
      frame = requestAnimationFrame(loop)
      const { fit: fitted, poseTrack: track, units: shownUnits, motion: moving } = stateRef.current
      if (appliedPose !== poseRef.current) {
        appliedPose = poseRef.current
        view.position.copy(place(appliedPose.position))
        controls.target.copy(place(appliedPose.target))
        controls.update()
      }
      groundMaterial.uniforms.showVideo!.value = showVideoRef.current ? 1 : 0
      const t = video.currentTime
      // With the camera moving, each ground point is looked up in this frame, not in the court photo.
      const moved = moving ? motionAt(moving, t) : null
      const toFrame = moved ? multiplyHomography(moved, h) : h
      ;(groundMaterial.uniforms.homography!.value as THREE.Matrix3).set(
        toFrame[0]!, toFrame[1]!, toFrame[2]!, toFrame[3]!, toFrame[4]!, toFrame[5]!, toFrame[6]!, toFrame[7]!, toFrame[8]!,
      )
      const lines: string[] = []

      const flight = flightAt(fitted, t)
      ball.visible = shadow.visible = trail.visible = !!flight
      if (flight) {
        const p = positionAt(flight, t)
        ball.position.copy(place(p))
        shadow.position.copy(place({ ...p, z: 0.005 }))
        const samples: THREE.Vector3[] = []
        for (let s = flight.from; s <= Math.min(t, flight.to); s += 1 / 60) samples.push(place(positionAt(flight, s)))
        trailGeometry.setFromPoints(samples.length > 1 ? samples : [place(p), place(p)])
        lines.push(`Ball: ${xyz(p, shownUnits)}`)
      }

      const people = track ? (frameAt(track, t)?.people ?? []).filter((candidate) => candidate.player || candidate.id) : []
      for (const [slot, item] of players.entries()) {
        const person = people[slot]
        if (person) {
          item.boneMaterial.color.set(personColor(person))
          item.headMaterial.color.set(personColor(person))
        }
        const feet = person && track ? feetOnCourt(person, court, track.sourceWidth, track.sourceHeight) : null
        const joints =
          person && feet && recorded && track
            ? liftPerson(person, recorded, feet, court.sourceWidth / track.sourceWidth, court.sourceHeight / track.sourceHeight)
            : null
        item.bones.visible = item.head.visible = !!joints
        if (!joints) continue
        const positions = item.geometry.getAttribute('position') as THREE.BufferAttribute
        PERSON_BONES.forEach(([a, b], index) => {
          const from = joints[a]
          const to = joints[b]
          const start = from ? place(from) : new THREE.Vector3()
          const end = to ? place(to) : start
          positions.setXYZ(index * 2, start.x, start.y, start.z)
          positions.setXYZ(index * 2 + 1, from && to ? end.x : start.x, from && to ? end.y : start.y, from && to ? end.z : start.z)
        })
        positions.needsUpdate = true
        item.geometry.computeBoundingSphere()
        const nose = joints[0]
        item.head.visible = !!nose
        if (nose) item.head.position.copy(place(nose))
        lines.push(`${personName(person!)}: feet at ${xyz({ ...feet!, z: 0 }, shownUnits)}`)
      }

      const text = lines.join('\n')
      const node = readoutRef.current
      if (node && text !== shownText) {
        shownText = text
        node.replaceChildren(
          ...(lines.length ? lines : [`At ${t.toFixed(2)} s there is no tracked ball or player.`]).map((line) => {
            const item = document.createElement('li')
            item.textContent = line
            return item
          }),
        )
      }
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
  }, [court, videoRef, recorded])

  function applyCommand() {
    const parsed = parseViewCommand(command, units, spot)
    if (!parsed) {
      setNote('Say how far behind the baseline, how high, and which side, for example "10 feet behind, 15 feet above, right side".')
      return
    }
    setSpot(parsed)
    setPose({ ...viewPose(court.preset, parsed), label: 'spot' })
    setNote(null)
  }

  function preset(id: string) {
    const { widthMeters: width, lengthMeters: courtLength } = COURT_PRESETS[court.preset]
    const middle = { x: width / 2, y: courtLength / 2, z: 0 }
    if (id === 'recorded' && recorded) setPose({ position: recorded.position, target: middle, label: 'recorded' })
    if (id === 'umpire') setPose({ position: { x: -1.5, y: courtLength / 2, z: 2.4 }, target: middle, label: 'umpire' })
    if (id === 'overhead') setPose({ position: { x: width / 2, y: courtLength / 2 - 0.01, z: 32 }, target: middle, label: 'overhead' })
    if (id === 'spot') setPose({ ...viewPose(court.preset, spot), label: 'spot' })
  }

  const where =
    pose.label === 'recorded'
      ? 'where the real camera stood'
      : pose.label === 'umpire'
        ? "at the umpire's chair"
        : pose.label === 'overhead'
          ? 'straight above the court'
          : `${length(spot.behind, units)} behind the ${spot.end} baseline, ${length(spot.height, units)} high, on the ${spot.side === 'center' ? 'center line' : `${spot.side} side`}`

  return (
    <section className="still-pose ball-panel" aria-label="Virtual camera">
      <h4>Virtual camera</h4>
      <p className="muted">
        The same moment seen from anywhere around the court. The ground is the recorded video laid back onto the court,
        players stand up from their tracked joints, and the ball follows its 3D flight. Play or scrub the video above.
        Players and the ball show once they are tracked below.
      </p>
      <label className="field">
        <span>Where to watch from</span>
        <input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && applyCommand()} />
      </label>
      <div className="controls">
        <button type="button" className="primary" onClick={applyCommand}>
          Show this view
        </button>
        <button type="button" className="secondary" onClick={() => preset('recorded')} disabled={!recorded}>
          Real camera
        </button>
        <button type="button" className="secondary" onClick={() => preset('umpire')}>
          Umpire&apos;s chair
        </button>
        <button type="button" className="secondary" onClick={() => preset('overhead')}>
          Overhead
        </button>
      </div>
      {note ? <p className="warn">{note}</p> : null}
      <p className="note" role="status">
        Virtual camera {where}: {xyz(pose.position, units)}, looking at the middle of the court.
      </p>
      <label className="check">
        <input type="checkbox" checked={showVideo} onChange={(event) => setShowVideo(event.target.checked)} /> Show the recorded
        video on the ground
      </label>
      <div ref={hostRef} className="skeleton-view flight-view virtual-view" role="img" aria-label="Virtual camera view. Drag to look around." />
      <ul ref={readoutRef} className="label-list" aria-live="off" />
      <p className="muted">
        Only what the real camera saw can appear: the video on the ground stretches anything standing up, so the players
        are drawn as skeletons instead, flat from front to back.
      </p>
    </section>
  )
}
