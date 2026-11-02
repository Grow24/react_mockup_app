import 'package:flutter/material.dart';
import 'package:pbmp_client/pbmp_client.dart';
import 'package:video_player/video_player.dart';

import '../app_state.dart';

String _clock(double seconds) {
  final whole = seconds.floor();
  return '${whole ~/ 60}:${(whole % 60).toString().padLeft(2, '0')}.${((seconds - whole) * 10).floor()}';
}

/// One photo or video with what the session knows about it: its court, the ball's bounces called
/// in or out, and the lettered players.
class AssetScreen extends StatefulWidget {
  const AssetScreen({super.key, required this.state, required this.asset});
  final AppState state;
  final MediaAsset asset;

  @override
  State<AssetScreen> createState() => _AssetScreenState();
}

class _AssetScreenState extends State<AssetScreen> {
  VideoPlayerController? _video;

  @override
  void initState() {
    super.initState();
    final client = widget.state.client!;
    if (widget.asset.isVideo) {
      _video = VideoPlayerController.networkUrl(
        client.resolve(widget.asset.fileUrl),
        httpHeaders: {if (client.sessionKey != null) 'X-Session-Key': client.sessionKey!},
      )..initialize().then((_) {
          if (mounted) setState(() {});
        });
      _video!.addListener(_tick);
    }
  }

  void _tick() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _video?.removeListener(_tick);
    _video?.dispose();
    super.dispose();
  }

  void _seek(double seconds) => _video?.seekTo(Duration(milliseconds: (seconds * 1000).round()));

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final asset = widget.asset;
    final session = state.session!;
    final client = state.client!;
    final courts = session.courtsFor(asset.deviceId);
    final ball = session.ballTrackFor(asset.id);
    final players = session.poseTrackFor(asset.id);
    final video = _video;
    return Scaffold(
      appBar: AppBar(
        title: Text(asset.isVideo ? 'Video' : 'Photo'),
        actions: [
          IconButton(
            tooltip: 'Remove from the session',
            icon: const Icon(Icons.delete_outline),
            onPressed: () async {
              await client.deleteAsset(asset.id);
              await state.refresh();
              if (context.mounted) Navigator.of(context).pop();
            },
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (video == null)
            Image.network(client.resolve(asset.fileUrl).toString(), headers: {if (client.sessionKey != null) 'X-Session-Key': client.sessionKey!})
          else if (!video.value.isInitialized)
            const AspectRatio(aspectRatio: 16 / 9, child: Center(child: CircularProgressIndicator()))
          else ...[
            AspectRatio(aspectRatio: video.value.aspectRatio, child: VideoPlayer(video)),
            VideoProgressIndicator(video, allowScrubbing: true),
            Row(
              children: [
                IconButton(
                  icon: Icon(video.value.isPlaying ? Icons.pause : Icons.play_arrow),
                  onPressed: () => video.value.isPlaying ? video.pause() : video.play(),
                ),
                Text('${_clock(video.value.position.inMilliseconds / 1000)} / ${_clock(video.value.duration.inMilliseconds / 1000)}'),
              ],
            ),
          ],
          const SizedBox(height: 12),
          Text('${asset.cameraLabel}${asset.width != null ? ' · ${asset.width}×${asset.height}' : ''}', style: Theme.of(context).textTheme.bodySmall),
          const Divider(height: 32),
          Text('Court', style: Theme.of(context).textTheme.titleMedium),
          Text(courts.isEmpty
              ? 'No court is marked for this camera yet. Mark its corners on a photo in the web app.'
              : courts.map((court) => '${court.label}: ${court.preset == 'cricket-pitch' ? 'cricket pitch' : 'tennis court'}, calls for ${courtArea(court.preset, court.callArea).label.toLowerCase()}').join('\n')),
          if (asset.isVideo) ...[
            const Divider(height: 32),
            Text('Ball', style: Theme.of(context).textTheme.titleMedium),
            if (ball == null)
              const Text('Not tracked yet. Press Track the ball on this video in the web app.')
            else
              _BallSection(track: ball, court: courts.isEmpty ? null : courts.first, onSeek: _seek),
            const Divider(height: 32),
            Text('Players', style: Theme.of(context).textTheme.titleMedium),
            if (players == null) const Text('Not tracked yet. Press Track players on this video in the web app.') else _PlayersSection(track: players),
          ],
        ],
      ),
    );
  }
}

class _BallSection extends StatelessWidget {
  const _BallSection({required this.track, required this.court, required this.onSeek});
  final BallTrack track;
  final CourtCalibration? court;
  final void Function(double seconds) onSeek;

  @override
  Widget build(BuildContext context) {
    final calls = court == null ? const <BounceCall>[] : bounceCalls(track, court!);
    final bounces = track.points.where((point) => point.bounce).length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Seen in ${track.points.length} frames at ${track.sampleFps.round()} per second · $bounces bounces'
            '${track.unfinished ? ' · read up to ${_clock(track.duration)} of ${_clock(track.videoDuration!)}' : ''}'),
        if (court == null) const Text('Mark the court to call the bounces in or out.'),
        for (final call in calls)
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Chip(
              label: Text(call.call.toUpperCase()),
              backgroundColor: call.call == 'in' ? const Color(0xFF7FD8CF) : const Color(0xFFE0603C),
            ),
            title: Text('${call.meters.x.toStringAsFixed(2)} m from the left line, ${call.meters.y.toStringAsFixed(2)} m from the near line'),
            subtitle: Text('at ${_clock(call.t)}'),
            onTap: () => onSeek(call.t),
          ),
      ],
    );
  }
}

class _PlayersSection extends StatelessWidget {
  const _PlayersSection({required this.track});
  final PoseTrack track;

  @override
  Widget build(BuildContext context) {
    final seen = track.frames.where((frame) => frame.people.isNotEmpty).length;
    final names = <String, String>{};
    for (final frame in track.frames) {
      for (final person in frame.people) {
        if (person.id != null) names.putIfAbsent(person.id!, () => person.name);
      }
    }
    Color rgb(List<int> value) => Color.fromARGB(255, value[0], value[1], value[2]);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Players in $seen of ${track.frames.length} frames'
            '${track.unfinished ? ' · read up to ${_clock(track.duration)} of ${_clock(track.videoDuration!)}' : ''}'),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final player in track.players)
              Chip(
                avatar: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(width: 12, height: 9, color: rgb(player.torso)),
                    Container(width: 12, height: 9, color: rgb(player.legs)),
                  ],
                ),
                label: Text('${names[player.id] ?? 'Player ${player.id}'} · ${player.frames} frames'),
              ),
          ],
        ),
      ],
    );
  }
}
