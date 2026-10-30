package com.pbmp.client

import java.util.UUID
import kotlin.math.abs

// Runs without JUnit: kotlinc src/main/kotlin src/test/kotlin -include-runtime -d test.jar && java -jar test.jar
private var passed = 0

private fun check(condition: Boolean, message: String) {
    if (!condition) throw AssertionError(message)
    passed += 1
}

fun main() {
    check(abs(OneRepMax.estimate(100.0, 5)!! - 115.543) < 0.01, "one-rep max matches the web app")
    check(OneRepMax.estimate(100.0, 13) == null, "no estimate past 12 reps")

    val parsed = Json.parse("""{"a":[1,2.5,"x\u00e9\n",true,null],"b":{"c":-3e2}}""") as Map<*, *>
    check((parsed["a"] as List<*>)[1] == 2.5 && (parsed["b"] as Map<*, *>)["c"] == -300.0, "JSON reads numbers, strings, and nesting")
    check(Json.write(mapOf("w" to 100.0, "skip" to null, "s" to "a\"b")) == """{"w":100,"s":"a\"b"}""", "JSON writes compactly")

    val baseUrl = System.getenv("PBMP_BASE_URL") ?: "http://127.0.0.1:8787"
    val client = PbmpClient(baseUrl)
    if (!client.health()) {
        println("Skipped the server checks: no PBMP server at $baseUrl. $passed checks passed.")
        return
    }
    val sessionId = UUID.randomUUID().toString()
    val deviceId = UUID.randomUUID().toString()
    check(client.syncClock().roundTripMs < 2000, "the clock syncs")
    val opened = client.openSession(sessionId, Device(deviceId, "Kotlin test"))
    check(opened.id == sessionId && opened.locked && client.sessionKey != null, "a new session opens privately")
    val stranger = PbmpClient(baseUrl)
    check(runCatching { stranger.getSession(sessionId) }.exceptionOrNull().let { it is PbmpException && it.status == 403 }, "a client without the key is refused")
    check(stranger.unlock(sessionId, client.sessionKey!!)?.id == sessionId, "the shared key opens it")
    check(client.getSession(UUID.randomUUID().toString()) == null, "an unknown session is null")

    val bytes = ByteArray(2048) { (it % 251).toByte() }
    val assetId = UUID.randomUUID().toString()
    val uploaded = client.uploadAsset(sessionId, bytes, "video", "video/webm", "Kotlin camera", assetId, 640, 360, deviceId, startedAt = client.serverNow())
    val asset = uploaded.assets.single()
    check(asset.deviceId == deviceId && client.download(asset.fileUrl).contentEquals(bytes), "media uploads and downloads unchanged")

    val court = CourtCalibration("tennis-doubles", assetId, 640.0, 360.0,
        listOf(CourtPoint(49.0, 324.0), CourtPoint(551.0, 338.0), CourtPoint(407.0, 134.0), CourtPoint(250.0, 132.0)), deviceId)
    check(client.saveCourt(sessionId, court).courtFor(deviceId)?.imagePoints?.size == 4, "a court is saved for this phone")

    val track = BallTrack(assetId, "yolov8n-coco-onnx", 640.0, 360.0, 10.0, 0.2, System.currentTimeMillis(),
        listOf(BallPoint(0.0, 100.0, 100.0, 8.0, 0.8), BallPoint(0.1, 110.0, 120.0, 8.0, 0.7, bounce = true)))
    check(client.saveBallTrack(track).ballTracks.single().points.last().bounce, "a ball track is saved")

    val take = client.createTake(sessionId, 5, deviceId)
    check(take.startAt - client.serverNow() in 1500..3000, "a take starts about 2.5 s ahead")
    check(client.latestTake(sessionId)?.id == take.id, "the latest take is found")

    val workoutId = UUID.randomUUID().toString()
    fun version(name: String, updatedAt: Long) = Workout(workoutId, name, 1000, updatedAt,
        listOf(WorkoutEntry("e1", "deadlift", listOf(WorkoutSet("s1", reps = 3, weightKg = 140.0, done = true)))))
    check(client.saveWorkout(sessionId, version("Pull day", 2000))?.name == "Pull day", "a workout saves")
    check(client.saveWorkout(sessionId, version("Stale copy", 1500))?.name == "Pull day", "the newer edit wins")
    val exercise = Exercise(UUID.randomUUID().toString(), "Serve practice", ExerciseKind.timed, listOf("shoulders"))
    check(client.saveExercise(sessionId, exercise).kind == ExerciseKind.timed, "an exercise saves")
    val book = client.workoutBook(sessionId)
    check(book.workouts.single().entries.single().sets.single().weightKg == 140.0 && book.exercises.single().name == "Serve practice", "the book reads back")
    client.deleteWorkout(sessionId, workoutId)
    check(client.saveWorkout(sessionId, version("Back again", 99_999_999_999_999)) == null, "a deletion stays deleted")
    client.deleteExercise(sessionId, exercise.id)
    check(client.workoutBook(sessionId).deleted.contains(workoutId), "the deletion is listed")

    client.deleteAsset(assetId)
    check(client.getSession(sessionId)!!.assets.isEmpty(), "the asset is removed")
    println("All $passed checks passed against $baseUrl.")
}
