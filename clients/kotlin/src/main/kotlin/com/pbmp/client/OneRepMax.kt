package com.pbmp.client

import kotlin.math.pow

/** Same estimates as the web app, so a lift shows the same max on every device. */
object OneRepMax {
    const val MAX_ESTIMATE_REPS = 12

    fun epley(weight: Double, reps: Int) = if (reps == 1) weight else weight * (1 + reps / 30.0)
    fun brzycki(weight: Double, reps: Int) = if (reps == 1) weight else weight * 36 / (37 - reps)
    fun lombardi(weight: Double, reps: Int) = weight * reps.toDouble().pow(0.1)

    /** The average of Epley, Brzycki, and Lombardi, or null past [MAX_ESTIMATE_REPS] where they drift apart. */
    fun estimate(weight: Double, reps: Int): Double? {
        if (weight <= 0 || reps < 1 || reps > MAX_ESTIMATE_REPS) return null
        return (epley(weight, reps) + brzycki(weight, reps) + lombardi(weight, reps)) / 3
    }
}
