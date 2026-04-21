import { app } from 'electron';
import path from 'path';
import {
  ModelVersion,
  ModelFamily,
  TextModelFamily,
  TieredModels,
  FamilyState,
  type PersistedState,
  BASELINE_MODELS,
  TEXT_BASELINE_MODELS,
  VISION_PROVIDER_ORDER,
  TEXT_PROVIDER_ORDER,
  DISCOVERY_INTERVAL_MS,
  PERSISTENCE_FILENAME,
  MAX_DISCOVERY_FAILURES_BEFORE_BACKOFF,
  DISCOVERY_BACKOFF_MULTIPLIER,
  EVENT_DISCOVERY_COOLDOWN_MS,
} from './modelVersionTypes';
import { parseModelVersion } from './modelVersionUtils';
import { loadPersistedState, savePersistedState } from './modelVersionPersistence';
import { applyTierUpgradeRules } from './modelVersionTierUpgrade';
import {
  discoverOpenAIModels,
  discoverGeminiModels,
  discoverClaudeModels,
  discoverGroqModels,
} from './modelVersionProviderDiscovery';

export { ModelVersion, ModelFamily, TextModelFamily, TieredModels } from './modelVersionTypes';
export { parseModelVersion, compareVersions, versionDistance, classifyModel, classifyTextModel } from './modelVersionUtils';

export class ModelVersionManager {
  private state: PersistedState;
  private persistPath: string;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventTriggeredDiscovery: number = 0;

  private openaiApiKey: string | null = null;
  private geminiApiKey: string | null = null;
  private claudeApiKey: string | null = null;
  private groqApiKey: string | null = null;

  constructor() {
    this.persistPath = path.join(app.getPath('userData'), PERSISTENCE_FILENAME);
    this.state = loadPersistedState(this.persistPath);
  }

  public setApiKeys(keys: {
    openai?: string | null;
    gemini?: string | null;
    claude?: string | null;
    groq?: string | null;
  }): void {
    if (keys.openai !== undefined) this.openaiApiKey = keys.openai;
    if (keys.gemini !== undefined) this.geminiApiKey = keys.gemini;
    if (keys.claude !== undefined) this.claudeApiKey = keys.claude;
    if (keys.groq !== undefined) this.groqApiKey = keys.groq;
  }

  public getTieredModels(family: ModelFamily): TieredModels {
    const familyState = this.state.families[family];
    if (!familyState) {
      const baseline = BASELINE_MODELS[family];
      return { tier1: baseline, tier2: baseline, tier3: baseline };
    }
    const latestOrTier1 = familyState.latest || familyState.tier1;
    return {
      tier1: familyState.tier1,
      tier2: latestOrTier1,
      tier3: latestOrTier1,
    };
  }

  public getAllVisionTiers(): Array<{ family: ModelFamily } & TieredModels> {
    return VISION_PROVIDER_ORDER.map((family) => ({
      family,
      ...this.getTieredModels(family),
    }));
  }

  public getTextTieredModels(family: TextModelFamily): TieredModels {
    const familyState = this.state.families[family];
    if (!familyState) {
      const baseline = TEXT_BASELINE_MODELS[family];
      return { tier1: baseline, tier2: baseline, tier3: baseline };
    }
    const latestOrTier1 = familyState.latest || familyState.tier1;
    return {
      tier1: familyState.tier1,
      tier2: latestOrTier1,
      tier3: latestOrTier1,
    };
  }

  public getAllTextTiers(): Array<{ family: TextModelFamily } & TieredModels> {
    return TEXT_PROVIDER_ORDER.map((family) => ({
      family,
      ...this.getTextTieredModels(family),
    }));
  }

  public async onModelError(failedModelId: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastEventTriggeredDiscovery < EVENT_DISCOVERY_COOLDOWN_MS) {
      console.log(`[ModelVersionManager] Event-driven discovery skipped (cooldown active)`);
      return;
    }

    console.log(`[ModelVersionManager] 🔥 Model error on "${failedModelId}" — triggering discovery`);
    this.lastEventTriggeredDiscovery = now;

