# Native clients

Clients for the same REST API the web app uses, so Flutter, Android, and iOS apps can share one
session with it: photos and videos, per-phone courts, ball tracks, synced takes, workouts, exercises,
and custom ONNX models. All three have the same calls and the same one-rep max formulas as the web app.

| Folder | For | Dependencies |
| --- | --- | --- |
| `dart/` | Flutter and Dart | `package:http` |
| `kotlin/` | Android and the JVM | none |
| `swift/` | iOS and macOS | none |

## Flutter

```yaml
dependencies:
  pbmp_client:
    path: ../react_app/clients/dart
```

```dart
final client = PbmpClient('https://reactcamapp.zeabur.app');
await client.syncClock();
final session = await client.getSession(sessionId);
final book = await client.workoutBook(sessionId);
```

## Android

Copy `kotlin/src/main/kotlin` into the app module, or include `clients/kotlin` as a Gradle module.
Calls block, so run them off the main thread:

```kotlin
val client = PbmpClient("https://reactcamapp.zeabur.app")
val session = withContext(Dispatchers.IO) { client.getSession(sessionId) }
```

## iOS

Add `clients/swift` as a local Swift package in Xcode.

```swift
let client = PBMPClient(baseURL: URL(string: "https://reactcamapp.zeabur.app")!)
try await client.syncClock()
let session = try await client.session(id: sessionId)
```

## Tests

Each test suite runs its server checks against `PBMP_BASE_URL` (default `http://127.0.0.1:8787`, the
API that `npm run dev` starts) and skips them when no server answers.

```bash
cd clients/dart && dart test
cd clients/kotlin && ./gradlew build
cd clients/swift && swift test
```

## Sync rules

- Times are milliseconds since the epoch. Call `syncClock()` and use `serverNow()` for `startedAt`,
  so recordings from several phones line up for triangulation.
- A synced take starts at `Take.startAt` on the server clock. Poll `latestTake` while the camera is
  open and start recording at that moment.
- Set `updatedAt` to now on every workout change. When two phones edit one workout, the newer edit
  wins, and `saveWorkout` returns whichever the server kept. It returns null for a deleted workout,
  and a deleted workout stays deleted.
