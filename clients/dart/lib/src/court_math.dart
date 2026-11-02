// The court geometry from shared/court.ts in the web app: landmarks, the areas a bounce is called
// against, and the image-to-court mapping from four marked points.

import 'models.dart';

class CourtSize {
  const CourtSize(this.widthMeters, this.lengthMeters);
  final double widthMeters;
  final double lengthMeters;
}

const courtSizes = {
  'tennis-doubles': CourtSize(10.97, 23.77),
  'cricket-pitch': CourtSize(3.05, 20.12),
};

class CourtArea {
  const CourtArea(this.id, this.label, this.x0, this.y0, this.x1, this.y1);
  final String id;
  final String label;
  final double x0;
  final double y0;
  final double x1;
  final double y1;
}

const _w = 10.97;
const _l = 23.77;
const _singlesLeft = 1.37;
const _singlesRight = _w - 1.37;
const _centerX = _w / 2;
const _netY = _l / 2;
const _serviceNear = _netY - 6.4;
const _serviceFar = _netY + 6.4;

const _pw = 3.05;
const _pl = 20.12;
const _stumpsX = _pw / 2;
const _returnLeft = _stumpsX - 1.32;
const _returnRight = _stumpsX + 1.32;
const _poppingNear = 1.22;
const _poppingFar = _pl - 1.22;

/// Every point a court can be marked by, in court meters: x from the left doubles (or pitch) line,
/// y from the near line, as seen from the near end.
const courtLandmarks = <String, Map<String, CourtPoint>>{
  'tennis-doubles': {
    'doubles-near-left': CourtPoint(0, 0),
    'doubles-near-right': CourtPoint(_w, 0),
    'doubles-far-right': CourtPoint(_w, _l),
    'doubles-far-left': CourtPoint(0, _l),
    'singles-near-left': CourtPoint(_singlesLeft, 0),
    'singles-near-right': CourtPoint(_singlesRight, 0),
    'singles-far-right': CourtPoint(_singlesRight, _l),
    'singles-far-left': CourtPoint(_singlesLeft, _l),
    'service-near-left': CourtPoint(_singlesLeft, _serviceNear),
    'service-near-right': CourtPoint(_singlesRight, _serviceNear),
    'service-far-right': CourtPoint(_singlesRight, _serviceFar),
    'service-far-left': CourtPoint(_singlesLeft, _serviceFar),
    'tee-near': CourtPoint(_centerX, _serviceNear),
    'tee-far': CourtPoint(_centerX, _serviceFar),
    'center-mark-near': CourtPoint(_centerX, 0),
    'center-mark-far': CourtPoint(_centerX, _l),
  },
  'cricket-pitch': {
    'pitch-near-left': CourtPoint(0, 0),
    'pitch-near-right': CourtPoint(_pw, 0),
    'pitch-far-right': CourtPoint(_pw, _pl),
    'pitch-far-left': CourtPoint(0, _pl),
    'stumps-near': CourtPoint(_stumpsX, 0),
    'stumps-far': CourtPoint(_stumpsX, _pl),
    'bowling-near-left': CourtPoint(_returnLeft, 0),
    'bowling-near-right': CourtPoint(_returnRight, 0),
    'bowling-far-right': CourtPoint(_returnRight, _pl),
    'bowling-far-left': CourtPoint(_returnLeft, _pl),
    'popping-near-left': CourtPoint(_returnLeft, _poppingNear),
    'popping-near-right': CourtPoint(_returnRight, _poppingNear),
    'popping-far-right': CourtPoint(_returnRight, _poppingFar),
    'popping-far-left': CourtPoint(_returnLeft, _poppingFar),
  },
};

const _defaultLandmarks = {
  'tennis-doubles': ['doubles-near-left', 'doubles-near-right', 'doubles-far-right', 'doubles-far-left'],
  'cricket-pitch': ['pitch-near-left', 'pitch-near-right', 'pitch-far-right', 'pitch-far-left'],
};

const courtAreas = <String, List<CourtArea>>{
  'tennis-doubles': [
    CourtArea('doubles', 'Doubles court', 0, 0, _w, _l),
    CourtArea('singles', 'Singles court', _singlesLeft, 0, _singlesRight, _l),
    CourtArea('serve-near-deuce', 'Serve into the near deuce box', _centerX, _serviceNear, _singlesRight, _netY),
    CourtArea('serve-near-ad', 'Serve into the near ad box', _singlesLeft, _serviceNear, _centerX, _netY),
    CourtArea('serve-far-deuce', 'Serve into the far deuce box', _singlesLeft, _netY, _centerX, _serviceFar),
    CourtArea('serve-far-ad', 'Serve into the far ad box', _centerX, _netY, _singlesRight, _serviceFar),
  ],
  'cricket-pitch': [CourtArea('pitch', 'Pitch', 0, 0, _pw, _pl)],
};

