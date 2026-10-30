import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:pbmp_client/pbmp_client.dart';
import 'package:test/test.dart';

String uuid() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

void main() {
  final baseUrl = Platform.environment['PBMP_BASE_URL'] ?? 'http://127.0.0.1:8787';
  final client = PbmpClient(baseUrl);
  final sessionId = uuid();
  final deviceId = uuid();
  late bool online;

  setUpAll(() async => online = await client.health());
  tearDownAll(client.close);

  test('one-rep max matches the web app', () {
    expect(estimateOneRepMax(100, 5), closeTo(115.543, 0.01));
    expect(estimateOneRepMax(100, 1), 100);
    expect(estimateOneRepMax(100, 13), isNull);
  });

  test('a workout survives a JSON round trip', () {
    final workout = Workout(id: uuid(), name: 'Legs', startedAt: 1, updatedAt: 2, entries: [
      WorkoutEntry(id: 'e1', exerciseId: 'back-squat', sets: [WorkoutSet(id: 's1', reps: 5, weightKg: 100, done: true, doneAt: 3)]),
    ]);
    final back = Workout.fromJson(workout.toJson());
    expect(back.entries.single.sets.single.weightKg, 100);
    expect(workout.toJson()['finishedAt'], isNull, reason: 'empty fields are left out, as the server expects');
  });

  group('against the server', () {
    test('clock, session, and media', () async {
      if (!online) return markTestSkipped('No PBMP server at $baseUrl');
      final clock = await client.syncClock();
      expect(clock.roundTripMs, lessThan(2000));
      final session = await client.openSession(sessionId, Device(id: deviceId, label: 'Dart test', userAgent: 'dart'));
      expect(session.id, sessionId);
      expect(session.locked, isTrue);
      final key = client.sessionKey!;
      final stranger = PbmpClient(baseUrl);
      await expectLater(stranger.getSession(sessionId), throwsA(isA<PbmpException>().having((error) => error.status, 'status', 403)));
      expect((await stranger.unlock(sessionId, key))?.id, sessionId);
      stranger.close();
      expect(await client.getSession(uuid()), isNull);

      final bytes = Uint8List.fromList(List<int>.generate(2048, (index) => index % 251));
      final assetId = uuid();
      final uploaded = await client.uploadAsset(sessionId,
          id: assetId, kind: 'video', mimeType: 'video/webm', bytes: bytes, cameraLabel: 'Dart camera', width: 640, height: 360, deviceId: deviceId, startedAt: client.serverNow());
      final asset = uploaded.assets.single;
      expect(asset.deviceId, deviceId);
      expect(await client.download(asset.fileUrl), bytes);

      final court = CourtCalibration(
        preset: 'tennis-doubles',
        assetId: assetId,
        sourceWidth: 640,
        sourceHeight: 360,
        imagePoints: const [CourtPoint(49, 324), CourtPoint(551, 338), CourtPoint(407, 134), CourtPoint(250, 132)],
        deviceId: deviceId,
      );
      final withCourt = await client.saveCourt(sessionId, court);
      expect(withCourt.courtFor(deviceId)?.imagePoints.length, 4);

      final track = BallTrack(
        assetId: assetId,
        modelId: 'yolov8n-coco-onnx',
        sourceWidth: 640,
        sourceHeight: 360,
        sampleFps: 10,
        duration: 0.2,
        createdAt: DateTime.now().millisecondsSinceEpoch,
        points: [BallPoint(t: 0, x: 100, y: 100, radius: 8, score: 0.8), BallPoint(t: 0.1, x: 110, y: 120, radius: 8, score: 0.7, bounce: true)],
      );
      final withTrack = await client.saveBallTrack(track);
      expect(withTrack.ballTracks.single.points.last.bounce, isTrue);

      final take = await client.createTake(sessionId, 5, deviceId: deviceId);
      expect(take.startAt - client.serverNow(), inInclusiveRange(1500, 3000));
      expect((await client.latestTake(sessionId))?.id, take.id);

      await client.deleteAsset(assetId);
      expect((await client.getSession(sessionId))!.assets, isEmpty);
    });

    test('workouts sync like the web app', () async {
      if (!online) return markTestSkipped('No PBMP server at $baseUrl');
      await client.openSession(sessionId, Device(id: deviceId, label: 'Dart test', userAgent: 'dart'));
      final id = uuid();
      Workout version(String name, int updatedAt) => Workout(id: id, name: name, startedAt: 1000, updatedAt: updatedAt, entries: [
            WorkoutEntry(id: 'e1', exerciseId: 'deadlift', sets: [WorkoutSet(id: 's1', reps: 3, weightKg: 140, done: true)]),
          ]);
      expect((await client.saveWorkout(sessionId, version('Pull day', 2000)))?.name, 'Pull day');
      expect((await client.saveWorkout(sessionId, version('Stale copy', 1500)))?.name, 'Pull day', reason: 'the newer edit wins');

      final exercise = Exercise(id: uuid(), name: 'Serve practice', kind: ExerciseKind.timed, muscles: ['shoulders']);
      expect((await client.saveExercise(sessionId, exercise)).kind, ExerciseKind.timed);
      var book = await client.workoutBook(sessionId);
      expect(book.workouts.single.entries.single.sets.single.weightKg, 140);
      expect(book.exercises.single.name, 'Serve practice');

      await client.deleteWorkout(sessionId, id);
      expect(await client.saveWorkout(sessionId, version('Back again', 99999999999999)), isNull, reason: 'a deletion stays deleted');
      await client.deleteExercise(sessionId, exercise.id);
      book = await client.workoutBook(sessionId);
      expect(book.workouts, isEmpty);
      expect(book.deleted, contains(id));
      expect(book.exercises, isEmpty);
    });
  });
}
