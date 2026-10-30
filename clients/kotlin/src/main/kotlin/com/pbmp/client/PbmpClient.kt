package com.pbmp.client

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.util.UUID

class PbmpException(val status: Int, message: String) : Exception(message)

/** Add [offsetMs] to the phone's clock to get the server's clock. */
data class ClockSync(val offsetMs: Double, val roundTripMs: Double)

/**
 * Talks to a PBMP Camera server, for example `https://reactcamapp.zeabur.app`.
 * Every call blocks, so on Android run them off the main thread, for example with Dispatchers.IO.
 */
class PbmpClient(baseUrl: String, private val timeoutMs: Int = 20_000) {
    val baseUrl: String = baseUrl.trimEnd('/')
    var clock: ClockSync? = null
        private set

    fun resolve(path: String): String = URI(baseUrl + "/").resolve(path.removePrefix("/")).toString()

    private class Reply(val status: Int, val body: ByteArray)

    private fun call(method: String, path: String, body: ByteArray? = null, contentType: String? = null): Reply {
        val connection = URI(if (path.startsWith("http")) path else baseUrl + path).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            connection.setRequestProperty("Accept", "application/json")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", contentType ?: "application/json")
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            return Reply(status, stream?.use { it.readBytes() } ?: ByteArray(0))
        } finally {
            connection.disconnect()
        }
    }

    private fun json(method: String, path: String, body: Any? = null): Any? {
        val reply = call(method, path, body?.let { Json.write(it).toByteArray() })
        val text = reply.body.toString(Charsets.UTF_8)
        val parsed = if (text.isBlank()) null else Json.parse(text)
        if (reply.status >= 400) {
            val message = (parsed as? Map<*, *>)?.get("error") as? String ?: "Request failed"
            throw PbmpException(reply.status, message)
        }
        return parsed
    }

    @Suppress("UNCHECKED_CAST")
    private fun obj(method: String, path: String, body: Any? = null) = json(method, path, body) as JsonObject

    fun health(): Boolean = try { obj("GET", "/api/health")["ok"] == true } catch (_: Exception) { false }

    /** Measures this phone's clock against the server's, keeping the sample with the shortest round trip. */
    fun syncClock(samples: Int = 6): ClockSync {
        var best: ClockSync? = null
        repeat(samples) {
            val sent = System.currentTimeMillis()
            val now = obj("GET", "/api/time").num("now")
            val received = System.currentTimeMillis()
            val sample = ClockSync(now - (sent + received) / 2.0, (received - sent).toDouble())
            val current = best
            if (current == null || sample.roundTripMs < current.roundTripMs) best = sample
        }
        return checkNotNull(best).also { clock = it }
    }

    fun serverNow(): Long = System.currentTimeMillis() + Math.round(clock?.offsetMs ?: 0.0)

    fun openSession(id: String, device: Device): SessionDetail =
        SessionDetail.from(obj("POST", "/api/sessions", mapOf("id" to id, "device" to device.toJson())))

    /** Returns null when no session has this id. */
    fun getSession(id: String): SessionDetail? = try {
        SessionDetail.from(obj("GET", "/api/sessions/$id"))
    } catch (error: PbmpException) {
        if (error.status == 404) null else throw error
    }

    fun uploadAsset(
        sessionId: String,
        bytes: ByteArray,
        kind: String,
        mimeType: String,
        cameraLabel: String,
        id: String = UUID.randomUUID().toString(),
        width: Int? = null,
        height: Int? = null,
        deviceId: String? = null,
        takeId: String? = null,
        startedAt: Long? = null,
    ): SessionDetail {
        val meta = Json.write(mapOf(
            "id" to id, "kind" to kind, "mimeType" to mimeType, "createdAt" to System.currentTimeMillis(),
            "cameraLabel" to cameraLabel, "width" to width, "height" to height,
            "deviceId" to deviceId, "takeId" to takeId, "startedAt" to startedAt,
        ))
        val boundary = "pbmp-" + UUID.randomUUID()
        val form = ByteArrayOutputStream()
        fun line(text: String) = form.write((text + "\r\n").toByteArray())
        line("--$boundary")
        line("Content-Disposition: form-data; name=\"meta\"")
        line("")
        line(meta)
        line("--$boundary")
        line("Content-Disposition: form-data; name=\"file\"; filename=\"${if (kind == "video") "video.webm" else "photo.jpg"}\"")
        line("Content-Type: $mimeType")
        line("")
        form.write(bytes)
        line("")
        line("--$boundary--")
        val reply = call("POST", "/api/sessions/$sessionId/assets", form.toByteArray(), "multipart/form-data; boundary=$boundary")
        val text = reply.body.toString(Charsets.UTF_8)
        if (reply.status >= 400) throw PbmpException(reply.status, ((Json.parse(text) as? Map<*, *>)?.get("error") as? String) ?: "Upload failed")
        @Suppress("UNCHECKED_CAST")
        return SessionDetail.from(Json.parse(text) as JsonObject)
    }

    fun deleteAsset(id: String) { json("DELETE", "/api/assets/$id") }

    fun download(path: String): ByteArray {
        val reply = call("GET", resolve(path))
        if (reply.status >= 400) throw PbmpException(reply.status, "Download failed")
        return reply.body
    }

    fun saveCourt(sessionId: String, court: CourtCalibration) = SessionDetail.from(obj("PUT", "/api/sessions/$sessionId/court", court.toJson()))

    fun clearCourt(sessionId: String, deviceId: String = ""): SessionDetail {
        val query = if (deviceId.isEmpty()) "" else "?device=" + URLEncoder.encode(deviceId, "UTF-8")
        return SessionDetail.from(obj("DELETE", "/api/sessions/$sessionId/court$query"))
    }

    fun saveBallTrack(track: BallTrack) = SessionDetail.from(obj("PUT", "/api/assets/${track.assetId}/ball-track", track.toJson()))

    fun clearBallTrack(assetId: String) { json("DELETE", "/api/assets/$assetId/ball-track") }

    fun createTake(sessionId: String, seconds: Int, deviceId: String? = null) =
        Take.from(obj("POST", "/api/sessions/$sessionId/takes", mapOf("seconds" to seconds, "deviceId" to deviceId)))

    @Suppress("UNCHECKED_CAST")
    fun latestTake(sessionId: String): Take? = (obj("GET", "/api/sessions/$sessionId/takes/latest")["take"] as JsonObject?)?.let(Take::from)

    fun workoutBook(sessionId: String) = WorkoutBook.from(obj("GET", "/api/sessions/$sessionId/workouts"))

    /** Returns the stored workout: this one, a newer edit from another phone, or null if it was deleted. */
    @Suppress("UNCHECKED_CAST")
    fun saveWorkout(sessionId: String, workout: Workout): Workout? =
        (obj("PUT", "/api/sessions/$sessionId/workouts/${workout.id}", workout.toJson())["saved"] as JsonObject?)?.let(Workout::from)

    fun deleteWorkout(sessionId: String, id: String) { json("DELETE", "/api/sessions/$sessionId/workouts/$id") }

    @Suppress("UNCHECKED_CAST")
    fun saveExercise(sessionId: String, exercise: Exercise): Exercise =
        Exercise.from(obj("PUT", "/api/sessions/$sessionId/exercises/${exercise.id}", exercise.toJson())["saved"] as JsonObject)

    fun deleteExercise(sessionId: String, id: String) { json("DELETE", "/api/sessions/$sessionId/exercises/$id") }

    /** The ONNX file of a custom model, to run with ONNX Runtime Mobile. */
    fun downloadModel(model: CustomModel): ByteArray = download(model.fileUrl)
}
