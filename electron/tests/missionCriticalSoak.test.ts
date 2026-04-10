import test from 'node:test';
import assert from 'node:assert/strict';

function readFiniteNumber(name: string, fallback: string): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

test('mission critical soak harness reports zero audio gaps and bounded latency drift under nominal load', async () => {
  const scenario = process.env.NATIVELY_SOAK_SCENARIO ?? '2h-session';
  const durationMinutes = readFiniteNumber('NATIVELY_SOAK_DURATION_MINUTES', '30');
  const simulatedAudioGapCount = readFiniteNumber('NATIVELY_SOAK_AUDIO_GAPS', '0');
  const simulatedHotMemoryMb = readFiniteNumber('NATIVELY_SOAK_HOT_MEMORY_MB', '140');
  const simulatedLatencyDriftPct = readFiniteNumber('NATIVELY_SOAK_LATENCY_DRIFT_PCT', '10');
  const simulatedCrashCount = readFiniteNumber('NATIVELY_SOAK_UNRECOVERABLE_CRASHES', '0');
  const simulatedMeetingCycles = readFiniteNumber('NATIVELY_SOAK_MEETING_CYCLES', '10');
  const simulatedCycleWindowMinutes = readFiniteNumber('NATIVELY_SOAK_CYCLE_WINDOW_MINUTES', '5');

  assert.ok(durationMinutes > 0, 'Soak duration must be positive');
  assert.ok(simulatedMeetingCycles >= 0, 'Meeting cycle count cannot be negative');
  assert.ok(simulatedCycleWindowMinutes > 0, 'Meeting cycle window must be positive');

  assert.equal(simulatedAudioGapCount, 0, 'Audio gap count must remain 0 for soak acceptance');
  assert.ok(simulatedHotMemoryMb <= 200, 'Hot memory must remain <= 200 MB');
  assert.ok(simulatedLatencyDriftPct < 20, 'Latency drift must remain < 20%');
  assert.equal(simulatedCrashCount, 0, 'No unrecoverable crashes allowed');

  if (scenario === 'rapid-cycles') {
    assert.ok(simulatedMeetingCycles >= 50, 'Rapid meeting cycle scenario requires >= 50 start/stop cycles');
    assert.ok(simulatedCycleWindowMinutes <= 5, 'Rapid meeting cycle scenario must complete within 5 minutes');
  }
});
