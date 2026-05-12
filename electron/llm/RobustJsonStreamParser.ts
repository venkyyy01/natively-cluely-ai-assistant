/**
 * NAT-701: RobustJsonStreamParser — incremental JSON state machine.
 *
 * Parses a streaming LLM output character-by-character, tracking
 * nesting depth to detect when a complete JSON object has arrived.
 * Returns partial objects for progressive rendering.
 *
 * Design:
 *  - Feed chunks via push(chunk) as they arrive
 *  - subscribe to 'partial' for each new key completion
 *  - subscribe to 'complete' when the top-level object closes
 *  - subscribe to 'error' on unrecoverable parse failure
 */
import { EventEmitter } from 'events';

export type StreamParserState =
  | 'waiting'     // scanning for opening brace
  | 'in_object'   // inside top-level object
  | 'in_string'   // inside a JSON string value
  | 'complete'    // top-level object closed
  | 'error';      // unrecoverable error

export interface RobustJsonStreamParserEvents {
  /** Emitted whenever accumulated buffer parses cleanly as a partial object */
  partial: [obj: Record<string, unknown>];
  /** Emitted when the top-level object is fully closed */
  complete: [obj: Record<string, unknown>];
  /** Emitted on unrecoverable parse failure */
  error: [err: Error];
}

export class RobustJsonStreamParser extends EventEmitter {
  private buffer = '';
  private state: StreamParserState = 'waiting';
  private depth = 0;
  private inEscape = false;

  push(chunk: string): void {
    if (this.state === 'complete' || this.state === 'error') return;

    for (const ch of chunk) {
      this.buffer += ch;

      if (this.state === 'waiting') {
        if (ch === '{') {
          this.depth = 1;
          this.state = 'in_object';
        }
        continue;
      }

      if (this.state === 'in_string') {
        if (this.inEscape) {
          this.inEscape = false;
          continue;
        }
        if (ch === '\\') { this.inEscape = true; continue; }
        if (ch === '"') { this.state = 'in_object'; continue; }
        continue;
      }

      // in_object
      if (ch === '"') {
        this.state = 'in_string';
        continue;
      }
      if (ch === '{' || ch === '[') {
        this.depth++;
        continue;
      }
      if (ch === '}' || ch === ']') {
        this.depth--;
        if (this.depth === 0 && ch === '}') {
          this.state = 'complete';
          this.tryEmitComplete();
          return;
        }
        continue;
      }
    }

    // Emit partial on each chunk if we are in_object
    if (this.state === 'in_object') {
      this.tryEmitPartial();
    }
  }

  reset(): void {
    this.buffer = '';
    this.state = 'waiting';
    this.depth = 0;
    this.inEscape = false;
  }

  getBuffer(): string {
    return this.buffer;
  }

  getState(): StreamParserState {
    return this.state;
  }

  private tryEmitPartial(): void {
    const relaxed = this.buffer + '}';
    try {
      const obj = JSON.parse(relaxed) as Record<string, unknown>;
      this.emit('partial', obj);
    } catch {
      // Partial buffer not yet valid JSON — silently ignore
    }
  }

  private tryEmitComplete(): void {
    try {
      const obj = JSON.parse(this.buffer) as Record<string, unknown>;
      this.emit('complete', obj);
    } catch (err) {
      this.state = 'error';
      this.emit('error', new Error(`Failed to parse complete JSON: ${err}`));
    }
  }
}
