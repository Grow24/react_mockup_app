import { Link } from 'react-router-dom'
import { useSession } from '../session/context'

export function AiProcessing() {
  const { assets } = useSession()

  return (
    <section className="screen narrow">
      <div className="screen-intro">
        <h2>AI Processing</h2>
        <p>
          Capture and inference stay separate. Photos and video already work with this switch off.
          MediaPipe labels, pose landmarks, and bounding boxes connect in the next stage.
        </p>
      </div>

      <article className="card">
        <header className="card-head">
          <h3>Inference</h3>
          <span className="pill">Off</span>
        </header>
        <p>No model is loaded. The camera page does not send frames anywhere.</p>
        <ul className="next-list">
          <li>MediaPipe object labels and confidence</li>
          <li>Pose landmarks for the 3D viewer</li>
          <li>A confidence threshold that does not stop capture</li>
        </ul>
        <div className="controls">
          <Link className="primary link-button" to="/">
            Back to camera
          </Link>
          <Link className="secondary link-button" to="/results">
            Open results ({assets.length})
          </Link>
        </div>
      </article>
    </section>
  )
}
