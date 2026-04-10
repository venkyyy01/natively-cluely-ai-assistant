import { randomUUID } from 'node:crypto';

import type {
  MacosLayer3CreateProtectedSessionRequest,
  MacosLayer3HealthReport,
  MacosLayer3ResponseEnvelope,
} from './separateProjectContracts';
import { MacosVirtualDisplayClient } from './MacosVirtualDisplayClient';
import { resolveMacosVirtualDisplayHelperPath } from './macosVirtualDisplayIntegration';

export interface NativeStealthFrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeStealthArmRequest {
  sessionId?: string;
  surfaceId?: string;
  width?: number;
  height?: number;
  hiDpi?: boolean;
  displayPreference?: MacosLayer3CreateProtectedSessionRequest['displayPreference'];
  reason?: MacosLayer3CreateProtectedSessionRequest['reason'];
}

export interface NativeStealthArmResult {
  connected: boolean;
  sessionId: string | null;
  surfaceId: string | null;
}

export interface NativeStealthHeartbeatResult {
  connected: boolean;
  healthy: boolean;
}

export interface NativeStealthSubmitFrameResult {
  connected: boolean;
  accepted: boolean;
}

export interface NativeStealthBridgeClient {
  createProtectedSession: (request: MacosLayer3CreateProtectedSessionRequest) => Promise<MacosLayer3ResponseEnvelope<{ sessionId: string; state: string }>>;
  attachSurface: (request: {
    sessionId: string;
    surfaceSource: 'native-ui-host';
    surfaceId: string;
    width: number;
    height: number;
    hiDpi: boolean;
  }) => Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>>;
  present: (request: { sessionId: string; activate: boolean }) => Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>>;
  getHealth: (sessionId: string) => Promise<MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>>;
  teardownSession: (sessionId: string) => Promise<MacosLayer3ResponseEnvelope<{ released: boolean }>>;
  dispose?: () => void;
}

interface NativeStealthBridgeOptions {
  client?: NativeStealthBridgeClient;
  helperPathResolver?: () => string | null;
  clientFactory?: (helperPath: string) => NativeStealthBridgeClient;
  sessionIdFactory?: () => string;
  logger?: Pick<Console, 'warn'>;
  onHelperDisconnect?: (reason: string) => void | Promise<void>;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

export class NativeStealthBridge {
  private client: NativeStealthBridgeClient | null;
  private readonly helperPathResolver: () => string | null;
  private readonly clientFactory: (helperPath: string) => NativeStealthBridgeClient;
  private readonly sessionIdFactory: () => string;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly onHelperDisconnect?: (reason: string) => void | Promise<void>;
  private activeSessionId: string | null = null;
  private activeSurfaceId: string | null = null;
  private lastArmRequest: NativeStealthArmRequest | null = null;
  private restartAttemptedForActiveSession = false;
  private lastDisconnectReason: string | null = null;

  constructor(options: NativeStealthBridgeOptions = {}) {
    this.client = options.client ?? null;
    this.helperPathResolver = options.helperPathResolver ?? (() => resolveMacosVirtualDisplayHelperPath());
    this.clientFactory = options.clientFactory ?? ((helperPath) => new MacosVirtualDisplayClient({ helperPath }));
    this.sessionIdFactory = options.sessionIdFactory ?? (() => `native-stealth-${randomUUID()}`);
    this.logger = options.logger ?? console;
    this.onHelperDisconnect = options.onHelperDisconnect;
  }

