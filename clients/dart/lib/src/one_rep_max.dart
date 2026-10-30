import 'dart:math' as math;

/// Same estimates as the web app, so a lift shows the same max on every device.
const maxEstimateReps = 12;

double epley(double weight, int reps) => reps == 1 ? weight : weight * (1 + reps / 30);
double brzycki(double weight, int reps) => reps == 1 ? weight : weight * 36 / (37 - reps);
double lombardi(double weight, int reps) => weight * math.pow(reps, 0.1);

/// The average of Epley, Brzycki, and Lombardi, or null past [maxEstimateReps] where they drift apart.
double? estimateOneRepMax(double weight, int reps) {
  if (weight <= 0 || reps < 1 || reps > maxEstimateReps) return null;
  return (epley(weight, reps) + brzycki(weight, reps) + lombardi(weight, reps)) / 3;
}
