import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  MacosLayer3CapabilityReport,
  MacosLayer3CreateProtectedSessionRequest,
  MacosLayer3CreateProtectedSessionResponse,
  MacosLayer3HealthReport,
  MacosLayer3PresentRequest,
  MacosLayer3ResponseEnvelope,
  MacosLayer3SurfaceAttachment,
  MacosLayer3TelemetryCounters,
  MacosLayer3TelemetryEvent,
  MacosLayer3ValidationReport,
} from './separateProjectContracts';

export interface MacosVirtualDisplayStatus {
  ready: boolean;
  component: string;
  notes?: string;
  reason?: string;
}

export interface MacosVirtualDisplaySessionRequest {
  sessionId: string;
  windowId: string;
  width: number;
  height: number;
}

export interface MacosVirtualDisplaySessionResponse {
  ready: boolean;
  sessionId: string;
  mode?: 'virtual-display';
  surfaceToken?: string;
  reason?: string;
}

interface HelperRunRequest {
  command:
    | 'status'
    | 'create-session'
    | 'release-session'
    | 'probe-capabilities'
    | 'create-protected-session'
    | 'attach-surface'
    | 'present'
    | 'teardown-session'
    | 'get-health'
    | 'get-telemetry'
    | 'validate-session';
  stdin?: string;
}

interface HelperRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface MacosVirtualDisplayClientOptions {
  helperPath: string;
  runHelper?: (request: HelperRunRequest) => Promise<HelperRunResult>;
  requestTimeoutMs?: number;
}

export class MacosVirtualDisplayClient {
  private readonly helperPath: string;
  private readonly runHelper: (request: HelperRunRequest) => Promise<HelperRunResult>;
  private readonly requestTimeoutMs: number;
  private serverProcess: ChildProcessWithoutNullStreams | null = null;
  private requestSequence = 0;
  private pending = new Map<string, { resolve: (result: HelperRunResult) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private expiredRequestIds = new Set<string>();
  private stdoutBuffer = '';
  private respawnTimestamps: number[] = [];
  private readonly MAX_RESPAWNS_PER_MINUTE = 3;

  constructor(options: MacosVirtualDisplayClientOptions) {
    this.helperPath = options.helperPath;
    this.runHelper = options.runHelper ?? ((request) => this.runHelperProcess(request));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  }

  async getStatus(): Promise<MacosVirtualDisplayStatus> {
    return this.executeJsonCommand<MacosVirtualDisplayStatus>({ command: 'status' });
  }

  async createSession(request: MacosVirtualDisplaySessionRequest): Promise<MacosVirtualDisplaySessionResponse> {
    return this.executeJsonCommand<MacosVirtualDisplaySessionResponse>({
      command: 'create-session',
      stdin: JSON.stringify(request),
    });
  }

  async releaseSession(sessionId: string): Promise<{ released: boolean }> {
    return this.executeJsonCommand<{ released: boolean }>({
      command: 'release-session',
      stdin: JSON.stringify({ sessionId }),
    });
  }

  async probeCapabilities(): Promise<MacosLayer3ResponseEnvelope<MacosLayer3CapabilityReport>> {
    return this.executeJsonCommand<MacosLayer3ResponseEnvelope<MacosLayer3CapabilityReport>>({ command: 'probe-capabilities' });
  }

  async createProtectedSession(request: MacosLayer3CreateProtectedSessionRequest): Promise<MacosLayer3ResponseEnvelope<MacosLayer3CreateProtectedSessionResponse>> {
    return this.executeJsonCommand<MacosLayer3ResponseEnvelope<MacosLayer3CreateProtectedSessionResponse>>({
      command: 'create-protected-session',
      stdin: JSON.stringify(request),
    });
  }

  async attachSurface(request: MacosLayer3SurfaceAttachment): Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>> {
    return this.executeJsonCommand<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>>({
      command: 'attach-surface',
      stdin: JSON.stringify(request),
    });
  }

  async present(request: MacosLayer3PresentRequest): Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>> {
    return this.executeJsonCommand<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>>({
      command: 'present',
      stdin: JSON.stringify(request),
    });
  }

  async teardownSession(sessionId: string): Promise<MacosLayer3ResponseEnvelope<{ released: boolean }>> {
    return this.executeJsonCommand<MacosLayer3ResponseEnvelope<{ released: boolean }>>({
      command: 'teardown-session',
      stdin: JSON.stringify({ sessionId }),
    });
  }

  async getHealth(sessionId: string): Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>> {
    return this.executeJsonCommand<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>>({
      command: 'get-health',
      stdin: JSON.stringify({ sessionId }),
    });
  }

  async getTelemetry(sessionId: string): Promise<MacosLayer3ResponseEnvelope<{ events: MacosLayer3TelemetryEvent[]; counters: MacosLayer3TelemetryCounters }>> {
    return this.executeJsonCommand<MacosLayer3ResponseEnvelope<{ events: MacosLayer3TelemetryEvent[]; counters: MacosLayer3TelemetryCounters }>>({
      command: 'get-telemetry',
      stdin: JSON.stringify({ sessionId }),
    });
  }

  async validateSession(sessionId: string): Promise<MacosLayer3ResponseEnvelope<MacosLayer3ValidationReport>> {
    return this.executeJsonCommand<MacosLayer3ResponseEnvelope<MacosLayer3ValidationReport>>({
      command: 'validate-session',
      stdin: JSON.stringify({ sessionId }),
    });
  }

  dispose(): void {
    if (!this.serverProcess) {
      return;
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('macOS virtual display helper client disposed'));
    }
    this.pending.clear();
    this.expiredRequestIds.clear();
    this.serverProcess.kill();
    this.serverProcess = null;
    this.stdoutBuffer = '';
  }