  isConnected(): boolean {
    return this.ensureClient() !== null;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  async arm(request: NativeStealthArmRequest = {}): Promise<NativeStealthArmResult> {
    const client = this.ensureClient();
    if (!client) {
      return {
        connected: false,
        sessionId: null,
        surfaceId: null,
      };
    }

    const sessionId = request.sessionId ?? this.sessionIdFactory();
    const surfaceId = request.surfaceId ?? `surface-${sessionId}`;
    const normalizedRequest: NativeStealthArmRequest = {
      ...request,
      sessionId,
      surfaceId,
      width: request.width ?? DEFAULT_WIDTH,
      height: request.height ?? DEFAULT_HEIGHT,
      hiDpi: request.hiDpi ?? true,
      displayPreference: request.displayPreference ?? 'dedicated-display',
      reason: request.reason ?? 'policy-required',
    };

    const createResponse = await client.createProtectedSession({
      sessionId: normalizedRequest.sessionId,
      presentationMode: 'native-fullscreen-presenter',
      displayPreference: normalizedRequest.displayPreference,
      reason: normalizedRequest.reason,
    });
    this.assertArmResponse('create-protected-session', createResponse);

    const attachResponse = await client.attachSurface({
      sessionId,
      surfaceSource: 'native-ui-host',
      surfaceId,
      width: normalizedRequest.width!,
      height: normalizedRequest.height!,
      hiDpi: normalizedRequest.hiDpi!,
    });
    this.assertArmResponse('attach-surface', attachResponse);

    const presentResponse = await client.present({ sessionId, activate: true });
    this.assertArmResponse('present', presentResponse);

    this.activeSessionId = sessionId;
    this.activeSurfaceId = surfaceId;
    this.lastArmRequest = normalizedRequest;
    this.lastDisconnectReason = null;
    if (!request.sessionId) {
      this.restartAttemptedForActiveSession = false;
    }

    return {
      connected: true,
      sessionId,
      surfaceId,
    };
  }

  async submitFrame(surfaceId: string, region: NativeStealthFrameRegion): Promise<NativeStealthSubmitFrameResult> {
    const client = this.ensureClient();
    if (!client || !this.activeSessionId) {
      return { connected: false, accepted: false };
    }

    const regionValid = region.width > 0 && region.height > 0 && region.x >= 0 && region.y >= 0;
    if (!regionValid || !this.activeSurfaceId || surfaceId !== this.activeSurfaceId) {
      return { connected: true, accepted: false };
    }

    const health = await this.callClient(() => client.getHealth(this.activeSessionId!), 'submit-frame:health');
    if (!health) {
      return { connected: false, accepted: false };
    }

    return {
      connected: true,
      accepted: this.isHealthyPresentingState(health),
    };
  }

  async heartbeat(): Promise<NativeStealthHeartbeatResult> {
    const client = this.ensureClient();
    if (!client || !this.activeSessionId) {
      return { connected: false, healthy: false };
    }

    try {
      const health = await this.callClient(
        () => client.getHealth(this.activeSessionId!),
        'heartbeat',
        { notifyDisconnect: false },
      );
      if (!health) {
        const recovered = await this.tryRestartAfterDisconnect('heartbeat');
        if (!recovered) {
          this.notifyHelperDisconnect(this.lastDisconnectReason ?? 'heartbeat:helper-disconnect');
          return {
            connected: true,
            healthy: false,
          };
        }

        const restartedSessionId = this.activeSessionId;
        if (!restartedSessionId) {
          return {
            connected: true,
            healthy: false,
          };
        }

        const recoveredClient = this.ensureClient();
        if (!recoveredClient) {
          return {
            connected: true,
            healthy: false,
          };
        }

        const recoveredHealth = await this.callClient(
          () => recoveredClient.getHealth(restartedSessionId),
          'heartbeat:post-restart',
          { notifyDisconnect: false },
        );
        if (!recoveredHealth) {
          this.notifyHelperDisconnect(this.lastDisconnectReason ?? 'heartbeat:post-restart:helper-disconnect');
          return {
            connected: true,
            healthy: false,
          };
        }

        return {
          connected: true,
          healthy: this.isHealthyPresentingState(recoveredHealth),
        };
      }

      return {
        connected: true,
        healthy: this.isHealthyPresentingState(health),
      };
    } catch {
      return {
        connected: true,
        healthy: false,
      };
    }
  }

  async fault(reason: string): Promise<void> {
    const client = this.ensureClient();
    const sessionId = this.activeSessionId;
    this.activeSessionId = null;
    this.activeSurfaceId = null;
    this.restartAttemptedForActiveSession = false;
    this.lastDisconnectReason = null;

    if (!client || !sessionId) {
      return;
    }

    try {
      await client.present({ sessionId, activate: false });
    } catch (error) {
      this.logger.warn(`[NativeStealthBridge] Failed to deactivate native session (${reason}):`, error);
    }

    try {
      await client.teardownSession(sessionId);
    } catch (error) {
      this.logger.warn(`[NativeStealthBridge] Failed to teardown native session (${reason}):`, error);
    }
  }

  dispose(): void {
    this.activeSessionId = null;
    this.activeSurfaceId = null;
    this.restartAttemptedForActiveSession = false;
    this.lastDisconnectReason = null;
    this.client?.dispose?.();
    this.client = null;
  }

  private ensureClient(): NativeStealthBridgeClient | null {
    if (this.client) {
      return this.client;
    }

    const helperPath = this.helperPathResolver();
    if (!helperPath) {
      return null;
    }

    this.client = this.clientFactory(helperPath);
    return this.client;
  }

  private assertArmResponse<T>(stage: string, envelope: MacosLayer3ResponseEnvelope<T>): void {
    if (envelope.outcome === 'ok') {
      return;
    }

    const blockerMessages = envelope.blockers.map((blocker) => blocker.code).join(', ');
    const detail = blockerMessages.length > 0 ? blockerMessages : envelope.outcome;
    throw new Error(`[NativeStealthBridge] ${stage} failed: ${detail}`);
  }

  private isHealthyPresentingState(envelope: MacosLayer3ResponseEnvelope<MacosLayer3HealthReport>): boolean {
    return (
      envelope.outcome === 'ok'
      && envelope.data.presenting
      && envelope.data.surfaceAttached
      && !envelope.data.recoveryPending
    );
  }

  private async callClient<T>(
    operation: () => Promise<T>,
    reason: string,
    options: { notifyDisconnect?: boolean } = {},
  ): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      this.markClientDisconnected(
        `${reason}:${error instanceof Error ? error.message : String(error)}`,
        options.notifyDisconnect ?? true,
      );
      return null;
    }
  }

  private markClientDisconnected(reason: string, notifyDisconnect: boolean): void {
    this.client?.dispose?.();
    this.client = null;
    this.lastDisconnectReason = reason;
    if (notifyDisconnect) {
      this.notifyHelperDisconnect(reason);
    }
  }

  private notifyHelperDisconnect(reason: string): void {
    Promise.resolve(this.onHelperDisconnect?.(reason)).catch((error) => {
      this.logger.warn('[NativeStealthBridge] Failed to notify helper disconnect:', error);
    });
  }

  private async tryRestartAfterDisconnect(reason: string): Promise<boolean> {
    if (this.restartAttemptedForActiveSession || !this.lastArmRequest) {
      return false;
    }

    this.restartAttemptedForActiveSession = true;

    try {
      const restarted = await this.arm(this.lastArmRequest);
      return restarted.connected;
    } catch (error) {
      this.logger.warn(`[NativeStealthBridge] Restart attempt after ${reason} failed:`, error);
      return false;
    }
  }
}
