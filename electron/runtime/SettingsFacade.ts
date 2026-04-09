export type DisguiseMode = 'terminal' | 'settings' | 'activity' | 'none';

export interface SettingsFacadeDeps {
  setConsciousModeEnabled: (enabled: boolean) => boolean;
  getConsciousModeEnabled: () => boolean;
  setAccelerationModeEnabled: (enabled: boolean) => boolean;
  getAccelerationModeEnabled: () => boolean;
  setDisguise: (mode: DisguiseMode) => void;
  getDisguise: () => string;
  getUndetectable: () => boolean;
}

export class SettingsFacade {
  constructor(private readonly deps: SettingsFacadeDeps) {}

  setConsciousModeEnabled(enabled: boolean): boolean {
    return this.deps.setConsciousModeEnabled(enabled);
  }

  getConsciousModeEnabled(): boolean {
    return this.deps.getConsciousModeEnabled();
  }

  setAccelerationModeEnabled(enabled: boolean): boolean {
    return this.deps.setAccelerationModeEnabled(enabled);
  }

  getAccelerationModeEnabled(): boolean {
    return this.deps.getAccelerationModeEnabled();
  }

  setDisguise(mode: DisguiseMode): void {
    this.deps.setDisguise(mode);
  }

  getDisguise(): string {
    return this.deps.getDisguise();
  }

  getUndetectable(): boolean {
    return this.deps.getUndetectable();
  }
}
