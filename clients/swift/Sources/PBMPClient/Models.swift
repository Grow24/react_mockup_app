import Foundation

// Mirrors shared/contracts.ts in the web app. Field names match the JSON the server sends.

public struct Device: Codable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var userAgent: String

    public init(id: String, label: String, userAgent: String = "") {
        self.id = id
        self.label = label
        self.userAgent = userAgent
    }
}

public struct MediaAsset: Codable, Equatable, Sendable {
    public var id: String
    public var sessionId: String
    public var kind: String
    public var mimeType: String
    public var createdAt: Int
    public var cameraLabel: String
    public var byteLength: Int
    public var fileUrl: String
    public var width: Int?
    public var height: Int?
    public var deviceId: String?
    public var takeId: String?
    public var startedAt: Int?

    public var isVideo: Bool { kind == "video" }
}

public struct CourtPoint: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// Four corners in the photo, in order: near left, near right, far right, far left.
public struct CourtCalibration: Codable, Equatable, Sendable {
    public var preset: String
    public var assetId: String
    public var sourceWidth: Double
    public var sourceHeight: Double
    public var imagePoints: [CourtPoint]
    public var deviceId: String?

    public init(preset: String, assetId: String, sourceWidth: Double, sourceHeight: Double, imagePoints: [CourtPoint], deviceId: String? = nil) {
        self.preset = preset
        self.assetId = assetId
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
        self.imagePoints = imagePoints
        self.deviceId = deviceId
    }
}

public struct BallPoint: Codable, Equatable, Sendable {
    public var t: Double
    public var x: Double
    public var y: Double
    public var radius: Double
    public var score: Double
    public var bounce: Bool?

    public init(t: Double, x: Double, y: Double, radius: Double, score: Double, bounce: Bool = false) {
        self.t = t
        self.x = x
        self.y = y
        self.radius = radius
        self.score = score
        self.bounce = bounce ? true : nil
    }
}

public struct BallTrack: Codable, Equatable, Sendable {
    public var assetId: String
    public var modelId: String
    public var sourceWidth: Double
    public var sourceHeight: Double
    public var sampleFps: Double
    public var duration: Double
    public var createdAt: Int
    public var points: [BallPoint]
    public var live: Bool?

    public init(assetId: String, modelId: String, sourceWidth: Double, sourceHeight: Double, sampleFps: Double, duration: Double, createdAt: Int, points: [BallPoint], live: Bool = false) {
        self.assetId = assetId
        self.modelId = modelId
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
        self.sampleFps = sampleFps
        self.duration = duration
        self.createdAt = createdAt
        self.points = points
        self.live = live ? true : nil
    }
}

/// A synced take: every phone in the session starts recording at `startAt` on the server clock.
public struct Take: Codable, Equatable, Sendable {
    public var id: String
    public var sessionId: String
    public var startAt: Int
    public var seconds: Int
    public var createdAt: Int
    public var createdBy: String
}

public struct CustomModel: Codable, Equatable, Sendable {
    public var id: String
    public var sessionId: String
    public var name: String
    public var inputSize: Int
    public var labels: [String]
    public var ballClasses: [Int]
    public var byteLength: Int
    public var createdAt: Int
    public var fileUrl: String
}

public struct SessionDetail: Decodable, Sendable {
    public var id: String
    /// True once the session has a key; without it nothing in the session can be read or changed.
    public var locked: Bool
    /// Sent once, when the session is created or made private.
    public var key: String?
    public var createdAt: Int
    public var updatedAt: Int
    public var device: Device
    public var assets: [MediaAsset]
    public var courts: [CourtCalibration]
    public var ballTracks: [BallTrack]
    public var models: [CustomModel]

    enum CodingKeys: String, CodingKey {
        case id, locked, key, createdAt, updatedAt, device, assets, court, courts, ballTracks, models
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        locked = try container.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        key = try container.decodeIfPresent(String.self, forKey: .key)
        createdAt = try container.decode(Int.self, forKey: .createdAt)
        updatedAt = try container.decode(Int.self, forKey: .updatedAt)
        device = try container.decode(Device.self, forKey: .device)
        assets = try container.decodeIfPresent([MediaAsset].self, forKey: .assets) ?? []
        if let list = try container.decodeIfPresent([CourtCalibration].self, forKey: .courts) {
            courts = list
        } else if let single = try container.decodeIfPresent(CourtCalibration.self, forKey: .court) {
            courts = [single]
        } else {
            courts = []
        }
        ballTracks = try container.decodeIfPresent([BallTrack].self, forKey: .ballTracks) ?? []
        models = try container.decodeIfPresent([CustomModel].self, forKey: .models) ?? []
    }

    /// The court marked for one phone, or the shared one marked before courts were per phone.
    public func court(for deviceId: String?) -> CourtCalibration? {
        courts.first { ($0.deviceId ?? "") == (deviceId ?? "") } ?? courts.first { $0.deviceId == nil }
    }
}

public enum ExerciseKind: String, Codable, Sendable {
    case strength, bodyweight, cardio, timed
}

public struct Exercise: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var kind: ExerciseKind
    public var muscles: [String]
    public var equipment: String
    public var cue: String

    public init(id: String, name: String, kind: ExerciseKind, muscles: [String] = [], equipment: String = "", cue: String = "") {
        self.id = id
        self.name = name
        self.kind = kind
        self.muscles = muscles
        self.equipment = equipment
        self.cue = cue
    }
}

public struct WorkoutSet: Codable, Equatable, Sendable {
    public var id: String
    public var reps: Int?
    public var weightKg: Double?
    public var seconds: Double?
    public var meters: Double?
    public var rpe: Double?
    public var done: Bool
    public var doneAt: Int?

    public init(id: String, reps: Int? = nil, weightKg: Double? = nil, seconds: Double? = nil, meters: Double? = nil, rpe: Double? = nil, done: Bool = false, doneAt: Int? = nil) {
        self.id = id
        self.reps = reps
        self.weightKg = weightKg
        self.seconds = seconds
        self.meters = meters
        self.rpe = rpe
        self.done = done
        self.doneAt = doneAt
    }
}

public struct WorkoutEntry: Codable, Equatable, Sendable {
    public var id: String
    public var exerciseId: String
    public var sets: [WorkoutSet]
    public var note: String?

    public init(id: String, exerciseId: String, sets: [WorkoutSet], note: String? = nil) {
        self.id = id
        self.exerciseId = exerciseId
        self.sets = sets
        self.note = note
    }
}

/// Bump `updatedAt` on every change: when two phones edit one workout, the newer edit wins.
public struct Workout: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var startedAt: Int
    public var updatedAt: Int
    public var entries: [WorkoutEntry]
    public var finishedAt: Int?
    public var note: String?

    public init(id: String, name: String, startedAt: Int, updatedAt: Int, entries: [WorkoutEntry], finishedAt: Int? = nil, note: String? = nil) {
        self.id = id
        self.name = name
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.entries = entries
        self.finishedAt = finishedAt
        self.note = note
    }
}

/// `deleted` lists workouts removed on any phone; drop local copies with those ids.
public struct WorkoutBook: Decodable, Sendable {
    public var workouts: [Workout]
    public var exercises: [Exercise]
    public var deleted: [String]
}
