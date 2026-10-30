import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import PBMPClient

final class ClientTests: XCTestCase {
    private let baseURL = URL(string: ProcessInfo.processInfo.environment["PBMP_BASE_URL"] ?? "http://127.0.0.1:8787")!

    private func uuid() -> String { UUID().uuidString.lowercased() }

    func testOneRepMaxMatchesTheWebApp() {
        XCTAssertEqual(OneRepMax.estimate(100, 5)!, 115.543, accuracy: 0.01)
        XCTAssertNil(OneRepMax.estimate(100, 13))
    }

    func testWorkoutJSONLeavesEmptyFieldsOut() throws {
        let workout = Workout(id: uuid(), name: "Legs", startedAt: 1, updatedAt: 2, entries: [
            WorkoutEntry(id: "e1", exerciseId: "back-squat", sets: [WorkoutSet(id: "s1", reps: 5, weightKg: 100, done: true)]),
        ])
        let text = String(decoding: try JSONEncoder().encode(workout), as: UTF8.self)
        XCTAssertFalse(text.contains("finishedAt"))
        XCTAssertEqual(try JSONDecoder().decode(Workout.self, from: Data(text.utf8)), workout)
    }

    func testAgainstTheServer() async throws {
        let client = PBMPClient(baseURL: baseURL)
        guard await client.health() else { throw XCTSkip("No PBMP server at \(baseURL)") }
        let sessionId = uuid()
        let deviceId = uuid()
        let clock = try await client.syncClock()
        XCTAssertLessThan(clock.roundTripMs, 2000)
        let opened = try await client.openSession(id: sessionId, device: Device(id: deviceId, label: "Swift test"))
        XCTAssertEqual(opened.id, sessionId)
        XCTAssertTrue(opened.locked)
        let key = try XCTUnwrap(client.sessionKey)
        // A separate cookie store, so the first client's key cookie does not travel along.
        let stranger = PBMPClient(baseURL: baseURL, session: URLSession(configuration: .ephemeral))
        do {
            _ = try await stranger.session(id: sessionId)
            XCTFail("a client without the key is refused")
        } catch let error as PBMPError {
            XCTAssertEqual(error.status, 403)
        }
        let shared = try await stranger.unlock(id: sessionId, key: key)
        XCTAssertEqual(shared?.id, sessionId)
        let missing = try await client.session(id: uuid())
        XCTAssertNil(missing)

        let bytes = Data((0..<2048).map { UInt8($0 % 251) })
        let assetId = uuid()
        let uploaded = try await client.uploadAsset(sessionId: sessionId, data: bytes, kind: "video", mimeType: "video/webm",
                                                    cameraLabel: "Swift camera", id: assetId, width: 640, height: 360,
                                                    deviceId: deviceId, startedAt: client.serverNow())
        let asset = try XCTUnwrap(uploaded.assets.first)
        XCTAssertEqual(asset.deviceId, deviceId)
        let downloaded = try await client.download(asset.fileUrl)
        XCTAssertEqual(downloaded, bytes)

        let court = CourtCalibration(preset: "tennis-doubles", assetId: assetId, sourceWidth: 640, sourceHeight: 360,
                                     imagePoints: [CourtPoint(x: 49, y: 324), CourtPoint(x: 551, y: 338), CourtPoint(x: 407, y: 134), CourtPoint(x: 250, y: 132)],
                                     deviceId: deviceId)
        let withCourt = try await client.saveCourt(sessionId: sessionId, court: court)
        XCTAssertEqual(withCourt.court(for: deviceId)?.imagePoints.count, 4)

        let track = BallTrack(assetId: assetId, modelId: "yolov8n-coco-onnx", sourceWidth: 640, sourceHeight: 360, sampleFps: 10, duration: 0.2,
                              createdAt: client.serverNow(),
                              points: [BallPoint(t: 0, x: 100, y: 100, radius: 8, score: 0.8), BallPoint(t: 0.1, x: 110, y: 120, radius: 8, score: 0.7, bounce: true)])
        let withTrack = try await client.saveBallTrack(track)
        XCTAssertEqual(withTrack.ballTracks.first?.points.last?.bounce, true)

        let take = try await client.createTake(sessionId: sessionId, seconds: 5, deviceId: deviceId)
        XCTAssertTrue((1500...3000).contains(take.startAt - client.serverNow()))
        let latest = try await client.latestTake(sessionId: sessionId)
        XCTAssertEqual(latest?.id, take.id)

        let workoutId = uuid()
        func version(_ name: String, _ updatedAt: Int) -> Workout {
            Workout(id: workoutId, name: name, startedAt: 1000, updatedAt: updatedAt, entries: [
                WorkoutEntry(id: "e1", exerciseId: "deadlift", sets: [WorkoutSet(id: "s1", reps: 3, weightKg: 140, done: true)]),
            ])
        }
        let first = try await client.saveWorkout(sessionId: sessionId, version("Pull day", 2000))
        XCTAssertEqual(first?.name, "Pull day")
        let stale = try await client.saveWorkout(sessionId: sessionId, version("Stale copy", 1500))
        XCTAssertEqual(stale?.name, "Pull day", "the newer edit wins")
        let exercise = Exercise(id: uuid(), name: "Serve practice", kind: .timed, muscles: ["shoulders"])
        let savedExercise = try await client.saveExercise(sessionId: sessionId, exercise)
        XCTAssertEqual(savedExercise.kind, .timed)
        try await client.deleteWorkout(sessionId: sessionId, id: workoutId)
        let revived = try await client.saveWorkout(sessionId: sessionId, version("Back again", 99_999_999_999_999))
        XCTAssertNil(revived, "a deletion stays deleted")
        try await client.deleteExercise(sessionId: sessionId, id: exercise.id)
        let book = try await client.workoutBook(sessionId: sessionId)
        XCTAssertTrue(book.workouts.isEmpty && book.exercises.isEmpty && book.deleted.contains(workoutId))

        try await client.deleteAsset(id: assetId)
        let after = try await client.session(id: sessionId)
        XCTAssertEqual(after?.assets.count, 0)
    }
}
