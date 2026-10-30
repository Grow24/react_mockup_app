// Mirrors shared/contracts.ts in the web app. Field names match the JSON the server sends.

double _double(Object? value) => (value as num).toDouble();
double? _optDouble(Object? value) => value == null ? null : (value as num).toDouble();
int _int(Object? value) => (value as num).toInt();
int? _optInt(Object? value) => value == null ? null : (value as num).toInt();
List<T> _list<T>(Object? value, T Function(Map<String, Object?>) read) =>
    ((value as List?) ?? const []).map((item) => read(item as Map<String, Object?>)).toList();

Map<String, Object?> _compact(Map<String, Object?> map) => {
      for (final entry in map.entries)
        if (entry.value != null) entry.key: entry.value,
    };

class Device {
  Device({required this.id, required this.label, required this.userAgent});
  final String id;
  final String label;
  final String userAgent;

  factory Device.fromJson(Map<String, Object?> json) =>
      Device(id: json['id'] as String, label: json['label'] as String? ?? '', userAgent: json['userAgent'] as String? ?? '');
  Map<String, Object?> toJson() => {'id': id, 'label': label, 'userAgent': userAgent};
}

class MediaAsset {
  MediaAsset({
    required this.id,
    required this.sessionId,
    required this.kind,
    required this.mimeType,
    required this.createdAt,
    required this.cameraLabel,
    required this.byteLength,
    required this.fileUrl,
    this.width,
    this.height,
    this.deviceId,
    this.takeId,
    this.startedAt,
  });
  final String id;
  final String sessionId;
  final String kind;
  final String mimeType;
  final int createdAt;
  final String cameraLabel;
  final int byteLength;
  final String fileUrl;
  final int? width;
  final int? height;
  final String? deviceId;
  final String? takeId;
  final int? startedAt;

  bool get isVideo => kind == 'video';

  factory MediaAsset.fromJson(Map<String, Object?> json) => MediaAsset(
        id: json['id'] as String,
        sessionId: json['sessionId'] as String,
        kind: json['kind'] as String,
        mimeType: json['mimeType'] as String,
        createdAt: _int(json['createdAt']),
        cameraLabel: json['cameraLabel'] as String,
        byteLength: _int(json['byteLength']),
        fileUrl: json['fileUrl'] as String,
        width: _optInt(json['width']),
        height: _optInt(json['height']),
        deviceId: json['deviceId'] as String?,
        takeId: json['takeId'] as String?,
        startedAt: _optInt(json['startedAt']),
      );
}

class CourtPoint {
  const CourtPoint(this.x, this.y);
  final double x;
  final double y;
  factory CourtPoint.fromJson(Map<String, Object?> json) => CourtPoint(_double(json['x']), _double(json['y']));
  Map<String, Object?> toJson() => {'x': x, 'y': y};
}

/// Four corners in the photo, in order: near left, near right, far right, far left.
class CourtCalibration {
  CourtCalibration({
    required this.preset,
    required this.assetId,
    required this.sourceWidth,
    required this.sourceHeight,
    required this.imagePoints,
    this.deviceId,
  });
  final String preset;
  final String assetId;
  final double sourceWidth;
  final double sourceHeight;
  final List<CourtPoint> imagePoints;
  final String? deviceId;

  factory CourtCalibration.fromJson(Map<String, Object?> json) => CourtCalibration(
        preset: json['preset'] as String,
        assetId: json['assetId'] as String,
        sourceWidth: _double(json['sourceWidth']),
        sourceHeight: _double(json['sourceHeight']),
        imagePoints: _list(json['imagePoints'], CourtPoint.fromJson),
        deviceId: json['deviceId'] as String?,
      );
  Map<String, Object?> toJson() => _compact({
        'preset': preset,
        'assetId': assetId,
        'sourceWidth': sourceWidth,
        'sourceHeight': sourceHeight,
        'imagePoints': imagePoints.map((point) => point.toJson()).toList(),
        'deviceId': deviceId,
      });
}

class BallPoint {
  BallPoint({required this.t, required this.x, required this.y, required this.radius, required this.score, this.bounce = false});
  final double t;
  final double x;
  final double y;
  final double radius;
  final double score;
  final bool bounce;

  factory BallPoint.fromJson(Map<String, Object?> json) => BallPoint(
        t: _double(json['t']),
        x: _double(json['x']),
        y: _double(json['y']),
        radius: _double(json['radius']),
        score: _double(json['score']),
        bounce: json['bounce'] == true,
      );
  Map<String, Object?> toJson() =>
      {'t': t, 'x': x, 'y': y, 'radius': radius, 'score': score, if (bounce) 'bounce': true};
}

