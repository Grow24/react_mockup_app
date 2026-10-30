import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'models.dart';

class PbmpException implements Exception {
  PbmpException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => 'PbmpException($status): $message';
}

class ClockSync {
  ClockSync(this.offsetMs, this.roundTripMs);

  /// Add this to the phone's clock to get the server's clock.
  final double offsetMs;
  final double roundTripMs;
}

/// Talks to a PBMP Camera server, for example `https://reactcamapp.zeabur.app`.
class PbmpClient {
  PbmpClient(String baseUrl, {http.Client? httpClient})
      : baseUrl = Uri.parse(baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl),
        _http = httpClient ?? http.Client();

  final Uri baseUrl;
  final http.Client _http;
  ClockSync? clock;

  /// The key of the session this client works in. [openSession] keeps a new session's key here,
  /// and [unlock] sets it from a shared link. It is sent as X-Session-Key on every request.
  String? sessionKey;

  Map<String, String> get _keyHeader => sessionKey == null ? const {} : {'X-Session-Key': sessionKey!};

  Uri _uri(String path, [Map<String, String>? query]) =>
      baseUrl.replace(path: '${baseUrl.path}$path', queryParameters: query);

  /// The absolute URL for a path the server returns, such as `MediaAsset.fileUrl`.
  Uri resolve(String path) => baseUrl.resolve(path);

  Future<Object?> _json(Future<http.Response> request) async {
    final response = await request;
    final body = response.body.isEmpty ? null : jsonDecode(utf8.decode(response.bodyBytes));
    if (response.statusCode >= 400) {
      final message = body is Map && body['error'] is String ? body['error'] as String : response.reasonPhrase ?? 'Request failed';
      throw PbmpException(response.statusCode, message);
    }
    return body;
  }

  Future<Object?> _send(String method, String path, [Object? body]) {
    final request = http.Request(method, _uri(path))..headers.addAll(_keyHeader);
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    return _json(_http.send(request).then(http.Response.fromStream));
  }

  void close() => _http.close();

  Future<bool> health() async {
    try {
      final body = await _json(_http.get(_uri('/api/health')));
      return body is Map && body['ok'] == true;
    } on Exception {
      return false;
    }
  }

  /// Measures this phone's clock against the server's, keeping the sample with the shortest round trip.
  Future<ClockSync> syncClock({int samples = 6}) async {
    ClockSync? best;
    for (var index = 0; index < samples; index += 1) {
      final sent = DateTime.now().millisecondsSinceEpoch;
      final body = await _json(_http.get(_uri('/api/time'))) as Map<String, Object?>;
      final received = DateTime.now().millisecondsSinceEpoch;
      final sample = ClockSync((body['now'] as num) - (sent + received) / 2, (received - sent).toDouble());
      if (best == null || sample.roundTripMs < best.roundTripMs) best = sample;
    }
    return clock = best!;
  }

  int serverNow() => DateTime.now().millisecondsSinceEpoch + (clock?.offsetMs.round() ?? 0);

  Future<SessionDetail> openSession(String id, Device device) async {
    final session = SessionDetail.fromJson(await _send('POST', '/api/sessions', {'id': id, 'device': device.toJson()}) as Map<String, Object?>);
    if (session.key != null) sessionKey = session.key;
    return session;
  }

  /// Opens a shared session with the key from its link, for example `?session=...&key=...`.
  Future<SessionDetail?> unlock(String id, String key) async {
    try {
      final session = SessionDetail.fromJson(await _send('POST', '/api/sessions/$id/unlock', {'key': key}) as Map<String, Object?>);
      sessionKey = key;
      return session;
    } on PbmpException catch (error) {
      if (error.status == 404) return null;
      rethrow;
    }
  }

  /// Returns null when no session has this id.
  Future<SessionDetail?> getSession(String id) async {
    try {
      return SessionDetail.fromJson(await _send('GET', '/api/sessions/$id') as Map<String, Object?>);
    } on PbmpException catch (error) {
      if (error.status == 404) return null;
      rethrow;
    }
  }