const _ballRadius = {'tennis-doubles': 0.033, 'cricket-pitch': 0.036};

CourtArea courtArea(String preset, [String? id]) {
  final areas = courtAreas[preset] ?? courtAreas['tennis-doubles']!;
  return areas.firstWhere((area) => area.id == id, orElse: () => areas.first);
}

/// Solves a small dense linear system; null when it has no single answer.
List<double>? _solve(List<List<double>> matrix, List<double> rhs) {
  final n = rhs.length;
  final a = [for (var i = 0; i < n; i += 1) [...matrix[i], rhs[i]]];
  for (var col = 0; col < n; col += 1) {
    var pivot = col;
    for (var row = col + 1; row < n; row += 1) {
      if (a[row][col].abs() > a[pivot][col].abs()) pivot = row;
    }
    if (a[pivot][col].abs() < 1e-12) return null;
    final swap = a[col];
    a[col] = a[pivot];
    a[pivot] = swap;
    for (var row = 0; row < n; row += 1) {
      if (row == col) continue;
      final factor = a[row][col] / a[col][col];
      for (var k = col; k <= n; k += 1) {
        a[row][k] -= factor * a[col][k];
      }
    }
  }
  return [for (var i = 0; i < n; i += 1) a[i][n] / a[i][i]];
}

/// The 3x3 homography (row-major, last entry 1) taking `from` points onto `to` points.
List<double>? homography(List<CourtPoint> from, List<CourtPoint> to) {
  if (from.length != 4 || to.length != 4) return null;
  final rows = <List<double>>[];
  final rhs = <double>[];
  for (var i = 0; i < 4; i += 1) {
    final f = from[i];
    final t = to[i];
    rows.add([f.x, f.y, 1, 0, 0, 0, -t.x * f.x, -t.x * f.y]);
    rhs.add(t.x);
    rows.add([0, 0, 0, f.x, f.y, 1, -t.y * f.x, -t.y * f.y]);
    rhs.add(t.y);
  }
  final h = _solve(rows, rhs);
  return h == null ? null : [...h, 1];
}

CourtPoint? applyHomography(List<double> h, CourtPoint p) {
  final w = h[6] * p.x + h[7] * p.y + h[8];
  if (w.abs() < 1e-12) return null;
  return CourtPoint((h[0] * p.x + h[1] * p.y + h[2]) / w, (h[3] * p.x + h[4] * p.y + h[5]) / w);
}

/// The court meters of each marked point, in the order they were marked.
List<CourtPoint> courtWorldPoints(CourtCalibration court) {
  final table = courtLandmarks[court.preset] ?? const {};
  final ids = court.landmarks != null && court.landmarks!.length == 4 && court.landmarks!.every(table.containsKey)
      ? court.landmarks!
      : _defaultLandmarks[court.preset] ?? const [];
  return [for (final id in ids) table[id]!];
}

/// Maps a point in the court photo's pixels onto the ground, in court meters.
CourtPoint? Function(CourtPoint image)? groundFromImage(CourtCalibration court) {
  final h = homography(court.imagePoints, courtWorldPoints(court));
  if (h == null) return null;
  return (image) => applyHomography(h, image);
}

/// In or out for a spot on the ground. Lines count as in, as far as the ball's radius reaches.
String lineCall(String preset, CourtPoint spot, [String? areaId]) {
  final area = courtArea(preset, areaId);
  final r = _ballRadius[preset] ?? 0.033;
  final inside = spot.x >= area.x0 - r && spot.y >= area.y0 - r && spot.x <= area.x1 + r && spot.y <= area.y1 + r;
  return inside ? 'in' : 'out';
}

class BounceCall {
  BounceCall(this.t, this.meters, this.call);
  final double t;
  final CourtPoint meters;
  final String call;
}

/// Each bounce of a ball track placed on the court and called in or out. The track and the court
/// photo must have the same shape; the court is scaled to the video's size.
List<BounceCall> bounceCalls(BallTrack track, CourtCalibration court) {
  final aspect = track.sourceWidth / track.sourceHeight;
  if ((court.sourceWidth / court.sourceHeight - aspect).abs() / aspect > 0.02) return const [];
  final toCourt = groundFromImage(court);
  if (toCourt == null) return const [];
  final sx = court.sourceWidth / track.sourceWidth;
  final sy = court.sourceHeight / track.sourceHeight;
  final calls = <BounceCall>[];
  for (final point in track.points) {
    if (!point.bounce) continue;
    final meters = toCourt(CourtPoint(point.x * sx, (point.y + point.radius) * sy));
    if (meters == null) continue;
    calls.add(BounceCall(point.t, meters, lineCall(court.preset, meters, court.callArea)));
  }
  return calls;
}
