import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface AppSettings {
// Only boot-critical or non-encrypted settings should live here.
// In the future, other non-secret data like 'language' or 'theme'
// can be moved here from CredentialsManager to allow early boot access.
isUndetectable?: boolean;
disguiseMode?: 'terminal' | 'settings' | 'activity' | 'none';
consciousModeEnabled?: boolean;
accelerationModeEnabled?: boolean;
enablePrivateMacosStealthApi?: boolean;
enableCaptureDetectionWatchdog?: boolean;
enableVirtualDisplayIsolation?: boolean;
captureToolPatterns?: string[];
}

const ALLOWED_DISGUISE_MODES = new Set<AppSettings['disguiseMode']>(['terminal', 'settings', 'activity', 'none']);

function sanitizeSettings(candidate: unknown): AppSettings {
  if (typeof candidate !== 'object' || candidate === null) {
    return {};
  }

  const raw = candidate as Record<string, unknown>;
  const sanitized: AppSettings = {};

  if (typeof raw.isUndetectable === 'boolean') {
    sanitized.isUndetectable = raw.isUndetectable;
  }

if (typeof raw.consciousModeEnabled === 'boolean') {
sanitized.consciousModeEnabled = raw.consciousModeEnabled;
}

if (typeof raw.accelerationModeEnabled === 'boolean') {
    sanitized.accelerationModeEnabled = raw.accelerationModeEnabled;
  }

  if (typeof raw.enablePrivateMacosStealthApi === 'boolean') {
    sanitized.enablePrivateMacosStealthApi = raw.enablePrivateMacosStealthApi;
  }

  if (typeof raw.enableCaptureDetectionWatchdog === 'boolean') {
    sanitized.enableCaptureDetectionWatchdog = raw.enableCaptureDetectionWatchdog;
  }

  if (typeof raw.enableVirtualDisplayIsolation === 'boolean') {
    sanitized.enableVirtualDisplayIsolation = raw.enableVirtualDisplayIsolation;
  }

  if (Array.isArray(raw.captureToolPatterns)) {
    const patterns = raw.captureToolPatterns.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (patterns.length > 0) {
      sanitized.captureToolPatterns = patterns;
    }
  }

  if (typeof raw.disguiseMode === 'string' && ALLOWED_DISGUISE_MODES.has(raw.disguiseMode as AppSettings['disguiseMode'])) {
    sanitized.disguiseMode = raw.disguiseMode as AppSettings['disguiseMode'];
  }

  return sanitized;
}

export class SettingsManager {
    private static instance: SettingsManager;
    private settings: AppSettings = {};
    private settingsPath: string;

    private constructor() {
        if (!app.isReady()) {
            throw new Error('[SettingsManager] Cannot initialize before app.whenReady()');
        }
        this.settingsPath = path.join(app.getPath('userData'), 'settings.json');
        this.loadSettings();
    }

    public static getInstance(): SettingsManager {
        if (!SettingsManager.instance) {
            SettingsManager.instance = new SettingsManager();
        }
        return SettingsManager.instance;
    }

    public get<K extends keyof AppSettings>(key: K): AppSettings[K] {
        return this.settings[key];
    }

  public set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): boolean {
    const previousSettings = { ...this.settings };
    this.settings[key] = value;
    if (this.saveSettings()) {
      return true;
    }

    this.settings = previousSettings;
    return false;
  }

  public getAccelerationModeEnabled(): boolean {
    return this.settings.accelerationModeEnabled ?? false;
  }

    private loadSettings(): void {
        try {
            if (fs.existsSync(this.settingsPath)) {
                const data = fs.readFileSync(this.settingsPath, 'utf8');
                try {
                    const parsed = JSON.parse(data);
                    // Minimal validation to ensure it's an object before assigning
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.settings = sanitizeSettings(parsed);
                        console.log('[SettingsManager] Settings loaded successfully:', JSON.stringify(this.settings));
                    } else {
                        throw new Error('Settings JSON is not a valid object');
                    }
                } catch (parseError) {
                    console.error('[SettingsManager] Failed to parse settings.json. Continuing with empty settings. Error:', parseError);
                    this.settings = {};
                }
                console.log('[SettingsManager] Settings loaded');
            }
        } catch (e) {
            console.error('[SettingsManager] Failed to read settings file:', e);
            this.settings = {};
        }
    }

    private saveSettings(): boolean {
        try {
            const tmpPath = this.settingsPath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(this.settings, null, 2));
            fs.renameSync(tmpPath, this.settingsPath);
            return true;
        } catch (e) {
            console.error('[SettingsManager] Failed to save settings:', e);
            return false;
        }
    }
}
