export type DisguiseMode = 'terminal' | 'settings' | 'activity' | 'none';

export interface SettingsFacadeDeps {
setConsciousModeEnabled: (enabled: boolean) => boolean;
getConsciousModeEnabled: () => boolean;
setAccelerationModeEnabled: (enabled: boolean) => boolean;
getAccelerationModeEnabled: () => boolean;
setDisguise: (mode: DisguiseMode) => void;
getDisguise: () => string;
getUndetectable: () => boolean;
getThemeMode: () => string;
getResolvedTheme: () => string;
setThemeMode: (mode: string) => void;
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

  getThemeMode(): string {
    return this.deps.getThemeMode();
  }

  getResolvedTheme(): string {
    return this.deps.getResolvedTheme();
  }

  setThemeMode(mode: string): void {
    this.deps.setThemeMode(mode);
  }
}
