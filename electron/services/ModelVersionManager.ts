import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  ModelVersion,
  ModelFamily,
  TextModelFamily,
  TieredModels,
  FamilyState,
  PersistedState,
  BASELINE_MODELS,
  TEXT_BASELINE_MODELS,
  VISION_PROVIDER_ORDER,
  TEXT_PROVIDER_ORDER,
  SCHEMA_VERSION,
  DISCOVERY_INTERVAL_MS,
  PERSISTENCE_FILENAME,
  MAX_DISCOVERY_FAILURES_BEFORE_BACKOFF,
  DISCOVERY_BACKOFF_MULTIPLIER,
  EVENT_DISCOVERY_COOLDOWN_MS,
} from './modelVersionTypes';
import { parseModelVersion, compareVersions, versionDistance, classifyModel, classifyTextModel } from './modelVersionUtils';

// Re-exports for backwards compatibility — consumers may import these from ModelVersionManager directly
export { ModelVersion, ModelFamily, TextModelFamily, TieredModels } from './modelVersionTypes';
export { parseModelVersion, compareVersions, versionDistance, classifyModel, classifyTextModel } from './modelVersionUtils';

export class ModelVersionManager {
  private state: PersistedState;
  private persistPath: string;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventTriggeredDiscovery: number = 0;

  // Provider API keys (set externally via setApiKeys)
  private openaiApiKey: string | null = null;
  private geminiApiKey: string | null = null;
  private claudeApiKey: string | null = null;
  private groqApiKey: string | null = null;

  constructor() {
    this.persistPath = path.join(app.getPath('userData'), PERSISTENCE_FILENAME);
    this.state = this.loadState();
  }

  // ─── Client Configuration ──────────────────────────────────────────

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

  // ─── Tier Retrieval ────────────────────────────────────────────────

  /**
   * Get the tiered model IDs for a given family.
   *
   * Tier 1 = promoted stable
   * Tier 2 = latest discovered
   * Tier 3 = same as Tier 2 (pure retry pass with exponential backoff)
   *
   * If no discovery has happened yet, all tiers return the baseline immediately.
   */
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

  /**
   * Get all tiered models for every vision provider in priority order.
   */
  public getAllVisionTiers(): Array<{ family: ModelFamily } & TieredModels> {
    return VISION_PROVIDER_ORDER.map(family => ({
      family,
      ...this.getTieredModels(family),
    }));
  }

  // ─── Text Tier Retrieval ─────────────────────────────────────────────

  /**
   * Get the tiered text model IDs for a given text family.
   * Same tier logic as vision but with separate baselines.
   */
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

  /**
   * Get all tiered text models for every text provider in priority order.
   */
  public getAllTextTiers(): Array<{ family: TextModelFamily } & TieredModels> {
    return TEXT_PROVIDER_ORDER.map(family => ({
      family,
      ...this.getTextTieredModels(family),
    }));
  }

  // ─── Event-Driven Discovery ────────────────────────────────────────

  /**
   * Trigger discovery in response to a model-not-found error (404, deprecated, etc).
   * Throttled to at most once per hour to prevent API hammering.
   */
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

  // ─── Rollback ──────────────────────────────────────────────────────

  /**
   * Roll back a specific family (vision or text) to its previous tier state.
   * Useful if a newly promoted model shows degraded performance.
   */
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

  // ─── Discovery ─────────────────────────────────────────────────────

  /**
   * Initialize: run first discovery if stale/never run, then start scheduler.
   *
   * IMPORTANT: This method is always called async (fire-and-forget) from the
   * app startup path. It NEVER blocks the UI thread. If discovery fails or
   * hasn't completed yet, all tiers fall back to the hardcoded baseline
   * models immediately — the app is always usable.
   */
  public async initialize(): Promise<void> {
    const timeSinceLastDiscovery = Date.now() - this.state.lastDiscoveryTimestamp;

    if (timeSinceLastDiscovery >= DISCOVERY_INTERVAL_MS || this.state.lastDiscoveryTimestamp === 0) {
      console.log('[ModelVersionManager] Running initial model discovery (non-blocking)...');
      try {
        await this.runDiscoveryAndUpgrade();
      } catch (err: any) {
        // Non-fatal: baseline models are always available
        console.warn(`[ModelVersionManager] Initial discovery failed (using baselines): ${err.message}`);
      }
    } else {
      const daysUntilNext = Math.round((DISCOVERY_INTERVAL_MS - timeSinceLastDiscovery) / (24 * 60 * 60 * 1000));
      console.log(`[ModelVersionManager] Next scheduled discovery in ~${daysUntilNext} days`);
    }

    this.startBackgroundScheduler();
  }

