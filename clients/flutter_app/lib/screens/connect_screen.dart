import 'package:flutter/material.dart';

import '../app_state.dart';

/// Joins a session someone shared, or starts a new one, on a PBMP server.
class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key, required this.state});
  final AppState state;

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  late final TextEditingController _server = TextEditingController(text: widget.state.server);
  final TextEditingController _link = TextEditingController();

  @override
  void dispose() {
    _server.dispose();
    _link.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: widget.state, builder: (context, _) => _page(context));

  Widget _page(BuildContext context) {
    final state = widget.state;
    return Scaffold(
      appBar: AppBar(title: const Text('PBMP Camera')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text('Join a session', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          const Text('Paste the session link from the web app (the share button in its header). It includes the key.'),
          const SizedBox(height: 12),
          TextField(
            controller: _link,
            decoration: const InputDecoration(labelText: 'Session link', hintText: 'https://…/?session=…&key=…', border: OutlineInputBorder()),
            keyboardType: TextInputType.url,
          ),
          const SizedBox(height: 12),
          FilledButton(onPressed: state.busy ? null : () => state.openLink(_link.text), child: const Text('Open link')),
          const Divider(height: 48),
          Text('Or start a new session', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          TextField(
            controller: _server,
            decoration: const InputDecoration(labelText: 'Server', border: OutlineInputBorder()),
            keyboardType: TextInputType.url,
          ),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: state.busy ? null : () => state.newSession(_server.text.trim()), child: const Text('Start a new session')),
          if (state.busy) const Padding(padding: EdgeInsets.only(top: 20), child: Center(child: CircularProgressIndicator())),
          if (state.error != null)
            Padding(
              padding: const EdgeInsets.only(top: 20),
              child: Text(state.error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
        ],
      ),
    );
  }
}
