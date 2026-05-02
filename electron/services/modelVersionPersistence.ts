import fs from "fs";
import path from "path";
import {
	BASELINE_MODELS,
	type FamilyState,
	ModelFamily,
	type PersistedState,
	SCHEMA_VERSION,
	TEXT_BASELINE_MODELS,
	TextModelFamily,
} from "./modelVersionTypes";
import { parseModelVersion } from "./modelVersionUtils";

export function createDefaultPersistedState(): PersistedState {
	const families: Record<string, FamilyState> = {};

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

export function loadPersistedState(persistPath: string): PersistedState {
	try {
		if (fs.existsSync(persistPath)) {
			const raw = fs.readFileSync(persistPath, "utf-8");
			const parsed: PersistedState = JSON.parse(raw);

			if (parsed.schemaVersion === SCHEMA_VERSION) {
				console.log("[ModelVersionManager] Loaded persisted state from disk");
				return parsed;
			}

			if (parsed.schemaVersion === 1) {
				console.log("[ModelVersionManager] Migrating v1 → v3 state");
				const migrated = createDefaultPersistedState();
				for (const [family, state] of Object.entries(parsed.families || {})) {
					if (migrated.families[family]) {
						migrated.families[family].tier1 =
							(state as any).tier1 || migrated.families[family].tier1;
						migrated.families[family].latest =
							(state as any).latest || migrated.families[family].latest;
						migrated.families[family].tier1Version = parseModelVersion(
							migrated.families[family].tier1,
						);
						migrated.families[family].latestVersion = parseModelVersion(
							migrated.families[family].latest,
						);
					}
				}
				migrated.lastDiscoveryTimestamp = parsed.lastDiscoveryTimestamp || 0;
				return migrated;
			}

			if (parsed.schemaVersion === 2) {
				console.log(
					"[ModelVersionManager] Migrating v2 → v3 state (adding text families)",
				);
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

			console.warn(
				"[ModelVersionManager] Unrecognized schema version, reinitializing",
			);
		}
	} catch (err: any) {
		console.warn(`[ModelVersionManager] Failed to load state: ${err.message}`);
	}

	return createDefaultPersistedState();
}

export function savePersistedState(
	persistPath: string,
	state: PersistedState,
): void {
	if (!persistPath) return;
	try {
		const dir = path.dirname(persistPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const tmpPath = persistPath + ".tmp";
		fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
		fs.renameSync(tmpPath, persistPath);
	} catch (e) {
		console.error("[ModelVersionManager] Failed to save state to disk", e);
	}
}
