import { randomUUID } from 'node:crypto';

import { SupervisorBus } from './SupervisorBus';
import type { ISupervisor, RuntimeLifecycleState, SupervisorName } from './types';

export type RuntimeOwnershipMode = 'legacy' | 'coordinator';

export interface RuntimeCoordinatorDelegate {
  startMeetingLegacy(metadata?: unknown, mode?: RuntimeOwnershipMode): Promise<void>;
  endMeetingLegacy(mode?: RuntimeOwnershipMode): Promise<void>;
}

interface RuntimeCoordinatorOptions {
  bus?: SupervisorBus;
  logger?: Pick<Console, 'warn'>;
  featureFlagReader?: () => boolean;
  supervisors?: Partial<Record<SupervisorName, ISupervisor>>;
  managedSupervisorNames?: SupervisorName[];
}

export class RuntimeCoordinator {
  private readonly bus: SupervisorBus;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly featureFlagReader: () => boolean;
  private readonly supervisors: Partial<Record<SupervisorName, ISupervisor>>;
  private readonly managedSupervisorNames: SupervisorName[];
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
    this.managedSupervisorNames = options.managedSupervisorNames ?? ['recovery', 'audio', 'stt'];
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

  async startSupervisors(names: SupervisorName[]): Promise<void> {
    const started: SupervisorName[] = [];

    try {
      for (const name of names) {
        const supervisor = this.getSupervisor(name);
        if (supervisor.getState() === 'running') {
          continue;
        }

        await supervisor.start();
        started.push(name);
      }
    } catch (error) {
      await this.rollbackStartedSupervisors(started);
      throw error;
    }
  }

  async stopSupervisors(names: SupervisorName[]): Promise<void> {
    let firstError: unknown = null;

    for (const name of [...names].reverse()) {
      try {
        await this.getSupervisor(name).stop();
      } catch (error) {
        this.logger.warn(`[RuntimeCoordinator] Failed stopping supervisor "${name}":`, error);
        firstError ??= error;
      }
    }

    if (firstError) {
      throw firstError;
    }
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
      await this.delegate.startMeetingLegacy(metadata, 'coordinator');
      await this.startSupervisors(this.managedSupervisorNames);
      this.lifecycleState = 'active';
      await this.bus.emit({ type: 'lifecycle:meeting-active', meetingId });
    } catch (error) {
      await this.rollbackCoordinatorActivation();
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
      await this.stopSupervisors(this.managedSupervisorNames);
      await this.delegate.endMeetingLegacy('coordinator');
    } finally {
      this.lifecycleState = 'idle';
      this.activeMeetingId = null;
      await this.bus.emit({ type: 'lifecycle:meeting-idle' });
    }
  }

  private async rollbackCoordinatorActivation(): Promise<void> {
    try {
      await this.stopSupervisors(this.managedSupervisorNames);
    } catch (error) {
      this.logger.warn('[RuntimeCoordinator] Failed stopping supervisors during activation rollback:', error);
    }

    try {
      await this.delegate.endMeetingLegacy('coordinator');
    } catch (error) {
      this.logger.warn('[RuntimeCoordinator] Failed ending legacy meeting state during activation rollback:', error);
    }
  }

  private async rollbackStartedSupervisors(names: SupervisorName[]): Promise<void> {
    for (const name of [...names].reverse()) {
      try {
        await this.getSupervisor(name).stop();
      } catch (error) {
        this.logger.warn(`[RuntimeCoordinator] Failed rolling back supervisor "${name}":`, error);
      }
    }
  }
}
