import 'package:flutter/material.dart';
import 'package:pbmp_client/pbmp_client.dart';

import '../app_state.dart';

String _exerciseName(String id, List<Exercise> exercises) {
  for (final exercise in exercises) {
    if (exercise.id == id) return exercise.name;
  }
  // Built-in exercises are stored by an id like "back-squat".
  final words = id.split('-');
  return words.isEmpty ? id : [words.first[0].toUpperCase() + words.first.substring(1), ...words.skip(1)].join(' ');
}

/// The session's workout log, as kept by the web app, with each exercise's best estimated one-rep max.
class WorkoutsScreen extends StatefulWidget {
  const WorkoutsScreen({super.key, required this.state});
  final AppState state;

  @override
  State<WorkoutsScreen> createState() => _WorkoutsScreenState();
}

class _WorkoutsScreenState extends State<WorkoutsScreen> {
  late Future<WorkoutBook> _book = _load();

  Future<WorkoutBook> _load() => widget.state.client!.workoutBook(widget.state.session!.id);

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: () async {
        final next = _load();
        setState(() => _book = next);
        await next;
      },
      child: FutureBuilder<WorkoutBook>(
        future: _book,
        builder: (context, snapshot) {
          if (snapshot.hasError) return ListView(padding: const EdgeInsets.all(24), children: [Text('${snapshot.error}')]);
          final book = snapshot.data;
          if (book == null) return const Center(child: CircularProgressIndicator());
          final workouts = book.workouts.toList()..sort((a, b) => b.startedAt.compareTo(a.startedAt));
          if (workouts.isEmpty) {
            return ListView(padding: const EdgeInsets.all(24), children: const [Text('No workouts yet. Log one on the Workouts screen of the web app.')]);
          }
          return ListView.builder(
            padding: const EdgeInsets.all(12),
            itemCount: workouts.length,
            itemBuilder: (context, index) {
              final workout = workouts[index];
              final when = DateTime.fromMillisecondsSinceEpoch(workout.startedAt);
              return Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(workout.name, style: Theme.of(context).textTheme.titleMedium),
                      Text('${when.year}-${when.month.toString().padLeft(2, '0')}-${when.day.toString().padLeft(2, '0')}'
                          '${workout.finishedAt == null ? ' · in progress' : ''}'),
                      const SizedBox(height: 8),
                      for (final entry in workout.entries) _EntryLine(entry: entry, exercises: book.exercises),
                    ],
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

class _EntryLine extends StatelessWidget {
  const _EntryLine({required this.entry, required this.exercises});
  final WorkoutEntry entry;
  final List<Exercise> exercises;

  @override
  Widget build(BuildContext context) {
    final done = entry.sets.where((set) => set.done).toList();
    double? best;
    for (final set in done) {
      if (set.weightKg == null || set.reps == null) continue;
      final estimate = estimateOneRepMax(set.weightKg!, set.reps!);
      if (estimate != null && (best == null || estimate > best)) best = estimate;
    }
    final sets = done.map((set) => [if (set.reps != null) '${set.reps}', if (set.weightKg != null) '${set.weightKg} kg', if (set.seconds != null) '${set.seconds} s'].join(' × ')).join(', ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Text('${_exerciseName(entry.exerciseId, exercises)}: ${sets.isEmpty ? 'no sets done' : sets}'
          '${best != null ? ' · est. 1RM ${best.toStringAsFixed(1)} kg' : ''}'),
    );
  }
}