class BallTrack {
  BallTrack({
    required this.assetId,
    required this.modelId,
    required this.sourceWidth,
    required this.sourceHeight,
    required this.sampleFps,
    required this.duration,
    required this.createdAt,
    required this.points,
    this.live = false,
  });
  final String assetId;
  final String modelId;
  final double sourceWidth;
  final double sourceHeight;
  final double sampleFps;
  final double duration;
  final int createdAt;
  final List<BallPoint> points;
  final bool live;

  factory BallTrack.fromJson(Map<String, Object?> json) => BallTrack(
        assetId: json['assetId'] as String,
        modelId: json['modelId'] as String,
        sourceWidth: _double(json['sourceWidth']),
        sourceHeight: _double(json['sourceHeight']),
        sampleFps: _double(json['sampleFps']),
        duration: _double(json['duration']),
        createdAt: _int(json['createdAt']),
        points: _list(json['points'], BallPoint.fromJson),
        live: json['live'] == true,
      );
  Map<String, Object?> toJson() => {
        'assetId': assetId,
        'modelId': modelId,
        'sourceWidth': sourceWidth,
        'sourceHeight': sourceHeight,
        'sampleFps': sampleFps,
        'duration': duration,
        'createdAt': createdAt,
        'points': points.map((point) => point.toJson()).toList(),
        if (live) 'live': true,
      };
}

class Take {
  Take({required this.id, required this.sessionId, required this.startAt, required this.seconds, required this.createdAt, required this.createdBy});
  final String id;
  final String sessionId;

  /// Server clock, milliseconds since the epoch, when every phone starts recording.
  final int startAt;
  final int seconds;
  final int createdAt;
  final String createdBy;

  factory Take.fromJson(Map<String, Object?> json) => Take(
        id: json['id'] as String,
        sessionId: json['sessionId'] as String,
        startAt: _int(json['startAt']),
        seconds: _int(json['seconds']),
        createdAt: _int(json['createdAt']),
        createdBy: json['createdBy'] as String? ?? '',
      );
}

class CustomModel {
  CustomModel({
    required this.id,
    required this.sessionId,
    required this.name,
    required this.inputSize,
    required this.labels,
    required this.ballClasses,
    required this.byteLength,
    required this.createdAt,
    required this.fileUrl,
  });
  final String id;
  final String sessionId;
  final String name;
  final int inputSize;
  final List<String> labels;
  final List<int> ballClasses;
  final int byteLength;
  final int createdAt;
  final String fileUrl;

  factory CustomModel.fromJson(Map<String, Object?> json) => CustomModel(
        id: json['id'] as String,
        sessionId: json['sessionId'] as String,
        name: json['name'] as String,
        inputSize: _int(json['inputSize']),
        labels: ((json['labels'] as List?) ?? const []).cast<String>(),
        ballClasses: ((json['ballClasses'] as List?) ?? const []).map(_int).toList(),
        byteLength: _int(json['byteLength']),
        createdAt: _int(json['createdAt']),
        fileUrl: json['fileUrl'] as String,
      );
}

class SessionDetail {
  SessionDetail({
    required this.id,
    required this.createdAt,
    required this.updatedAt,
    required this.device,
    required this.assets,
    required this.courts,
    required this.ballTracks,
    required this.models,
  });
  final String id;
  final int createdAt;
  final int updatedAt;
  final Device device;
  final List<MediaAsset> assets;
  final List<CourtCalibration> courts;
  final List<BallTrack> ballTracks;
  final List<CustomModel> models;

  /// The court marked for one phone, or the shared one marked before courts were per phone.
  CourtCalibration? courtFor(String? deviceId) {
    for (final court in courts) {
      if ((court.deviceId ?? '') == (deviceId ?? '')) return court;
    }
    for (final court in courts) {
      if (court.deviceId == null) return court;
    }
    return null;
  }

  factory SessionDetail.fromJson(Map<String, Object?> json) => SessionDetail(
        id: json['id'] as String,
        createdAt: _int(json['createdAt']),
        updatedAt: _int(json['updatedAt']),
        device: Device.fromJson(json['device'] as Map<String, Object?>),
        assets: _list(json['assets'], MediaAsset.fromJson),
        courts: json['courts'] != null
            ? _list(json['courts'], CourtCalibration.fromJson)
            : [if (json['court'] != null) CourtCalibration.fromJson(json['court'] as Map<String, Object?>)],
        ballTracks: _list(json['ballTracks'], BallTrack.fromJson),
        models: _list(json['models'], CustomModel.fromJson),
      );
}

