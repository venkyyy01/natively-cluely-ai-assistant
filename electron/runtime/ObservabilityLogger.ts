/**
 * NAT-800: ObservabilityLogger — lightweight structured event logger.
 *
 * Goals:
 *  - Single append-only ring buffer (max 2000 events, configurable)
 *  - Typed event schema for Two-Tier, extraction, stream and engine health
 *  - Export for diagnostics IPC channel
 *  - Zero external dependencies
 */

export type ObsEventKind =
  | 'probe:generated'
  | 'probe:fallback'
  | 'probe:parse_error'
  | 'tier_a:start'
  | 'tier_a:complete'
  | 'tier_a:fallback'
  | 'problem_extractor:complete'
  | 'problem_extractor:partial'
  | 'screen_rag:snapshot'
  | 'code_editor:change'
  | 'engine_health:check'
  | 'stream_parser:complete'
  | 'stream_parser:error'
  | 'verification:pass'
  | 'verification:fail';

export interface ObsEvent {
  kind: ObsEventKind;
  ts: number;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

const MAX_EVENTS = Number(process.env['NATIVELY_OBS_MAX_EVENTS'] ?? 2000);
const _events: ObsEvent[] = [];

export function logEvent(kind: ObsEventKind, meta?: Record<string, unknown>, durationMs?: number): void {
  const event: ObsEvent = { kind, ts: Date.now(), durationMs, meta };
  if (_events.length >= MAX_EVENTS) {
    _events.shift();
  }
  _events.push(event);
}

export function getRecentEvents(limit = 100): ObsEvent[] {
  return _events.slice(-limit);
}

export function clearEvents(): void {
  _events.length = 0;
}

/** Returns a simple stats summary for diagnostics */
export function getEventStats(): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const e of _events) {
    stats[e.kind] = (stats[e.kind] ?? 0) + 1;
  }
  return stats;
}
