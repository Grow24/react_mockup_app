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
          Object labels come from MediaPipe EfficientDet. The skeleton comes from the Pose
          Landmarker. Both draw on the camera preview, and a photo keeps the result from the moment
          you captured it.
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
