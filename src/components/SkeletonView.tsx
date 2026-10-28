import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { PosePoint } from '../types'
import { POSE_CONNECTIONS } from '../vision/draw'

function place(point: PosePoint) {
  return new THREE.Vector3(point.x, -(point.y), -(point.z ?? 0))
}

export function SkeletonView({ pose }: { pose: PosePoint[] }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 20)
    camera.position.set(0.35, 0.45, 2.4)
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setClearColor(0x161310)
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0, 0)
    controls.minDistance = 0.8
    controls.maxDistance = 6

    const segments: THREE.Vector3[] = []
    for (const [start, end] of POSE_CONNECTIONS) {
      const a = pose[start]
      const b = pose[end]
      if (!a || !b || a.z == null || b.z == null || a.visibility < 0.4 || b.visibility < 0.4) continue
      segments.push(place(a), place(b))
    }
    const boneGeometry = new THREE.BufferGeometry().setFromPoints(segments)
    const boneMaterial = new THREE.LineBasicMaterial({ color: 0x9ee8e2 })
    scene.add(new THREE.LineSegments(boneGeometry, boneMaterial))

    const jointGeometry = new THREE.SphereGeometry(0.02, 12, 12)
    const jointMaterial = new THREE.MeshBasicMaterial({ color: 0xf7fffe })
    for (const point of pose) {
      if (point.z == null || point.visibility < 0.5) continue
      const joint = new THREE.Mesh(jointGeometry, jointMaterial)
      joint.position.copy(place(point))
      scene.add(joint)
    }

    const resize = () => {
      const width = host.clientWidth
      const height = host.clientHeight
      if (width < 2 || height < 2) return
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(width, height, false)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    let frame = 0
    const loop = () => {
      frame = requestAnimationFrame(loop)
      controls.update()
      renderer.render(scene, camera)
    }
    loop()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      boneGeometry.dispose()
      boneMaterial.dispose()
      jointGeometry.dispose()
      jointMaterial.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [pose])

  return (
    <div
      ref={hostRef}
      className="skeleton-view"
      tabIndex={0}
      role="img"
      aria-label="3D skeleton. Drag to rotate."
    />
  )
}
