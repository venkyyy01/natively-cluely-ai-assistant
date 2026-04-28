import type { ModelVersion, FamilyState } from './modelVersionTypes';
import { parseModelVersion, compareVersions, versionDistance } from './modelVersionUtils';

/**
 * Apply tiered upgrade logic for one family (vision or text). Mutates `familyState`.
 * Returns true if Tier1 or Latest changed.
 */
export function applyTierUpgradeRules(
  familyState: FamilyState,
  discoveredModelId: string,
  discoveredVersion: ModelVersion,
  logLabel: string,
  majorLogTag: 'vision' | 'text',
  textTierSummary: boolean,
): boolean {
  const prevLatest = familyState.latest;
  const prevTier1 = familyState.tier1;

  familyState.previousTier1 = familyState.tier1;
  familyState.previousLatest = familyState.latest;

  familyState.latest = discoveredModelId;
  familyState.latestVersion = discoveredVersion;

  const tier1Version = familyState.tier1Version;
  if (tier1Version) {
    const distance = versionDistance(tier1Version, discoveredVersion);

    if (discoveredVersion.major > tier1Version.major) {
      if (prevLatest && prevLatest !== prevTier1) {
        const prevLatestVersion = parseModelVersion(prevLatest);
        if (prevLatestVersion && compareVersions(prevLatestVersion, tier1Version) > 0) {
          const tag = majorLogTag === 'text' ? 'MAJOR text upgrade' : 'MAJOR upgrade';
          console.log(
            `[ModelVersionManager] 🚀 ${tag} for ${logLabel}: ` +
              `Tier1 → ${prevLatest} (last stable), Tier2/3 → ${discoveredModelId} (new major)`,
          );
          familyState.tier1 = prevLatest;
          familyState.tier1Version = prevLatestVersion;
        }
      }
    } else if (distance >= 2) {
      if (prevLatest && prevLatest !== prevTier1) {
        const prevLatestVersion = parseModelVersion(prevLatest);
        if (prevLatestVersion && compareVersions(prevLatestVersion, tier1Version) > 0) {
          const tierLabel = majorLogTag === 'text' ? 'Text Tier 1 promotion' : 'Tier 1 promotion';
          console.log(
            `[ModelVersionManager] ⬆️ ${tierLabel} for ${logLabel}: ` +
              `${tier1Version.raw} → ${prevLatest} (${distance.toFixed(1)} minor versions behind)`,
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
    const kind = textTierSummary ? ' text tiers' : ' tiers';
    console.log(`[ModelVersionManager] ${logLabel}${kind}: Tier1=${familyState.tier1}, Tier2/3=${familyState.latest}`);
  }

  return changed;
}
