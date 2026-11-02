import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:pbmp_client/pbmp_client.dart';

import '../app_state.dart';

const _takeChoices = [5, 10, 30, 60];

/// This phone's camera: photos and videos go into the session, and a synced take records on every
/// phone with its camera open at the same server time.
class CameraScreen extends StatefulWidget {
  const CameraScreen({super.key, required this.state, required this.active});
  final AppState state;
  // The camera is opened only while its tab shows.
  final bool active;

  @override
  State<CameraScreen> createState() => _CameraScreenState();
}

class _CameraScreenState extends State<CameraScreen> {
  CameraController? _camera;
  List<CameraDescription> _cameras = const [];
  int _chosen = 0;
  String? _status;
  bool _recording = false;
  int? _recordingStartedAt;
  Timer? _poll;
  String? _seenTake;
  int _takeSeconds = _takeChoices.first;

  @override
  void initState() {
    super.initState();
    if (widget.active) _open();
  }

  @override
  void didUpdateWidget(CameraScreen old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) _open();
    if (!widget.active && old.active) _close();
  }

  @override
  void dispose() {
    _close();
    super.dispose();
  }

  Future<void> _open() async {
    try {
      _cameras = await availableCameras();
      if (_cameras.isEmpty) {
        setState(() => _status = 'This phone has no camera the app can use.');
        return;
      }
      final controller = CameraController(_cameras[_chosen % _cameras.length], ResolutionPreset.veryHigh, enableAudio: true);
      await controller.initialize();
      if (!mounted || !widget.active) {
        await controller.dispose();
        return;
      }
      setState(() => _camera = controller);
      _poll = Timer.periodic(const Duration(seconds: 1), (_) => _checkTake());
    } on CameraException catch (caught) {
      setState(() => _status = caught.code == 'CameraAccessDenied' ? 'Allow the camera in the phone settings.' : caught.description);
    }
  }

  Future<void> _close() async {
    _poll?.cancel();
    _poll = null;
    final camera = _camera;
    _camera = null;
    await camera?.dispose();
  }

  Future<void> _switchCamera() async {
    await _close();
    _chosen += 1;
    await _open();
  }

  Size? get _size {
    final preview = _camera?.value.previewSize;
    if (preview == null) return null;
    // The preview size is reported for the sensor, which is landscape.
    final portrait = MediaQuery.orientationOf(context) == Orientation.portrait;
    return portrait ? Size(preview.height, preview.width) : preview;
  }

  Future<void> _photo() async {
    final camera = _camera;
    if (camera == null || camera.value.isTakingPicture) return;
    final shot = await camera.takePicture();
    final size = _size;
    setState(() => _status = 'Saving the photo…');
    await widget.state.upload(File(shot.path), kind: 'photo', mimeType: 'image/jpeg', width: size?.width.round(), height: size?.height.round());
    setState(() => _status = widget.state.error ?? 'Photo saved in the session.');
  }

  Future<void> _startRecording() async {
    final camera = _camera;
    if (camera == null || _recording) return;
    await camera.startVideoRecording();
    setState(() {
      _recording = true;
      _recordingStartedAt = widget.state.client?.serverNow();
      _status = 'Recording…';
    });
  }

  Future<void> _stopRecording({String? takeId}) async {
    final camera = _camera;
    if (camera == null || !_recording) return;
    final file = await camera.stopVideoRecording();
    final size = _size;
    final startedAt = _recordingStartedAt;
    setState(() {
      _recording = false;
      _status = 'Saving the video…';
    });
    final mime = file.path.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
    await widget.state.upload(File(file.path), kind: 'video', mimeType: mime, width: size?.width.round(), height: size?.height.round(), takeId: takeId, startedAt: startedAt);
    setState(() => _status = widget.state.error ?? 'Video saved in the session.');
  }

  // A take scheduled by any phone in the session starts recording here at its server time.
  Future<void> _checkTake() async {
    final state = widget.state;
    final client = state.client;
    final session = state.session;
    if (client == null || session == null || _recording) return;
    Take? take;
    try {
      take = await client.latestTake(session.id);
    } on Exception {
      return;
    }
    if (take == null || take.id == _seenTake) return;
    final wait = take.startAt - client.serverNow();
    if (wait < -500) return;
    _seenTake = take.id;
    final scheduled = take;
    setState(() => _status = 'Synced take of ${scheduled.seconds} s starts in ${(wait / 1000).toStringAsFixed(1)} s');
    Timer(Duration(milliseconds: wait.clamp(0, 60000)), () async {
      await _startRecording();
      Timer(Duration(seconds: scheduled.seconds), () => _stopRecording(takeId: scheduled.id));
    });
  }

  Future<void> _startTake() async {
    final state = widget.state;
    final client = state.client;
    final session = state.session;
    if (client == null || session == null) return;
    await client.createTake(session.id, _takeSeconds, deviceId: state.deviceId);
    await _checkTake();
  }

  @override
  Widget build(BuildContext context) {
    final camera = _camera;
    final busy = widget.state.busy;
    final offset = widget.state.client?.clock;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (camera != null && camera.value.isInitialized)
          ClipRRect(borderRadius: BorderRadius.circular(12), child: CameraPreview(camera))
        else
          const AspectRatio(aspectRatio: 3 / 4, child: Center(child: CircularProgressIndicator())),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            FilledButton.icon(onPressed: camera == null || busy || _recording ? null : _photo, icon: const Icon(Icons.photo_camera), label: const Text('Capture photo')),
            FilledButton.tonalIcon(
              onPressed: camera == null || busy ? null : (_recording ? () => _stopRecording() : _startRecording),
              icon: Icon(_recording ? Icons.stop : Icons.fiber_manual_record),
              label: Text(_recording ? 'Stop recording' : 'Start recording'),
            ),
            if (_cameras.length > 1) IconButton(tooltip: 'Switch camera', onPressed: _recording ? null : _switchCamera, icon: const Icon(Icons.cameraswitch)),
          ],
        ),
        if (_status != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_status!)),
        const Divider(height: 32),
        Text('Synced take', style: Theme.of(context).textTheme.titleMedium),
        const Text('One press records on every phone and browser in this session that has its camera open, starting at the same server time.'),
        const SizedBox(height: 8),
        Row(
          children: [
            DropdownButton<int>(
              value: _takeSeconds,
              items: [for (final seconds in _takeChoices) DropdownMenuItem(value: seconds, child: Text('$seconds seconds'))],
              onChanged: (value) => setState(() => _takeSeconds = value ?? _takeSeconds),
            ),
            const SizedBox(width: 12),
            OutlinedButton(onPressed: camera == null || _recording ? null : _startTake, child: const Text('Start synced take')),
          ],
        ),
        if (offset != null) Text('This phone\'s clock is matched to the server within about ${(offset.roundTripMs / 2).round()} ms.'),
      ],
    );
  }
}
