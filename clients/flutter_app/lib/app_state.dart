import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:pbmp_client/pbmp_client.dart';
import 'package:shared_preferences/shared_preferences.dart';

const defaultServer = 'https://reactcamapp.zeabur.app';

// Videos larger than this go up as a stream, so a long match never sits in memory.
const _streamFrom = 64 * 1024 * 1024;

String newId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// The server, session, and key in a link the web app shares: `https://…/?session=…&key=…`.
({String server, String session, String? key})? parseSessionLink(String text) {
  final uri = Uri.tryParse(text.trim());
  final session = uri?.queryParameters['session'];
  if (uri == null || !uri.hasScheme || uri.host.isEmpty || session == null || session.isEmpty) return null;
  return (server: uri.origin, session: session, key: uri.queryParameters['key']);
}

/// The phone's place in a shared session: which server, which session and its key, and this
/// phone's id, kept between launches.
class AppState extends ChangeNotifier {
  AppState({SharedPreferencesAsync? prefs}) : _prefs = prefs ?? SharedPreferencesAsync();

  final SharedPreferencesAsync _prefs;
  PbmpClient? client;
  SessionDetail? session;
  String server = defaultServer;
  String deviceId = '';
  String? error;
  bool ready = false;
  bool busy = false;

  Device get device => Device(id: deviceId, label: 'PBMP app (${Platform.operatingSystem})', userAgent: 'pbmp_app/${Platform.operatingSystem}');

  /// The link that opens this session in the web app or on another phone.
  String? get shareLink {
    final current = session;
    final key = client?.sessionKey;
    if (current == null) return null;
    return Uri.parse(server).replace(queryParameters: {'session': current.id, 'key': ?key}).toString();
  }

  Future<void> load() async {
    server = await _prefs.getString('server') ?? defaultServer;
    deviceId = await _prefs.getString('device') ?? newId();
    await _prefs.setString('device', deviceId);
    final sessionId = await _prefs.getString('session');
    final key = await _prefs.getString('key');
    if (sessionId != null) {
      await _run(() async {
        final next = PbmpClient(server)..sessionKey = key;
        final found = await next.getSession(sessionId);
        if (found == null) throw PbmpException(404, 'That session is no longer on the server.');
        client = next;
        session = found;
        await next.syncClock();
      });
    }
    ready = true;
    notifyListeners();
  }

  Future<void> newSession(String serverUrl) => _run(() async {
        final next = PbmpClient(serverUrl);
        if (!await next.health()) throw PbmpException(0, 'No PBMP server answers at $serverUrl.');
        final opened = await next.openSession(newId(), device);
        await next.syncClock();
        await _keep(serverUrl, next, opened);
      });

  Future<void> openLink(String link) => _run(() async {
        final parsed = parseSessionLink(link);
        if (parsed == null) throw PbmpException(0, 'Paste the whole session link, with ?session= in it.');
        final next = PbmpClient(parsed.server);
        final opened = parsed.key != null ? await next.unlock(parsed.session, parsed.key!) : await next.getSession(parsed.session);
        if (opened == null) throw PbmpException(404, 'That session was not found on the server.');
        await next.syncClock();
        await _keep(parsed.server, next, opened);
      });

  Future<void> refresh() => _run(() async {
        final current = session;
        if (current == null || client == null) return;
        session = await client!.getSession(current.id) ?? current;
      });

  Future<void> leave() async {
    client?.close();
    client = null;
    session = null;
    await _prefs.remove('session');
    await _prefs.remove('key');
    notifyListeners();
  }

  /// Sends a photo or video from this phone into the session.
  Future<void> upload(File file, {required String kind, required String mimeType, int? width, int? height, String? takeId, int? startedAt}) =>
      _run(() async {
        final current = session;
        final api = client;
        if (current == null || api == null) return;
        final size = await file.length();
        final label = 'Phone camera (${Platform.operatingSystem})';
        session = size > _streamFrom
            ? await api.uploadLargeAsset(current.id,
                id: newId(),
                kind: kind,
                mimeType: mimeType,
                bytes: file.openRead(),
                byteLength: size,
                cameraLabel: label,
                width: width,
                height: height,
                deviceId: deviceId,
                takeId: takeId,
                startedAt: startedAt)
            : await api.uploadAsset(current.id,
                id: newId(),
                kind: kind,
                mimeType: mimeType,
                bytes: await file.readAsBytes(),
                cameraLabel: label,
                width: width,
                height: height,
                deviceId: deviceId,
                takeId: takeId,
                startedAt: startedAt);
      });

  Future<void> _keep(String serverUrl, PbmpClient next, SessionDetail opened) async {
    client?.close();
    client = next;
    session = opened;
    server = serverUrl;
    await _prefs.setString('server', serverUrl);
    await _prefs.setString('session', opened.id);
    final key = next.sessionKey;
    if (key != null) {
      await _prefs.setString('key', key);
    } else {
      await _prefs.remove('key');
    }
  }

  Future<void> _run(Future<void> Function() job) async {
    busy = true;
    error = null;
    notifyListeners();
    try {
      await job();
    } on PbmpException catch (caught) {
      error = caught.message;
    } on SocketException {
      error = 'The server could not be reached. Check the address and the connection.';
    } catch (caught) {
      error = '$caught';
    } finally {
      busy = false;
      notifyListeners();
    }
  }
}