    try {
      await this.runDiscoveryAndUpgrade();
    } catch (err: any) {
      console.warn(`[ModelVersionManager] Event-driven discovery failed: ${err.message}`);
    }
  }

  public rollback(family: ModelFamily | TextModelFamily): boolean {
    const familyState = this.state.families[family];
    if (!familyState) return false;

    const rolledBack = !!(familyState.previousTier1 || familyState.previousLatest);

    if (familyState.previousTier1) {
      console.log(`[ModelVersionManager] ↩️ Rolling back ${family} Tier1: ${familyState.tier1} → ${familyState.previousTier1}`);
      familyState.tier1 = familyState.previousTier1;
      familyState.tier1Version = parseModelVersion(familyState.previousTier1);
      familyState.previousTier1 = null;
    }

    if (familyState.previousLatest) {
      console.log(`[ModelVersionManager] ↩️ Rolling back ${family} Latest: ${familyState.latest} → ${familyState.previousLatest}`);
      familyState.latest = familyState.previousLatest;
      familyState.latestVersion = parseModelVersion(familyState.previousLatest);
      familyState.previousLatest = null;
    }

    if (rolledBack) this.persistState();
    return rolledBack;
  }

  public async initialize(): Promise<void> {
    const timeSinceLastDiscovery = Date.now() - this.state.lastDiscoveryTimestamp;

    if (timeSinceLastDiscovery >= DISCOVERY_INTERVAL_MS || this.state.lastDiscoveryTimestamp === 0) {
      console.log('[ModelVersionManager] Running initial model discovery (non-blocking)...');
      try {
        await this.runDiscoveryAndUpgrade();
      } catch (err: any) {
        console.warn(`[ModelVersionManager] Initial discovery failed (using baselines): ${err.message}`);
      }
    } else {
      const daysUntilNext = Math.round((DISCOVERY_INTERVAL_MS - timeSinceLastDiscovery) / (24 * 60 * 60 * 1000));
      console.log(`[ModelVersionManager] Next scheduled discovery in ~${daysUntilNext} days`);
    }

    this.startBackgroundScheduler();
  }

  public async runDiscoveryAndUpgrade(): Promise<void> {
    console.log('[ModelVersionManager] 🔍 Starting model discovery...');

    const discovered = new Map<ModelFamily, { modelId: string; version: ModelVersion }>();
    const textDiscovered = new Map<TextModelFamily, { modelId: string; version: ModelVersion }>();
    const discoveryPromises: Promise<void>[] = [];

    if (this.openaiApiKey && this.shouldAttemptDiscovery('openai')) {
      discoveryPromises.push(
        discoverOpenAIModels(
          this.openaiApiKey,
          discovered,
          textDiscovered,
          () => this.recordDiscoverySuccess('openai'),
          () => this.recordDiscoveryFailure('openai'),
        ),
      );
    }
    if (this.geminiApiKey && this.shouldAttemptDiscovery('gemini')) {
      discoveryPromises.push(
        discoverGeminiModels(
          this.geminiApiKey,
          discovered,
          textDiscovered,
          () => this.recordDiscoverySuccess('gemini'),
          () => this.recordDiscoveryFailure('gemini'),
        ),
      );
    }
    if (this.claudeApiKey && this.shouldAttemptDiscovery('anthropic')) {
      discoveryPromises.push(
        discoverClaudeModels(
          this.claudeApiKey,
          discovered,
          textDiscovered,
          () => this.recordDiscoverySuccess('anthropic'),
          () => this.recordDiscoveryFailure('anthropic'),
        ),
      );
    }
    if (this.groqApiKey && this.shouldAttemptDiscovery('groq')) {
      discoveryPromises.push(
        discoverGroqModels(
          this.groqApiKey,
          discovered,
          textDiscovered,
          () => this.recordDiscoverySuccess('groq'),
          () => this.recordDiscoveryFailure('groq'),
        ),
      );
    }

    await Promise.allSettled(discoveryPromises);

    let upgraded = false;
    for (const [family, { modelId, version }] of discovered) {
      if (this.applyUpgradeRules(family, modelId, version)) upgraded = true;
    }

    for (const [family, { modelId, version }] of textDiscovered) {
      if (this.applyUpgradeRulesForTextFamily(family, modelId, version)) upgraded = true;
    }

    this.state.lastDiscoveryTimestamp = Date.now();
    this.persistState();

    if (upgraded) {
      console.log('[ModelVersionManager] ✅ Model tiers updated and persisted.');
    } else {
      console.log('[ModelVersionManager] ✅ Discovery complete. No tier changes needed.');
    }
  }

  private shouldAttemptDiscovery(provider: string): boolean {
    const failures = this.state.discoveryFailureCounts[provider] || 0;
    if (failures < MAX_DISCOVERY_FAILURES_BEFORE_BACKOFF) return true;

    const backoffFactor = Math.pow(DISCOVERY_BACKOFF_MULTIPLIER, failures - MAX_DISCOVERY_FAILURES_BEFORE_BACKOFF);
    const effectiveInterval = DISCOVERY_INTERVAL_MS * backoffFactor;
    const timeSinceLast = Date.now() - this.state.lastDiscoveryTimestamp;

    if (timeSinceLast < effectiveInterval) {
      console.log(
        `[ModelVersionManager] Skipping ${provider} discovery (${failures} consecutive failures, backoff ${Math.round(effectiveInterval / (24 * 60 * 60 * 1000))}d)`,
      );
      return false;
    }
    return true;
  }

  private recordDiscoverySuccess(provider: string): void {
    this.state.discoveryFailureCounts[provider] = 0;
  }

  private recordDiscoveryFailure(provider: string): void {
    this.state.discoveryFailureCounts[provider] = (this.state.discoveryFailureCounts[provider] || 0) + 1;
  }

  private applyUpgradeRules(family: ModelFamily, discoveredModelId: string, discoveredVersion: ModelVersion): boolean {
    const familyState = this.ensureFamilyState(family);
    return applyTierUpgradeRules(familyState, discoveredModelId, discoveredVersion, family, 'vision', false);
  }

  private applyUpgradeRulesForTextFamily(
    family: TextModelFamily,
    discoveredModelId: string,
    discoveredVersion: ModelVersion,
  ): boolean {
    const familyState = this.ensureTextFamilyState(family);
    return applyTierUpgradeRules(familyState, discoveredModelId, discoveredVersion, family, 'text', true);
  }

  private startBackgroundScheduler(): void {
    if (this.discoveryTimer) return;

    this.discoveryTimer = setInterval(async () => {
      console.log('[ModelVersionManager] ⏰ Scheduled model discovery triggered');
      try {
        await this.runDiscoveryAndUpgrade();
      } catch (err: any) {
        console.error('[ModelVersionManager] Scheduled discovery failed:', err.message);
      }
    }, DISCOVERY_INTERVAL_MS);

    if (this.discoveryTimer && typeof this.discoveryTimer === 'object' && 'unref' in this.discoveryTimer) {
      this.discoveryTimer.unref();
    }

    console.log('[ModelVersionManager] 📅 Background scheduler started (every ~14 days)');
  }

  public stopScheduler(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
      console.log('[ModelVersionManager] Background scheduler stopped');
    }
  }

  private persistState(): void {
    savePersistedState(this.persistPath, this.state);
  }

  private ensureFamilyState(family: ModelFamily): FamilyState {
    if (!this.state.families[family]) {
      const baseline = BASELINE_MODELS[family];
      const version = parseModelVersion(baseline);
      this.state.families[family] = {
        baseline,
        tier1: baseline,
        latest: baseline,
        latestVersion: version,
        tier1Version: version,
        previousTier1: null,
        previousLatest: null,
      };
    }
    return this.state.families[family];
  }

  private ensureTextFamilyState(family: TextModelFamily): FamilyState {
    if (!this.state.families[family]) {
      const baseline = TEXT_BASELINE_MODELS[family];
      const version = parseModelVersion(baseline);
      this.state.families[family] = {
        baseline,
        tier1: baseline,
        latest: baseline,
        latestVersion: version,
        tier1Version: version,
        previousTier1: null,
        previousLatest: null,
      };
    }
    return this.state.families[family];
  }

  public getSummary(): string {
    const lines = ['[ModelVersionManager] Current Model Tiers:'];

    lines.push('  --- Vision ---');
    for (const family of VISION_PROVIDER_ORDER) {
      const tiers = this.getTieredModels(family);
      lines.push(`  ${family}: T1=${tiers.tier1} | T2/T3=${tiers.tier2}`);
    }

    lines.push('  --- Text ---');
    for (const family of TEXT_PROVIDER_ORDER) {
      const tiers = this.getTextTieredModels(family);
      lines.push(`  ${family}: T1=${tiers.tier1} | T2/T3=${tiers.tier2}`);
    }

    const allFamilyKeys = [...VISION_PROVIDER_ORDER.map((f) => f as string), ...TEXT_PROVIDER_ORDER.map((f) => f as string)];
    const rollbackAvailable = allFamilyKeys.filter((f) => {
      const s = this.state.families[f];
      return s && (s.previousTier1 || s.previousLatest);
    });
    if (rollbackAvailable.length > 0) {
      lines.push(`  Rollback available for: ${rollbackAvailable.join(', ')}`);
    }

    lines.push(
      `  Last discovery: ${this.state.lastDiscoveryTimestamp ? new Date(this.state.lastDiscoveryTimestamp).toISOString() : 'never'}`,
    );
    lines.push(`  Discovery interval: 14 days`);
    return lines.join('\n');
  }
}