  /**
   * Query all provider APIs for available models, find the latest in each family,
   * then apply upgrade rules. Each provider query is individually error-handled.
   */
  public async runDiscoveryAndUpgrade(): Promise<void> {
    console.log('[ModelVersionManager] 🔍 Starting model discovery...');

    const discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }> = new Map();
    const textDiscovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }> = new Map();
    const discoveryPromises: Promise<void>[] = [];

    if (this.openaiApiKey && this.shouldAttemptDiscovery('openai')) {
      discoveryPromises.push(this.discoverOpenAIModels(discovered, textDiscovered));
    }
    if (this.geminiApiKey && this.shouldAttemptDiscovery('gemini')) {
      discoveryPromises.push(this.discoverGeminiModels(discovered, textDiscovered));
    }
    if (this.claudeApiKey && this.shouldAttemptDiscovery('anthropic')) {
      discoveryPromises.push(this.discoverClaudeModels(discovered, textDiscovered));
    }
    if (this.groqApiKey && this.shouldAttemptDiscovery('groq')) {
      discoveryPromises.push(this.discoverGroqModels(discovered, textDiscovered));
    }

    await Promise.allSettled(discoveryPromises);

    // Apply upgrade rules for each discovered vision family
    let upgraded = false;
    for (const [family, { modelId, version }] of discovered) {
      const changed = this.applyUpgradeRules(family, modelId, version);
      if (changed) upgraded = true;
    }

    // Apply upgrade rules for each discovered text family
    for (const [family, { modelId, version }] of textDiscovered) {
      const changed = this.applyUpgradeRulesForTextFamily(family, modelId, version);
      if (changed) upgraded = true;
    }

    this.state.lastDiscoveryTimestamp = Date.now();
    this.persistState();

    if (upgraded) {
      console.log('[ModelVersionManager] ✅ Model tiers updated and persisted.');
    } else {
      console.log('[ModelVersionManager] ✅ Discovery complete. No tier changes needed.');
    }
  }

  // ─── Rate-Limiting for Discovery ───────────────────────────────────

  /**
   * Check if we should attempt discovery for a provider based on failure history.
   * After MAX_DISCOVERY_FAILURES_BEFORE_BACKOFF consecutive failures, we back off
   * exponentially (2x, 4x, 8x of the base interval) before retrying.
   */
  private shouldAttemptDiscovery(provider: string): boolean {
    const failures = this.state.discoveryFailureCounts[provider] || 0;
    if (failures < MAX_DISCOVERY_FAILURES_BEFORE_BACKOFF) return true;

    // Exponential backoff: after N failures beyond threshold,
    // skip discovery proportionally
    const backoffFactor = Math.pow(DISCOVERY_BACKOFF_MULTIPLIER, failures - MAX_DISCOVERY_FAILURES_BEFORE_BACKOFF);
    const effectiveInterval = DISCOVERY_INTERVAL_MS * backoffFactor;
    const timeSinceLast = Date.now() - this.state.lastDiscoveryTimestamp;

    if (timeSinceLast < effectiveInterval) {
      console.log(`[ModelVersionManager] Skipping ${provider} discovery (${failures} consecutive failures, backoff ${Math.round(effectiveInterval / (24 * 60 * 60 * 1000))}d)`);
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

  // ─── Provider Discovery Implementations ────────────────────────────

  private async discoverOpenAIModels(
    discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>,
    textDiscovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>
  ): Promise<void> {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${this.openaiApiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        this.recordDiscoveryFailure('openai');
        console.warn(`[ModelVersionManager] OpenAI model listing failed: ${response.status}`);
        return;
      }
      const json: any = await response.json();
      const models: string[] = (json.data || []).map((m: any) => m.id);

      this.findLatestInFamily(models, ModelFamily.OPENAI, discovered);
      this.findLatestInTextFamily(models, TextModelFamily.OPENAI, textDiscovered);
      this.recordDiscoverySuccess('openai');
    } catch (err: any) {
      this.recordDiscoveryFailure('openai');
      console.warn(`[ModelVersionManager] OpenAI discovery error: ${err.message}`);
    }
  }

  private async discoverGeminiModels(
    discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>,
    textDiscovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>
  ): Promise<void> {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.geminiApiKey}`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!response.ok) {
        this.recordDiscoveryFailure('gemini');
        console.warn(`[ModelVersionManager] Gemini model listing failed: ${response.status}`);
        return;
      }
      const json: any = await response.json();
      const models: string[] = (json.models || []).map((m: any) =>
        (m.name || '').replace(/^models\//, '')
      );

      this.findLatestInFamily(models, ModelFamily.GEMINI_FLASH, discovered);
      this.findLatestInFamily(models, ModelFamily.GEMINI_PRO, discovered);
      this.findLatestInTextFamily(models, TextModelFamily.GEMINI_FLASH, textDiscovered);
      this.findLatestInTextFamily(models, TextModelFamily.GEMINI_PRO, textDiscovered);
      this.recordDiscoverySuccess('gemini');
    } catch (err: any) {
      this.recordDiscoveryFailure('gemini');
      console.warn(`[ModelVersionManager] Gemini discovery error: ${err.message}`);
    }
  }

  /**
   * Anthropic model discovery using their official /v1/models endpoint.
   * Handles pagination and sorts by newest first (Anthropic default).
   */
  private async discoverClaudeModels(
    discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>,
    textDiscovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>
  ): Promise<void> {
    try {
      const allModels: string[] = [];
      let hasMore = true;
      let afterId: string | null = null;

      while (hasMore) {
        const url = afterId
          ? `https://api.anthropic.com/v1/models?limit=100&after_id=${encodeURIComponent(afterId)}`
          : 'https://api.anthropic.com/v1/models?limit=100';

        const response = await fetch(url, {
          headers: {
            'x-api-key': this.claudeApiKey!,
            'anthropic-version': '2023-06-01',
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          this.recordDiscoveryFailure('anthropic');
          console.warn(`[ModelVersionManager] Anthropic model listing failed: ${response.status}`);
          return;
        }

        const json: any = await response.json();
        const pageModels: string[] = (json.data || []).map((m: any) => m.id);
        allModels.push(...pageModels);

        hasMore = json.has_more === true;
        afterId = json.last_id || null;

        // Safety: cap pagination at 5 pages (500 models) to avoid runaway loops
        if (allModels.length > 500) {
          console.warn('[ModelVersionManager] Anthropic discovery capped at 500 models');
          break;
        }
      }

      this.findLatestInFamily(allModels, ModelFamily.CLAUDE, discovered);
      this.findLatestInTextFamily(allModels, TextModelFamily.CLAUDE, textDiscovered);
      this.recordDiscoverySuccess('anthropic');
    } catch (err: any) {
      this.recordDiscoveryFailure('anthropic');
      console.warn(`[ModelVersionManager] Anthropic discovery error: ${err.message}`);
    }
  }

  private async discoverGroqModels(
    discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>,
    textDiscovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>
  ): Promise<void> {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${this.groqApiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        this.recordDiscoveryFailure('groq');
        console.warn(`[ModelVersionManager] Groq model listing failed: ${response.status}`);
        return;
      }
      const json: any = await response.json();
      const models: string[] = (json.data || []).map((m: any) => m.id);

      this.findLatestInFamily(models, ModelFamily.GROQ_LLAMA, discovered);
      this.findLatestInTextFamily(models, TextModelFamily.GROQ, textDiscovered);
      this.recordDiscoverySuccess('groq');
    } catch (err: any) {
      this.recordDiscoveryFailure('groq');
      console.warn(`[ModelVersionManager] Groq discovery error: ${err.message}`);
    }
  }

  /**
   * From a list of model IDs, find the highest-versioned one in `family`.
   */
  private findLatestInFamily(
    modelIds: string[],
    family: ModelFamily,
    discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>
  ): void {
    let best: { modelId: string; version: ModelVersion } | null = discovered.get(family) || null;

    for (const modelId of modelIds) {
      const classified = classifyModel(modelId);
      if (classified !== family) continue;

      const version = parseModelVersion(modelId);
      if (!version) continue;

      if (!best || compareVersions(version, best.version) > 0) {
        best = { modelId, version };
      }
    }

    if (best) {
      discovered.set(family, best);
    }
  }

  /**
   * From a list of model IDs, find the highest-versioned one in a text `family`.
   */
  private findLatestInTextFamily(
    modelIds: string[],
    family: TextModelFamily,
    discovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>
  ): void {
    let best: { modelId: string; version: ModelVersion } | null = discovered.get(family) || null;

    for (const modelId of modelIds) {
      const classified = classifyTextModel(modelId);
      if (classified !== family) continue;

      const version = parseModelVersion(modelId);
      if (!version) continue;

      if (!best || compareVersions(version, best.version) > 0) {
        best = { modelId, version };
      }
    }

    if (best) {
      discovered.set(family, best);
    }
  }

  // ─── Upgrade Rules ─────────────────────────────────────────────────

  /**
   * Apply the tiered upgrade logic for a single model family.
   *
   * Rules:
   *   1. Latest discovered model ALWAYS becomes Tier 2/3 (retry passes).
   *   2. Tier 1 is upgraded only when:
   *      a. Major version jump (5.x → 6.x):
   *         - Tier 1 becomes the PREVIOUS stable latest (last 5.x model)
   *         - Tier 2/3 becomes the new major (6.x)
   *         - This avoids all tiers having the same untested model.
   *      b. 2+ minor versions ahead within same major:
   *         - Tier 1 promoted to the previous latest (proven stepping stone)
   *
   * Previous state is preserved for rollback.
   *
   * Returns true if any tier was changed.
   */
  private applyUpgradeRules(
    family: ModelFamily,
    discoveredModelId: string,
    discoveredVersion: ModelVersion
  ): boolean {
    const familyState = this.ensureFamilyState(family);
    const prevLatest = familyState.latest;
    const prevTier1 = familyState.tier1;

    // Preserve rollback state BEFORE making changes
    familyState.previousTier1 = familyState.tier1;
    familyState.previousLatest = familyState.latest;

    // Always update Tier 2/3 to the latest discovered
    familyState.latest = discoveredModelId;
    familyState.latestVersion = discoveredVersion;

    // Determine if Tier 1 needs promotion
    const tier1Version = familyState.tier1Version;
    if (tier1Version) {
      const distance = versionDistance(tier1Version, discoveredVersion);

      if (discoveredVersion.major > tier1Version.major) {
        // ─── MAJOR VERSION JUMP ──────────────────────────────────
        // Tier 1 gets the PREVIOUS stable (last model from old major series),
        // NOT the new major version directly. This ensures Tier 1 stays proven
        // while Tier 2/3 test the new major.
        if (prevLatest && prevLatest !== prevTier1) {
          const prevLatestVersion = parseModelVersion(prevLatest);
          if (prevLatestVersion && compareVersions(prevLatestVersion, tier1Version) > 0) {
            console.log(
              `[ModelVersionManager] 🚀 MAJOR upgrade for ${family}: ` +
              `Tier1 → ${prevLatest} (last stable), Tier2/3 → ${discoveredModelId} (new major)`
            );
            familyState.tier1 = prevLatest;
            familyState.tier1Version = prevLatestVersion;
          }
        }
        // If no previous latest exists, Tier 1 stays at current (conservative)
        // Tier 2/3 already updated to the new major version above

      } else if (distance >= 2) {
        // ─── 2+ MINOR VERSIONS AHEAD ─────────────────────────────
        // Promote Tier 1 to the previous latest (proven stepping stone)
        if (prevLatest && prevLatest !== prevTier1) {
          const prevLatestVersion = parseModelVersion(prevLatest);
          if (prevLatestVersion && compareVersions(prevLatestVersion, tier1Version) > 0) {
            console.log(
              `[ModelVersionManager] ⬆️ Tier 1 promotion for ${family}: ` +
              `${tier1Version.raw} → ${prevLatest} (${distance.toFixed(1)} minor versions behind)`
            );
            familyState.tier1 = prevLatest;
            familyState.tier1Version = prevLatestVersion;
          }
        }
      }
    }

    const changed = familyState.latest !== prevLatest || familyState.tier1 !== prevTier1;

    // Don't clutter rollback state if nothing actually changed
    if (!changed) {
      familyState.previousTier1 = null;
      familyState.previousLatest = null;
    } else {
      console.log(
        `[ModelVersionManager] ${family} tiers: ` +
        `Tier1=${familyState.tier1}, Tier2/3=${familyState.latest}`
      );
    }

    return changed;
  }

  /**
   * Apply the same tiered upgrade logic for text model families.
   * Identical rules to vision but uses TextModelFamily and TEXT_BASELINE_MODELS.
   */
  private applyUpgradeRulesForTextFamily(
    family: TextModelFamily,
    discoveredModelId: string,
    discoveredVersion: ModelVersion
  ): boolean {
    const familyState = this.ensureTextFamilyState(family);
    const prevLatest = familyState.latest;
    const prevTier1 = familyState.tier1;

    // Preserve rollback state
    familyState.previousTier1 = familyState.tier1;
    familyState.previousLatest = familyState.latest;

    // Always update Tier 2/3
    familyState.latest = discoveredModelId;
    familyState.latestVersion = discoveredVersion;

    const tier1Version = familyState.tier1Version;
    if (tier1Version) {
      const distance = versionDistance(tier1Version, discoveredVersion);

      if (discoveredVersion.major > tier1Version.major) {
        // Major jump: Tier 1 → previous stable, Tier 2/3 → new major
        if (prevLatest && prevLatest !== prevTier1) {
          const prevLatestVersion = parseModelVersion(prevLatest);
          if (prevLatestVersion && compareVersions(prevLatestVersion, tier1Version) > 0) {
            console.log(
              `[ModelVersionManager] 🚀 MAJOR text upgrade for ${family}: ` +
              `Tier1 → ${prevLatest}, Tier2/3 → ${discoveredModelId}`
            );
            familyState.tier1 = prevLatest;
            familyState.tier1Version = prevLatestVersion;
          }
        }
      } else if (distance >= 2) {
        // 2+ minor versions: promote Tier 1
        if (prevLatest && prevLatest !== prevTier1) {
          const prevLatestVersion = parseModelVersion(prevLatest);
          if (prevLatestVersion && compareVersions(prevLatestVersion, tier1Version) > 0) {
            console.log(
              `[ModelVersionManager] ⬆️ Text Tier 1 promotion for ${family}: ` +
              `${tier1Version.raw} → ${prevLatest}`
            );
            familyState.tier1 = prevLatest;
            familyState.tier1Version = prevLatestVersion;
          }
        }
      }
    }

    const changed = familyState.latest !== prevLatest || familyState.tier1 !== prevTier1;
    if (!changed) {
      familyState.previousTier1 = null;
      familyState.previousLatest = null;
    } else {
      console.log(
        `[ModelVersionManager] ${family} text tiers: ` +
        `Tier1=${familyState.tier1}, Tier2/3=${familyState.latest}`
      );
    }

    return changed;
  }

  // ─── Background Scheduler ──────────────────────────────────────────

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

    // Don't block app exit
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

  // ─── State Persistence ─────────────────────────────────────────────

  private loadState(): PersistedState {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const parsed: PersistedState = JSON.parse(raw);

        if (parsed.schemaVersion === SCHEMA_VERSION) {
          console.log('[ModelVersionManager] Loaded persisted state from disk');
          return parsed;
        }

        // Schema migration: preserve what we can from v1
        if (parsed.schemaVersion === 1) {
          console.log('[ModelVersionManager] Migrating v1 → v3 state');
          const migrated = this.createDefaultState();
          for (const [family, state] of Object.entries(parsed.families || {})) {
            if (migrated.families[family]) {
              migrated.families[family].tier1 = (state as any).tier1 || migrated.families[family].tier1;
              migrated.families[family].latest = (state as any).latest || migrated.families[family].latest;
              migrated.families[family].tier1Version = parseModelVersion(migrated.families[family].tier1);
              migrated.families[family].latestVersion = parseModelVersion(migrated.families[family].latest);
            }
          }
          migrated.lastDiscoveryTimestamp = parsed.lastDiscoveryTimestamp || 0;
          return migrated;
        }

        // Schema migration: v2 → v3 (add text families)
        if (parsed.schemaVersion === 2) {
          console.log('[ModelVersionManager] Migrating v2 → v3 state (adding text families)');
          // Carry over all existing vision families, add text families
          for (const txtFamily of Object.values(TextModelFamily)) {
            if (!parsed.families[txtFamily]) {
              const baseline = TEXT_BASELINE_MODELS[txtFamily];
              const version = parseModelVersion(baseline);
              parsed.families[txtFamily] = {
                baseline,
                tier1: baseline,
                latest: baseline,
                latestVersion: version,
                tier1Version: version,
                previousTier1: null,
                previousLatest: null,
              };
            }
          }
          parsed.schemaVersion = SCHEMA_VERSION;
          return parsed;
        }

        console.warn('[ModelVersionManager] Unrecognized schema version, reinitializing');
      }
    } catch (err: any) {
      console.warn(`[ModelVersionManager] Failed to load state: ${err.message}`);
    }

    return this.createDefaultState();
  }

  private persistState() {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = this.persistPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.persistPath);
    } catch (e) {
      console.error('[ModelVersionManager] Failed to save state to disk', e);
    }
  }

  private createDefaultState(): PersistedState {
    const families: Record<string, FamilyState> = {};

    // Vision families
    for (const family of Object.values(ModelFamily)) {
      const baseline = BASELINE_MODELS[family];
      const version = parseModelVersion(baseline);
      families[family] = {
        baseline,
        tier1: baseline,
        latest: baseline,
        latestVersion: version,
        tier1Version: version,
        previousTier1: null,
        previousLatest: null,
      };
    }

    // Text families
    for (const family of Object.values(TextModelFamily)) {
      const baseline = TEXT_BASELINE_MODELS[family];
      const version = parseModelVersion(baseline);
      families[family] = {
        baseline,
        tier1: baseline,
        latest: baseline,
        latestVersion: version,
        tier1Version: version,
        previousTier1: null,
        previousLatest: null,
      };
    }

    return {
      families,
      lastDiscoveryTimestamp: 0,
      discoveryFailureCounts: {},
      schemaVersion: SCHEMA_VERSION,
    };
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

  // ─── Debug / Diagnostics ───────────────────────────────────────────

  /**
   * Return a human-readable summary of current model tiers.
   */
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

    // Show rollback availability (both vision and text)
    const allFamilyKeys = [
      ...VISION_PROVIDER_ORDER.map(f => f as string),
      ...TEXT_PROVIDER_ORDER.map(f => f as string),
    ];
    const rollbackAvailable = allFamilyKeys.filter(f => {
      const s = this.state.families[f];
      return s && (s.previousTier1 || s.previousLatest);
    });
    if (rollbackAvailable.length > 0) {
      lines.push(`  Rollback available for: ${rollbackAvailable.join(', ')}`);
    }

    lines.push(`  Last discovery: ${this.state.lastDiscoveryTimestamp
      ? new Date(this.state.lastDiscoveryTimestamp).toISOString()
      : 'never'}`);
    lines.push(`  Discovery interval: 14 days`);
    return lines.join('\n');
  }
}
