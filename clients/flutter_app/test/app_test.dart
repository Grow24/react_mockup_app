import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pbmp_app/app_state.dart';
import 'package:pbmp_app/screens/connect_screen.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

void main() {
  setUp(() => SharedPreferencesAsyncPlatform.instance = InMemorySharedPreferencesAsync.empty());

  test('reads the server, session, and key from a shared link', () {
    final parsed = parseSessionLink(' https://reactcamapp.zeabur.app/?session=0f0e2f6a-1b2c-4d5e-8f90-123456789abc&key=abc123 ')!;
    expect(parsed.server, 'https://reactcamapp.zeabur.app');
    expect(parsed.session, '0f0e2f6a-1b2c-4d5e-8f90-123456789abc');
    expect(parsed.key, 'abc123');
    expect(parseSessionLink('http://192.168.1.5:8787/?session=s1')?.key, isNull, reason: 'an old open session has no key');
    expect(parseSessionLink('https://reactcamapp.zeabur.app/'), isNull);
    expect(parseSessionLink('not a link'), isNull);
  });

  test('makes version 4 ids', () {
    final id = newId();
    expect(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$').hasMatch(id), isTrue);
    expect(newId(), isNot(id));
  });

  testWidgets('asks for a session link or a new session', (tester) async {
    final state = AppState();
    await tester.pumpWidget(MaterialApp(home: ConnectScreen(state: state)));
    expect(find.text('Join a session'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Session link'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Server'), findsOneWidget);
    expect(find.text(defaultServer), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'Session link'), 'nonsense');
    await tester.tap(find.text('Open link'));
    await tester.pumpAndSettle();
    expect(find.text('Paste the whole session link, with ?session= in it.'), findsOneWidget);
  });
}
