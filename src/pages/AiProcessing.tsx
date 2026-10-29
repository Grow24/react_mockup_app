import { Link } from 'react-router-dom'
import { AiControls } from '../components/AiControls'
import { useSession } from '../session/context'

export function AiProcessing() {
  const { assets } = useSession()

  return (
    <section className="screen narrow">
      <div className="screen-intro">
        <h2>AI Processing</h2>
        <p>
          Object labels come from MediaPipe EfficientDet, or from YOLOv8n in the same ONNX layout
          Roboflow exports. The skeleton stays on the Pose Landmarker. A capture keeps that pose,
          and Results can turn it in 3D. The timing line is how many passes finished, how long they
          took, and how many camera frames were skipped while a pass was still running.
        </p>
      </div>

      <AiControls />

      <div className="controls page-links">
        <Link className="primary link-button" to="/">
          Open camera
        </Link>
        <Link className="secondary link-button" to="/results">
          Open results ({assets.length})
        </Link>
      </div>
    </section>
  )
}
