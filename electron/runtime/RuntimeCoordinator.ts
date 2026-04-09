import { randomUUID } from 'node:crypto';

import { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, RuntimeLifecycleState, SupervisorName } from './types';

export interface RuntimeCoordinatorDelegate {
  startMeetingLegacy(metadata?: unknown): Promise<void>;
  endMeetingLegacy(): Promise<void>;
}

interface RuntimeCoordinatorOptions {
  bus?: SupervisorBus;
  logger?: Pick<Console, 'warn'>;
  featureFlagReader?: () => boolean;
  supervisors?: Partial<Record<SupervisorName, ISupervisor>>;
}

export class RuntimeCoordinator {
  private readonly bus: SupervisorBus;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly featureFlagReader: () => boolean;
  private readonly supervisors: Partial<Record<SupervisorName, ISupervisor>>;
  private lifecycleState: RuntimeLifecycleState = 'idle';
  private activeMeetingId: string | null = null;

  constructor(
    private readonly delegate: RuntimeCoordinatorDelegate,
    options: RuntimeCoordinatorOptions = {},
  ) {
    this.bus = options.bus ?? new SupervisorBus();
    this.logger = options.logger ?? console;
    this.featureFlagReader = options.featureFlagReader ?? (() => false);
    this.supervisors = options.supervisors ?? {};
  }

  shouldManageLifecycle(): boolean {
    return this.featureFlagReader();
  }

  getBus(): SupervisorBus {
    return this.bus;
  }

  getLifecycleState(): RuntimeLifecycleState {
    return this.lifecycleState;
  }

  getSupervisor<TSupervisor extends ISupervisor = ISupervisor>(name: SupervisorName): TSupervisor {
    const supervisor = this.supervisors[name];
    if (!supervisor) {
      throw new Error(`Supervisor "${name}" is not registered`);
    }

    return supervisor as TSupervisor;
  }

  registerSupervisor(supervisor: ISupervisor): void {
    this.supervisors[supervisor.name] = supervisor;
  }

  async activate(metadata?: unknown): Promise<void> {
    if (this.lifecycleState !== 'idle') {
      throw new Error(`Cannot activate meeting while runtime is ${this.lifecycleState}`);
    }

    const meetingId = randomUUID();
    this.lifecycleState = 'starting';
    this.activeMeetingId = meetingId;
    await this.bus.emit({ type: 'lifecycle:meeting-starting', meetingId });

    try {
      await this.delegate.startMeetingLegacy(metadata);
      this.lifecycleState = 'active';
      await this.bus.emit({ type: 'lifecycle:meeting-active', meetingId });
    } catch (error) {
      this.lifecycleState = 'idle';
      this.activeMeetingId = null;
      await this.bus.emit({ type: 'lifecycle:meeting-idle' });
      throw error;
    }
  }

  async deactivate(): Promise<void> {
    if (this.lifecycleState === 'idle') {
      this.logger.warn('[RuntimeCoordinator] Ignoring deactivate while runtime is idle');
      return;
    }

    if (this.lifecycleState === 'stopping') {
      this.logger.warn('[RuntimeCoordinator] Ignoring duplicate deactivate while runtime is stopping');
      return;
    }

    this.lifecycleState = 'stopping';
    await this.bus.emit({ type: 'lifecycle:meeting-stopping' });

    try {
      await this.delegate.endMeetingLegacy();
    } finally {
      this.lifecycleState = 'idle';
      this.activeMeetingId = null;
      await this.bus.emit({ type: 'lifecycle:meeting-idle' });
    }
  }
}
