import Foundation

/// Same estimates as the web app, so a lift shows the same max on every device.
public enum OneRepMax {
    public static let maxEstimateReps = 12

    public static func epley(_ weight: Double, _ reps: Int) -> Double { reps == 1 ? weight : weight * (1 + Double(reps) / 30) }
    public static func brzycki(_ weight: Double, _ reps: Int) -> Double { reps == 1 ? weight : weight * 36 / Double(37 - reps) }
    public static func lombardi(_ weight: Double, _ reps: Int) -> Double { weight * pow(Double(reps), 0.1) }

    /// The average of Epley, Brzycki, and Lombardi, or nil past `maxEstimateReps` where they drift apart.
    public static func estimate(_ weight: Double, _ reps: Int) -> Double? {
        guard weight > 0, reps >= 1, reps <= maxEstimateReps else { return nil }
        return (epley(weight, reps) + brzycki(weight, reps) + lombardi(weight, reps)) / 3
    }
}
