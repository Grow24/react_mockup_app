package com.pbmp.client

// Mirrors shared/contracts.ts in the web app. Field names match the JSON the server sends.

data class Device(val id: String, val label: String, val userAgent: String = "") {
    fun toJson(): JsonObject = mapOf("id" to id, "label" to label, "userAgent" to userAgent)

    companion object {
        fun from(json: JsonObject) = Device(json.str("id"), json.optStr("label") ?: "", json.optStr("userAgent") ?: "")
    }
}

data class MediaAsset(
    val id: String,
    val sessionId: String,
    val kind: String,
    val mimeType: String,
    val createdAt: Long,
    val cameraLabel: String,
    val byteLength: Long,
    val fileUrl: String,
    val width: Long? = null,
    val height: Long? = null,
    val deviceId: String? = null,
    val takeId: String? = null,
    val startedAt: Long? = null,
) {
    companion object {
        fun from(json: JsonObject) = MediaAsset(
            id = json.str("id"),
            sessionId = json.str("sessionId"),
            kind = json.str("kind"),
            mimeType = json.str("mimeType"),
            createdAt = json.long("createdAt"),
            cameraLabel = json.str("cameraLabel"),
            byteLength = json.long("byteLength"),
            fileUrl = json.str("fileUrl"),
            width = json.optLong("width"),
            height = json.optLong("height"),
            deviceId = json.optStr("deviceId"),
            takeId = json.optStr("takeId"),
            startedAt = json.optLong("startedAt"),
        )
    }
}

data class CourtPoint(val x: Double, val y: Double)

/** Four corners in the photo, in order: near left, near right, far right, far left. */
data class CourtCalibration(
    val preset: String,
    val assetId: String,
    val sourceWidth: Double,
    val sourceHeight: Double,
    val imagePoints: List<CourtPoint>,
    val deviceId: String? = null,
) {
    fun toJson(): JsonObject = mapOf(
        "preset" to preset,
        "assetId" to assetId,
        "sourceWidth" to sourceWidth,
        "sourceHeight" to sourceHeight,
        "imagePoints" to imagePoints.map { mapOf("x" to it.x, "y" to it.y) },
        "deviceId" to deviceId,
    )

    companion object {
        fun from(json: JsonObject) = CourtCalibration(
            preset = json.str("preset"),
            assetId = json.str("assetId"),
            sourceWidth = json.num("sourceWidth"),
            sourceHeight = json.num("sourceHeight"),
            imagePoints = json.objects("imagePoints").map { CourtPoint(it.num("x"), it.num("y")) },
            deviceId = json.optStr("deviceId"),
        )
    }
}

data class BallPoint(val t: Double, val x: Double, val y: Double, val radius: Double, val score: Double, val bounce: Boolean = false) {
    fun toJson(): JsonObject = mapOf("t" to t, "x" to x, "y" to y, "radius" to radius, "score" to score, "bounce" to if (bounce) true else null)

    companion object {
        fun from(json: JsonObject) = BallPoint(json.num("t"), json.num("x"), json.num("y"), json.num("radius"), json.num("score"), json["bounce"] == true)
    }
}

data class BallTrack(
    val assetId: String,
    val modelId: String,
    val sourceWidth: Double,
    val sourceHeight: Double,
    val sampleFps: Double,
    val duration: Double,
    val createdAt: Long,
    val points: List<BallPoint>,
    val live: Boolean = false,
) {
    fun toJson(): JsonObject = mapOf(
        "assetId" to assetId,
        "modelId" to modelId,
        "sourceWidth" to sourceWidth,
        "sourceHeight" to sourceHeight,
        "sampleFps" to sampleFps,
        "duration" to duration,
        "createdAt" to createdAt,
        "points" to points.map { it.toJson() },
        "live" to if (live) true else null,
    )

    companion object {
        fun from(json: JsonObject) = BallTrack(
            assetId = json.str("assetId"),
            modelId = json.str("modelId"),
            sourceWidth = json.num("sourceWidth"),
            sourceHeight = json.num("sourceHeight"),
            sampleFps = json.num("sampleFps"),
            duration = json.num("duration"),
            createdAt = json.long("createdAt"),
            points = json.objects("points").map(BallPoint::from),
            live = json["live"] == true,
        )
    }
}

/** A synced take: every phone in the session starts recording at [startAt] on the server clock. */
data class Take(val id: String, val sessionId: String, val startAt: Long, val seconds: Long, val createdAt: Long, val createdBy: String) {
    companion object {
        fun from(json: JsonObject) = Take(
            json.str("id"),
            json.str("sessionId"),
            json.long("startAt"),
            json.long("seconds"),
            json.long("createdAt"),
            json.optStr("createdBy") ?: "",
        )
    }
}

