import { useEffect, useRef, useState, type RefObject } from 'react'
import { frameRect } from '../vision/draw'
import { FENCE_THICKNESS, FenceRemover, learnFence, type FenceThickness } from '../vision/fence'

// The video with the fence painted out, drawn over the playing video; or the fence mask, to check it.
export function FenceCanvas({
  videoRef,
  remover,
  mode,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  remover: FenceRemover
  mode: 'clean' | 'mask'
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let frame = 0
    let drawn = ''
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.videoWidth < 2 || video.readyState < 2) return
      const key = `${video.clientWidth}x${video.clientHeight}@${video.currentTime}:${mode}`
      if (key === drawn) return
      drawn = key
      const bounds = frameRect(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight)
      canvas.style.left = `${video.offsetLeft + bounds.x}px`
      canvas.style.top = `${video.offsetTop + bounds.y}px`
      canvas.style.width = `${bounds.width}px`
      canvas.style.height = `${bounds.height}px`
      const width = Math.max(1, Math.round(bounds.width))
      const height = Math.max(1, Math.round(bounds.height))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      if (mode === 'clean') remover.clean(video, canvas)
      else {
        canvas.getContext('2d')?.clearRect(0, 0, width, height)
        remover.drawMask(canvas)
      }
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [videoRef, remover, mode])

  return <canvas ref={canvasRef} className="annotation" aria-hidden="true" />
}

export function FencePanel({
  url,
  width,
  height,
  remover,
  mode,
  onRemover,
  onMode,
}: {
  url: string
  width: number
  height: number
  remover: FenceRemover | null
  mode: 'off' | 'clean' | 'mask'
  onRemover: (remover: FenceRemover | null) => void
  onMode: (mode: 'off' | 'clean' | 'mask') => void
}) {
  const [thickness, setThickness] = useState<FenceThickness>('thin')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const running = progress !== null && progress.done < progress.total

  useEffect(() => () => abortRef.current?.abort(), [])

  async function learn() {
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setProgress({ done: 0, total: 1 })
    let made: FenceRemover | null = null
    try {
      made = await FenceRemover.create(width, height, thickness)
      await learnFence(url, made, controller.signal, (done, total) => setProgress({ done, total }))
      onRemover(made)
      onMode('clean')
    } catch (caught) {
      made?.dispose()
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        console.error(caught)
        setError(caught instanceof Error ? caught.message : 'The fence could not be found.')
      }
    } finally {
      setProgress(null)
      abortRef.current = null
    }
  }

  const coverage = remover ? remover.coverage() : 0

  return (
    <section className="still-pose ball-panel" aria-label="Fence">
      <h4>Fence</h4>
      <p className="muted">
        Filming through a chain-link fence: frames spread through the video are checked for thin dark wires that stay in
        the same place while the players move, and those wires are painted out from the picture around them (OpenCV
        inpainting). Hold the video steady first if the phone moved.
      </p>
      <label className="field">
        <span>Wire thickness</span>
        <select value={thickness} disabled={running} onChange={(event) => setThickness(event.target.value as FenceThickness)}>
          {Object.keys(FENCE_THICKNESS).map((choice) => (
            <option key={choice} value={choice}>
              {choice[0]!.toUpperCase() + choice.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <div className="controls">
        {running ? (
          <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void learn()}>
            {remover ? 'Find the fence again' : 'Find the fence'}
          </button>
        )}
      </div>
      {progress ? (
        <p className="muted" role="status">
          Looking at frame {progress.done} of {progress.total}
        </p>
      ) : null}
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
      {remover ? (
        <>
          <p className="note">
            {coverage < 0.01
              ? 'No fence was found in this video.'
              : `The fence covers about ${Math.round(coverage * 100)}% of the picture.`}
          </p>
          <label className="field">
            <span>Show</span>
            <select value={mode} onChange={(event) => onMode(event.target.value as 'off' | 'clean' | 'mask')}>
              <option value="clean">The video without the fence</option>
              <option value="mask">The fence that was found</option>
              <option value="off">The video as recorded</option>
            </select>
          </label>
          <p className="muted">
            Behind each wire the camera saw nothing, so that strip is filled in from its neighbours: thin wires vanish
            well, thick or blurry ones leave a soft trace. This is for watching: ball and player tracking keep using the
            recorded frames, which the models already see through a thin fence better than through filled-in ones.
          </p>
        </>
      ) : null}
    </section>
  )
}
