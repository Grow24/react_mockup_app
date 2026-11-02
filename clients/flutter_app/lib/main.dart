import 'package:flutter/material.dart';

import 'app_state.dart';
import 'screens/connect_screen.dart';
import 'screens/home_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final state = AppState();
  state.load();
  runApp(PbmpApp(state: state));
}

class PbmpApp extends StatelessWidget {
  const PbmpApp({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PBMP Camera',
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F6A64)), useMaterial3: true),
      home: ListenableBuilder(
        listenable: state,
        builder: (context, _) {
          if (!state.ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
          return state.session == null ? ConnectScreen(state: state) : HomeScreen(state: state);
        },
      ),
    );
  }
}