  Future<SessionDetail> uploadAsset(
    String sessionId, {
    required String id,
    required String kind,
    required String mimeType,
    required Uint8List bytes,
    required String cameraLabel,
    int? createdAt,
    int? width,
    int? height,
    String? deviceId,
    String? takeId,
    int? startedAt,
  }) async {
    final request = http.MultipartRequest('POST', _uri('/api/sessions/$sessionId/assets'))
      ..headers.addAll(_keyHeader)
      ..fields['meta'] = jsonEncode({
        'id': id,
        'kind': kind,
        'mimeType': mimeType,
        'createdAt': createdAt ?? DateTime.now().millisecondsSinceEpoch,
        'cameraLabel': cameraLabel,
        'snapshot': null,
        if (width != null) 'width': width,
        if (height != null) 'height': height,
        if (deviceId != null) 'deviceId': deviceId,
        if (takeId != null) 'takeId': takeId,
        if (startedAt != null) 'startedAt': startedAt,
      })
      ..files.add(http.MultipartFile.fromBytes('file', bytes, filename: kind == 'video' ? 'video.webm' : 'photo.jpg'));
    return SessionDetail.fromJson(await _json(_http.send(request).then(http.Response.fromStream)) as Map<String, Object?>);
  }

  Future<void> deleteAsset(String id) => _send('DELETE', '/api/assets/$id');

  Future<Uint8List> download(String path) async {
    final response = await _http.get(resolve(path), headers: _keyHeader);
    if (response.statusCode >= 400) throw PbmpException(response.statusCode, 'Download failed');
    return response.bodyBytes;
  }

  Future<SessionDetail> saveCourt(String sessionId, CourtCalibration court) async =>
      SessionDetail.fromJson(await _send('PUT', '/api/sessions/$sessionId/court', court.toJson()) as Map<String, Object?>);

  Future<SessionDetail> clearCourt(String sessionId, {String deviceId = ''}) async {
    final query = deviceId.isEmpty ? '' : '?device=${Uri.encodeQueryComponent(deviceId)}';
    return SessionDetail.fromJson(await _send('DELETE', '/api/sessions/$sessionId/court$query') as Map<String, Object?>);
  }

  Future<SessionDetail> saveBallTrack(BallTrack track) async =>
      SessionDetail.fromJson(await _send('PUT', '/api/assets/${track.assetId}/ball-track', track.toJson()) as Map<String, Object?>);

  Future<void> clearBallTrack(String assetId) => _send('DELETE', '/api/assets/$assetId/ball-track');

  /// Schedules a synced take; every phone in the session starts recording at `Take.startAt` server time.
  Future<Take> createTake(String sessionId, int seconds, {String? deviceId}) async =>
      Take.fromJson(await _send('POST', '/api/sessions/$sessionId/takes', {'seconds': seconds, if (deviceId != null) 'deviceId': deviceId}) as Map<String, Object?>);

  Future<Take?> latestTake(String sessionId) async {
    final body = await _send('GET', '/api/sessions/$sessionId/takes/latest') as Map<String, Object?>;
    final take = body['take'];
    return take == null ? null : Take.fromJson(take as Map<String, Object?>);
  }

  Future<WorkoutBook> workoutBook(String sessionId) async =>
      WorkoutBook.fromJson(await _send('GET', '/api/sessions/$sessionId/workouts') as Map<String, Object?>);

  /// Returns the stored workout: this one, a newer edit from another phone, or null if it was deleted.
  Future<Workout?> saveWorkout(String sessionId, Workout workout) async {
    final body = await _send('PUT', '/api/sessions/$sessionId/workouts/${workout.id}', workout.toJson()) as Map<String, Object?>;
    final saved = body['saved'];
    return saved == null ? null : Workout.fromJson(saved as Map<String, Object?>);
  }

  Future<void> deleteWorkout(String sessionId, String id) => _send('DELETE', '/api/sessions/$sessionId/workouts/$id');

  Future<Exercise> saveExercise(String sessionId, Exercise exercise) async {
    final body = await _send('PUT', '/api/sessions/$sessionId/exercises/${exercise.id}', exercise.toJson()) as Map<String, Object?>;
    return Exercise.fromJson(body['saved'] as Map<String, Object?>);
  }

  Future<void> deleteExercise(String sessionId, String id) => _send('DELETE', '/api/sessions/$sessionId/exercises/$id');

  /// The ONNX file of a custom model, to run with an on-device runtime.
  Future<Uint8List> downloadModel(CustomModel model) => download(model.fileUrl);
}
