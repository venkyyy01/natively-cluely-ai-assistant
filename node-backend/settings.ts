// node-backend/settings.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface SettingsSchema {
  isUndetectable: boolean;
  disguiseMode: 'terminal' | 'settings' | 'activity' | 'none';
  overlayBounds: { x: number; y: number; width: number; height: number } | null;
  selectedModel: string;
  apiKeys: Record<string, string>;
  featureFlags: Record<string, boolean>;
}

const defaults: SettingsSchema = {
  isUndetectable: true,
  disguiseMode: 'none',
  overlayBounds: null,
  selectedModel: 'gpt-4o',
  apiKeys: {},
  featureFlags: {
    usePromptCompiler: true,
    useStreamManager: true,
    useEnhancedCache: true,
    useANEEmbeddings: true,
    useParallelContext: true,
    useAdaptiveWindow: true,
    usePrefetching: true,
  },
};

/**
 * Simple JSON file-based settings store.
 * Compatible with electron-store format for migration.
 * Store location: ~/Library/Application Support/natively/config.json
 */
class SettingsManager {
  private data: SettingsSchema;
  private configPath: string;
  private filePath: string;

  constructor() {
    // Use same location as electron-store for migration compatibility
    this.configPath = join(homedir(), 'Library', 'Application Support', 'natively');
    this.filePath = join(this.configPath, 'config.json');

    // Ensure config directory exists
    if (!existsSync(this.configPath)) {
      mkdirSync(this.configPath, { recursive: true });
    }

    // Load existing config or use defaults
    this.data = this.load();
  }

  private load(): SettingsSchema {
    try {
      if (existsSync(this.filePath)) {
        const content = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(content) as Partial<SettingsSchema>;
        // Merge with defaults to ensure all keys exist
        return { ...defaults, ...parsed };
      }
    } catch (error) {
      console.error('[Settings] Failed to load config:', error);
    }
    return { ...defaults };
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (error) {
      console.error('[Settings] Failed to save config:', error);
    }
  }

  get<K extends keyof SettingsSchema>(key: K): SettingsSchema[K] {
    return this.data[key];
  }

  set<K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]): void {
    this.data[key] = value;
    this.save();
  }

  getAll(): SettingsSchema {
    return { ...this.data };
  }

  reset(): void {
    this.data = { ...defaults };
    this.save();
  }
}

export const settings = new SettingsManager();
