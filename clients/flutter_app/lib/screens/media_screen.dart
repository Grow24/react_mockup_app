import 'package:flutter/material.dart';
import 'package:pbmp_client/pbmp_client.dart';

import '../app_state.dart';
import 'asset_screen.dart';

/// Every photo and video in the session, newest first, from all its phones.
class MediaScreen extends StatelessWidget {
  const MediaScreen({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        final session = state.session!;
        final assets = session.assets;
        return RefreshIndicator(
          onRefresh: state.refresh,
          child: assets.isEmpty
              ? ListView(
                  padding: const EdgeInsets.all(24),
                  children: const [Text('Nothing captured yet. Take a photo or record a video on the Camera tab, or in the web app.')],
                )
              : GridView.builder(
                  padding: const EdgeInsets.all(12),
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 220, mainAxisSpacing: 12, crossAxisSpacing: 12),
                  itemCount: assets.length,
                  itemBuilder: (context, index) => _AssetTile(state: state, session: session, asset: assets[index]),
                ),
        );
      },
    );
  }
}

class _AssetTile extends StatelessWidget {
  const _AssetTile({required this.state, required this.session, required this.asset});
  final AppState state;
  final SessionDetail session;
  final MediaAsset asset;

  @override
  Widget build(BuildContext context) {
    final client = state.client!;
    final headers = {if (client.sessionKey != null) 'X-Session-Key': client.sessionKey!};
    final tags = [
      if (session.ballTrackFor(asset.id) != null) 'ball',
      if (session.poseTrackFor(asset.id) != null) 'players',
    ];
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AssetScreen(state: state, asset: asset))),
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (asset.isVideo)
              Container(color: const Color(0xFF161310), child: const Icon(Icons.play_circle_outline, color: Colors.white70, size: 48))
            else
              Image.network(client.resolve(asset.fileUrl).toString(), headers: headers, fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => const Icon(Icons.broken_image_outlined)),
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                color: Colors.black54,
                padding: const EdgeInsets.all(6),
                child: Text(
                  '${asset.isVideo ? 'Video' : 'Photo'} · ${asset.cameraLabel}${tags.isEmpty ? '' : ' · ${tags.join(', ')}'}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white, fontSize: 12),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