enum ExerciseKind { strength, bodyweight, cardio, timed }

class Exercise {
  Exercise({required this.id, required this.name, required this.kind, this.muscles = const [], this.equipment = '', this.cue = ''});
  final String id;
  final String name;
  final ExerciseKind kind;
  final List<String> muscles;
  final String equipment;
  final String cue;

  factory Exercise.fromJson(Map<String, Object?> json) => Exercise(
        id: json['id'] as String,
        name: json['name'] as String,
        kind: ExerciseKind.values.byName(json['kind'] as String),
        muscles: ((json['muscles'] as List?) ?? const []).cast<String>(),
        equipment: json['equipment'] as String? ?? '',
        cue: json['cue'] as String? ?? '',
      );
  Map<String, Object?> toJson() =>
      {'id': id, 'name': name, 'kind': kind.name, 'muscles': muscles, 'equipment': equipment, 'cue': cue};
}

class WorkoutSet {
  WorkoutSet({required this.id, this.reps, this.weightKg, this.seconds, this.meters, this.rpe, this.done = false, this.doneAt});
  final String id;
  final int? reps;
  final double? weightKg;
  final double? seconds;
  final double? meters;
  final double? rpe;
  final bool done;
  final int? doneAt;

  factory WorkoutSet.fromJson(Map<String, Object?> json) => WorkoutSet(
        id: json['id'] as String,
        reps: _optInt(json['reps']),
        weightKg: _optDouble(json['weightKg']),
        seconds: _optDouble(json['seconds']),
        meters: _optDouble(json['meters']),
        rpe: _optDouble(json['rpe']),
        done: json['done'] == true,
        doneAt: _optInt(json['doneAt']),
      );
  Map<String, Object?> toJson() => _compact({
        'id': id,
        'reps': reps,
        'weightKg': weightKg,
        'seconds': seconds,
        'meters': meters,
        'rpe': rpe,
        'done': done,
        'doneAt': doneAt,
      });
}

class WorkoutEntry {
  WorkoutEntry({required this.id, required this.exerciseId, required this.sets, this.note});
  final String id;
  final String exerciseId;
  final List<WorkoutSet> sets;
  final String? note;

  factory WorkoutEntry.fromJson(Map<String, Object?> json) => WorkoutEntry(
        id: json['id'] as String,
        exerciseId: json['exerciseId'] as String,
        sets: _list(json['sets'], WorkoutSet.fromJson),
        note: json['note'] as String?,
      );
  Map<String, Object?> toJson() =>
      _compact({'id': id, 'exerciseId': exerciseId, 'sets': sets.map((set) => set.toJson()).toList(), 'note': note});
}

class Workout {
  Workout({
    required this.id,
    required this.name,
    required this.startedAt,
    required this.updatedAt,
    required this.entries,
    this.finishedAt,
    this.note,
  });
  final String id;
  final String name;
  final int startedAt;

  /// The newer edit wins when two phones change the same workout, so bump this on every change.
  final int updatedAt;
  final List<WorkoutEntry> entries;
  final int? finishedAt;
  final String? note;

  factory Workout.fromJson(Map<String, Object?> json) => Workout(
        id: json['id'] as String,
        name: json['name'] as String,
        startedAt: _int(json['startedAt']),
        updatedAt: _int(json['updatedAt']),
        entries: _list(json['entries'], WorkoutEntry.fromJson),
        finishedAt: _optInt(json['finishedAt']),
        note: json['note'] as String?,
      );
  Map<String, Object?> toJson() => _compact({
        'id': id,
        'name': name,
        'startedAt': startedAt,
        'updatedAt': updatedAt,
        'entries': entries.map((entry) => entry.toJson()).toList(),
        'finishedAt': finishedAt,
        'note': note,
      });
}

class WorkoutBook {
  WorkoutBook({required this.workouts, required this.exercises, required this.deleted});
  final List<Workout> workouts;
  final List<Exercise> exercises;

  /// Ids of workouts deleted on any phone; a local copy with one of these ids should be dropped.
  final List<String> deleted;

  factory WorkoutBook.fromJson(Map<String, Object?> json) => WorkoutBook(
        workouts: _list(json['workouts'], Workout.fromJson),
        exercises: _list(json['exercises'], Exercise.fromJson),
        deleted: ((json['deleted'] as List?) ?? const []).cast<String>(),
      );
}