  public isExhausted(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    this.respawnTimestamps = this.respawnTimestamps.filter((t) => t > oneMinuteAgo);
    return this.respawnTimestamps.length >= this.MAX_RESPAWNS_PER_MINUTE;
  }

  private async executeJsonCommand<T>(request: HelperRunRequest): Promise<T> {
    const result = await this.runHelper(request);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Helper exited with code ${result.exitCode}`);
    }

    return JSON.parse(result.stdout) as T;
  }

  private runHelperProcess(request: HelperRunRequest): Promise<HelperRunResult> {
    return new Promise((resolve, reject) => {
      const child = this.ensureServerProcess();
      const id = `req-${++this.requestSequence}`;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.expiredRequestIds.add(id);
        reject(new Error(`macOS virtual display helper request timed out: ${request.command}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });

      const payload = request.stdin ? JSON.parse(request.stdin) as Record<string, unknown> : {};
      child.stdin.write(`${JSON.stringify({ id, command: request.command, ...payload })}\n`);
    });
  }

  private ensureServerProcess(): ChildProcessWithoutNullStreams {
    if (this.serverProcess) {
      return this.serverProcess;
    }

    if (this.isExhausted()) {
      throw new Error('macOS virtual display helper client exhausted respawns');
    }

    this.respawnTimestamps.push(Date.now());

    const child = spawn(this.helperPath, ['serve'], {
      stdio: 'pipe',
    });
    child.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString();
      this.flushServerResponses();
    });
    child.stderr.on('data', () => {
      // The helper may log runtime warnings; command-level failures still return structured JSON.
    });
    child.on('error', (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.clear();
      this.expiredRequestIds.clear();
      this.serverProcess = null;
    });
    child.on('close', () => {
      if (this.pending.size > 0) {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('macOS virtual display helper server exited unexpectedly'));
        }
        this.pending.clear();
        this.expiredRequestIds.clear();
      }
      this.serverProcess = null;
    });
    this.serverProcess = child;
    return child;
  }

  private flushServerResponses(): void {
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const envelope = JSON.parse(line) as { id?: string; ok: boolean; result?: unknown; error?: string };
          const pending = envelope.id ? this.pending.get(envelope.id) : undefined;
          if (envelope.id && this.expiredRequestIds.has(envelope.id)) {
            this.expiredRequestIds.delete(envelope.id);
          } else if (!envelope.id || !pending) {
            for (const current of this.pending.values()) {
              clearTimeout(current.timeout);
              current.reject(new Error('Helper server returned a response with a missing or unknown request id'));
            }
            this.pending.clear();
            this.expiredRequestIds.clear();
            this.serverProcess?.kill();
            this.serverProcess = null;
          } else {
            this.pending.delete(envelope.id);
            clearTimeout(pending.timeout);
            if (envelope.ok) {
              pending.resolve({ exitCode: 0, stdout: JSON.stringify(envelope.result ?? {}), stderr: '' });
            } else {
              pending.resolve({ exitCode: 1, stdout: '', stderr: envelope.error ?? 'helper request failed' });
            }
          }
        } catch (error) {
          const parsedError = error instanceof Error ? error : new Error(String(error));
          for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(`Invalid helper JSON response: ${parsedError.message}`));
          }
          this.pending.clear();
          this.expiredRequestIds.clear();
          this.serverProcess?.kill();
          this.serverProcess = null;
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }
}

export interface VirtualDisplayCoordinator {
  ensureIsolationForWindow(request: MacosVirtualDisplaySessionRequest): Promise<MacosVirtualDisplaySessionResponse>;
  releaseIsolationForWindow(request: { windowId: string }): Promise<void>;
  isExhausted?(): boolean;
}

export class MacosVirtualDisplayCoordinator implements VirtualDisplayCoordinator {
  private readonly client: MacosVirtualDisplayClient;
  private readonly activeSessions = new Map<string, string>();

  constructor(client: MacosVirtualDisplayClient) {
    this.client = client;
  }

  async ensureIsolationForWindow(request: MacosVirtualDisplaySessionRequest): Promise<MacosVirtualDisplaySessionResponse> {
    const response = await this.client.createSession(request);
    if (response.ready) {
      this.activeSessions.set(request.windowId, request.sessionId);
    }
    return response;
  }

  async releaseIsolationForWindow(request: { windowId: string }): Promise<void> {
    const sessionId = this.activeSessions.get(request.windowId) ?? request.windowId;
    await this.client.releaseSession(sessionId);
    this.activeSessions.delete(request.windowId);
  }

  isExhausted(): boolean {
    return this.client.isExhausted();
  }
}
