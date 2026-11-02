import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import 'camera_screen.dart';
import 'media_screen.dart';
import 'workouts_screen.dart';

/// The session: its photos and videos, this phone's camera, and the workout log.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.state});
  final AppState state;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final session = state.session!;
    return Scaffold(
      appBar: AppBar(
        title: Text('Session ${session.id.substring(0, 8)}'),
        actions: [
          IconButton(
            tooltip: 'Copy session link',
            icon: const Icon(Icons.link),
            onPressed: () async {
              final link = state.shareLink;
              if (link == null) return;
              await Clipboard.setData(ClipboardData(text: link));
              if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Session link copied')));
            },
          ),
          IconButton(tooltip: 'Refresh', icon: const Icon(Icons.refresh), onPressed: state.busy ? null : state.refresh),
          IconButton(tooltip: 'Leave session', icon: const Icon(Icons.logout), onPressed: state.leave),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: [
          MediaScreen(state: state),
          CameraScreen(state: state, active: _tab == 1),
          WorkoutsScreen(state: state),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (index) => setState(() => _tab = index),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.photo_library_outlined), label: 'Media'),
          NavigationDestination(icon: Icon(Icons.videocam_outlined), label: 'Camera'),
          NavigationDestination(icon: Icon(Icons.fitness_center), label: 'Workouts'),
        ],
      ),
    );
  }
}
