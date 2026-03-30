import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

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
  command: 'status' | 'create-session' | 'release-session';
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
}

export class MacosVirtualDisplayClient {
  private readonly helperPath: string;
  private readonly runHelper: (request: HelperRunRequest) => Promise<HelperRunResult>;
  private serverProcess: ChildProcessWithoutNullStreams | null = null;
  private requestSequence = 0;
  private pending = new Map<string, { resolve: (result: HelperRunResult) => void; reject: (error: Error) => void }>();
  private stdoutBuffer = '';

  constructor(options: MacosVirtualDisplayClientOptions) {
    this.helperPath = options.helperPath;
    this.runHelper = options.runHelper ?? ((request) => this.runHelperProcess(request));
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
      this.pending.set(id, { resolve, reject });

      const payload = request.stdin ? JSON.parse(request.stdin) as Record<string, unknown> : {};
      child.stdin.write(`${JSON.stringify({ id, command: request.command, ...payload })}\n`);
    });
  }

  private ensureServerProcess(): ChildProcessWithoutNullStreams {
    if (this.serverProcess) {
      return this.serverProcess;
    }

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
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.clear();
      this.serverProcess = null;
    });
    child.on('close', () => {
      if (this.pending.size > 0) {
        for (const pending of this.pending.values()) {
          pending.reject(new Error('macOS virtual display helper server exited unexpectedly'));
        }
        this.pending.clear();
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
        const envelope = JSON.parse(line) as { id?: string; ok: boolean; result?: unknown; error?: string };
        const pending = envelope.id ? this.pending.get(envelope.id) : undefined;
        if (pending && envelope.id) {
          this.pending.delete(envelope.id);
          if (envelope.ok) {
            pending.resolve({ exitCode: 0, stdout: JSON.stringify(envelope.result ?? {}), stderr: '' });
          } else {
            pending.resolve({ exitCode: 1, stdout: '', stderr: envelope.error ?? 'helper request failed' });
          }
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }
}

export interface VirtualDisplayCoordinator {
  ensureIsolationForWindow(request: MacosVirtualDisplaySessionRequest): Promise<MacosVirtualDisplaySessionResponse>;
  releaseIsolationForWindow(request: { windowId: string }): Promise<void>;
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
}
