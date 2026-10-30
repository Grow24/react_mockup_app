import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct PBMPError: Error, CustomStringConvertible, Sendable {
    public let status: Int
    public let message: String
    public var description: String { "PBMPError(\(status)): \(message)" }
}

/// Add `offsetMs` to the phone's clock to get the server's clock.
public struct ClockSync: Sendable {
    public let offsetMs: Double
    public let roundTripMs: Double
}

private struct ErrorBody: Decodable { let error: String? }
private struct Saved<T: Decodable>: Decodable { let saved: T? }
private struct LatestTake: Decodable { let take: Take? }

/// Talks to a PBMP Camera server, for example `https://reactcamapp.zeabur.app`.
public final class PBMPClient: @unchecked Sendable {
    public let baseURL: URL
    public private(set) var clock: ClockSync?
    /// The key of the session this client works in. `openSession` keeps a new session's key here,
    /// and `unlock` sets it from a shared link. It is sent as X-Session-Key on every request.
    public var sessionKey: String?
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    /// The absolute URL for a path the server returns, such as `MediaAsset.fileUrl`.
    public func resolve(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL)?.absoluteURL ?? baseURL
    }

    private func send(_ method: String, _ path: String, body: Data? = nil, contentType: String = "application/json") async throws -> Data {
        var request = URLRequest(url: path.hasPrefix("http") ? URL(string: path)! : resolve(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let sessionKey { request.setValue(sessionKey, forHTTPHeaderField: "X-Session-Key") }
        if let body {
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status >= 400 {
            let message = (try? decoder.decode(ErrorBody.self, from: data))?.error ?? "Request failed"
            throw PBMPError(status: status, message: message)
        }
        return data
    }

    private func json<T: Decodable>(_ type: T.Type, _ method: String, _ path: String, body: (some Encodable)? = Optional<Int>.none) async throws -> T {
        let data = try await send(method, path, body: try body.map { try encoder.encode($0) })
        return try decoder.decode(T.self, from: data)
    }

    public func health() async -> Bool {
        struct Health: Decodable { let ok: Bool }
        return (try? await json(Health.self, "GET", "/api/health").ok) ?? false
    }

    /// Measures this phone's clock against the server's, keeping the sample with the shortest round trip.
    @discardableResult
    public func syncClock(samples: Int = 6) async throws -> ClockSync {
        struct Now: Decodable { let now: Double }
        var best: ClockSync?
        for _ in 0..<samples {
            let sent = Date().timeIntervalSince1970 * 1000
            let now = try await json(Now.self, "GET", "/api/time").now
            let received = Date().timeIntervalSince1970 * 1000
            let sample = ClockSync(offsetMs: now - (sent + received) / 2, roundTripMs: received - sent)
            if best == nil || sample.roundTripMs < best!.roundTripMs { best = sample }
        }
        clock = best
        return best!
    }

    public func serverNow() -> Int {
        Int((Date().timeIntervalSince1970 * 1000 + (clock?.offsetMs ?? 0)).rounded())
    }

    public func openSession(id: String, device: Device) async throws -> SessionDetail {
        struct Open: Encodable { let id: String; let device: Device }
        let session = try await json(SessionDetail.self, "POST", "/api/sessions", body: Open(id: id, device: device))
        if let key = session.key { sessionKey = key }
        return session
    }

    /// Opens a shared session with the key from its link, for example `?session=...&key=...`.
    public func unlock(id: String, key: String) async throws -> SessionDetail? {
        struct Unlock: Encodable { let key: String }
        do {
            let session = try await json(SessionDetail.self, "POST", "/api/sessions/\(id)/unlock", body: Unlock(key: key))
            sessionKey = key
            return session
        } catch let error as PBMPError where error.status == 404 {
            return nil
        }
    }

    /// Returns nil when no session has this id.
    public func session(id: String) async throws -> SessionDetail? {
        do {
            return try await json(SessionDetail.self, "GET", "/api/sessions/\(id)")
        } catch let error as PBMPError where error.status == 404 {
            return nil
        }
    }

    public func uploadAsset(
        sessionId: String,
        data: Data,
        kind: String,
        mimeType: String,
        cameraLabel: String,
        id: String = UUID().uuidString.lowercased(),
        width: Int? = nil,
        height: Int? = nil,
        deviceId: String? = nil,
        takeId: String? = nil,
        startedAt: Int? = nil
    ) async throws -> SessionDetail {
        struct Meta: Encodable {
            let id: String, kind: String, mimeType: String, createdAt: Int, cameraLabel: String
            let width: Int?, height: Int?, deviceId: String?, takeId: String?, startedAt: Int?
        }
        let meta = Meta(id: id, kind: kind, mimeType: mimeType, createdAt: Int(Date().timeIntervalSince1970 * 1000),
                        cameraLabel: cameraLabel, width: width, height: height, deviceId: deviceId, takeId: takeId, startedAt: startedAt)
        let boundary = "pbmp-\(UUID().uuidString)"
        var form = Data()
        func line(_ text: String) { form.append(Data((text + "\r\n").utf8)) }
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"meta\"")
        line("")
        line(String(decoding: try encoder.encode(meta), as: UTF8.self))
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"file\"; filename=\"\(kind == "video" ? "video.webm" : "photo.jpg")\"")
        line("Content-Type: \(mimeType)")
        line("")
        form.append(data)
        line("")
        line("--\(boundary)--")
        let reply = try await send("POST", "/api/sessions/\(sessionId)/assets", body: form, contentType: "multipart/form-data; boundary=\(boundary)")
        return try decoder.decode(SessionDetail.self, from: reply)
    }

    public func deleteAsset(id: String) async throws {
        _ = try await send("DELETE", "/api/assets/\(id)")
    }

    public func download(_ path: String) async throws -> Data {
        try await send("GET", resolve(path).absoluteString)
    }

    public func saveCourt(sessionId: String, court: CourtCalibration) async throws -> SessionDetail {
        try await json(SessionDetail.self, "PUT", "/api/sessions/\(sessionId)/court", body: court)
    }

    public func clearCourt(sessionId: String, deviceId: String = "") async throws -> SessionDetail {
        let query = deviceId.isEmpty ? "" : "?device=\(deviceId)"
        return try await json(SessionDetail.self, "DELETE", "/api/sessions/\(sessionId)/court\(query)")
    }

    public func saveBallTrack(_ track: BallTrack) async throws -> SessionDetail {
        try await json(SessionDetail.self, "PUT", "/api/assets/\(track.assetId)/ball-track", body: track)
    }

    public func clearBallTrack(assetId: String) async throws {
        _ = try await send("DELETE", "/api/assets/\(assetId)/ball-track")
    }

    public func createTake(sessionId: String, seconds: Int, deviceId: String? = nil) async throws -> Take {
        struct Create: Encodable { let seconds: Int; let deviceId: String? }
        return try await json(Take.self, "POST", "/api/sessions/\(sessionId)/takes", body: Create(seconds: seconds, deviceId: deviceId))
    }

    public func latestTake(sessionId: String) async throws -> Take? {
        try await json(LatestTake.self, "GET", "/api/sessions/\(sessionId)/takes/latest").take
    }

    public func workoutBook(sessionId: String) async throws -> WorkoutBook {
        try await json(WorkoutBook.self, "GET", "/api/sessions/\(sessionId)/workouts")
    }

    /// Returns the stored workout: this one, a newer edit from another phone, or nil if it was deleted.
    public func saveWorkout(sessionId: String, _ workout: Workout) async throws -> Workout? {
        try await json(Saved<Workout>.self, "PUT", "/api/sessions/\(sessionId)/workouts/\(workout.id)", body: workout).saved
    }

    public func deleteWorkout(sessionId: String, id: String) async throws {
        _ = try await send("DELETE", "/api/sessions/\(sessionId)/workouts/\(id)")
    }

    public func saveExercise(sessionId: String, _ exercise: Exercise) async throws -> Exercise {
        guard let saved = try await json(Saved<Exercise>.self, "PUT", "/api/sessions/\(sessionId)/exercises/\(exercise.id)", body: exercise).saved else {
            throw PBMPError(status: 500, message: "The exercise was not saved.")
        }
        return saved
    }

    public func deleteExercise(sessionId: String, id: String) async throws {
        _ = try await send("DELETE", "/api/sessions/\(sessionId)/exercises/\(id)")
    }

    /// The ONNX file of a custom model, to run with ONNX Runtime or convert to Core ML.
    public func downloadModel(_ model: CustomModel) async throws -> Data {
        try await download(model.fileUrl)
    }
}