data class CustomModel(
    val id: String,
    val sessionId: String,
    val name: String,
    val inputSize: Long,
    val labels: List<String>,
    val ballClasses: List<Long>,
    val byteLength: Long,
    val createdAt: Long,
    val fileUrl: String,
) {
    companion object {
        fun from(json: JsonObject) = CustomModel(
            id = json.str("id"),
            sessionId = json.str("sessionId"),
            name = json.str("name"),
            inputSize = json.long("inputSize"),
            labels = json.strings("labels"),
            ballClasses = (json["ballClasses"] as? List<*>)?.map { (it as Number).toLong() } ?: emptyList(),
            byteLength = json.long("byteLength"),
            createdAt = json.long("createdAt"),
            fileUrl = json.str("fileUrl"),
        )
    }
}

/** [locked] is true once the session has a key; [key] is sent once, when it is created or made private. */
data class SessionDetail(
    val id: String,
    val locked: Boolean,
    val key: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val device: Device,
    val assets: List<MediaAsset>,
    val courts: List<CourtCalibration>,
    val ballTracks: List<BallTrack>,
    val models: List<CustomModel>,
) {
    /** The court marked for one phone, or the shared one marked before courts were per phone. */
    fun courtFor(deviceId: String?): CourtCalibration? =
        courts.firstOrNull { (it.deviceId ?: "") == (deviceId ?: "") } ?: courts.firstOrNull { it.deviceId == null }

    companion object {
        fun from(json: JsonObject) = SessionDetail(
            id = json.str("id"),
            locked = json["locked"] == true,
            key = json.optStr("key"),
            createdAt = json.long("createdAt"),
            updatedAt = json.long("updatedAt"),
            device = Device.from(json.obj("device")),
            assets = json.objects("assets").map(MediaAsset::from),
            courts = if (json["courts"] != null) json.objects("courts").map(CourtCalibration::from)
            else listOfNotNull(json.optObj("court")?.let(CourtCalibration::from)),
            ballTracks = json.objects("ballTracks").map(BallTrack::from),
            models = json.objects("models").map(CustomModel::from),
        )
    }
}

enum class ExerciseKind { strength, bodyweight, cardio, timed }

data class Exercise(
    val id: String,
    val name: String,
    val kind: ExerciseKind,
    val muscles: List<String> = emptyList(),
    val equipment: String = "",
    val cue: String = "",
) {
    fun toJson(): JsonObject = mapOf("id" to id, "name" to name, "kind" to kind.name, "muscles" to muscles, "equipment" to equipment, "cue" to cue)

    companion object {
        fun from(json: JsonObject) = Exercise(
            json.str("id"),
            json.str("name"),
            ExerciseKind.valueOf(json.str("kind")),
            json.strings("muscles"),
            json.optStr("equipment") ?: "",
            json.optStr("cue") ?: "",
        )
    }
}

data class WorkoutSet(
    val id: String,
    val reps: Long? = null,
    val weightKg: Double? = null,
    val seconds: Double? = null,
    val meters: Double? = null,
    val rpe: Double? = null,
    val done: Boolean = false,
    val doneAt: Long? = null,
) {
    fun toJson(): JsonObject = mapOf(
        "id" to id, "reps" to reps, "weightKg" to weightKg, "seconds" to seconds,
        "meters" to meters, "rpe" to rpe, "done" to done, "doneAt" to doneAt,
    )

    companion object {
        fun from(json: JsonObject) = WorkoutSet(
            json.str("id"), json.optLong("reps"), json.optNum("weightKg"), json.optNum("seconds"),
            json.optNum("meters"), json.optNum("rpe"), json["done"] == true, json.optLong("doneAt"),
        )
    }
}

data class WorkoutEntry(val id: String, val exerciseId: String, val sets: List<WorkoutSet>, val note: String? = null) {
    fun toJson(): JsonObject = mapOf("id" to id, "exerciseId" to exerciseId, "sets" to sets.map { it.toJson() }, "note" to note)

    companion object {
        fun from(json: JsonObject) = WorkoutEntry(json.str("id"), json.str("exerciseId"), json.objects("sets").map(WorkoutSet::from), json.optStr("note"))
    }
}

/** Bump [updatedAt] on every change: when two phones edit one workout, the newer edit wins. */
data class Workout(
    val id: String,
    val name: String,
    val startedAt: Long,
    val updatedAt: Long,
    val entries: List<WorkoutEntry>,
    val finishedAt: Long? = null,
    val note: String? = null,
) {
    fun toJson(): JsonObject = mapOf(
        "id" to id, "name" to name, "startedAt" to startedAt, "updatedAt" to updatedAt,
        "entries" to entries.map { it.toJson() }, "finishedAt" to finishedAt, "note" to note,
    )

    companion object {
        fun from(json: JsonObject) = Workout(
            json.str("id"), json.str("name"), json.long("startedAt"), json.long("updatedAt"),
            json.objects("entries").map(WorkoutEntry::from), json.optLong("finishedAt"), json.optStr("note"),
        )
    }
}

/** [deleted] lists workouts removed on any phone; drop local copies with those ids. */
data class WorkoutBook(val workouts: List<Workout>, val exercises: List<Exercise>, val deleted: List<String>) {
    companion object {
        fun from(json: JsonObject) = WorkoutBook(
            json.objects("workouts").map(Workout::from),
            json.objects("exercises").map(Exercise::from),
            json.strings("deleted"),
        )
    }
}
