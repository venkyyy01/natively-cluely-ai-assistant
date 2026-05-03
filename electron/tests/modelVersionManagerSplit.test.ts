import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SERVICES_DIR = path.join(process.cwd(), "electron", "services");

test("NAT-067: ModelVersionManager split modules exist", () => {
	const modules = [
		"modelVersionTypes.ts",
		"modelVersionUtils.ts",
		"modelVersionPersistence.ts",
		"modelVersionTierUpgrade.ts",
		"modelVersionProviderDiscovery.ts",
		"ModelVersionManager.ts",
	];
	for (const mod of modules) {
		const modPath = path.join(SERVICES_DIR, mod);
		assert.ok(fs.existsSync(modPath), `${mod} should exist`);
		const stat = fs.statSync(modPath);
		assert.ok(stat.size > 0, `${mod} should be non-empty`);
	}
});

test("NAT-067: ModelVersionManager.ts barrel re-exports types and utils", () => {
	const source = fs.readFileSync(
		path.join(SERVICES_DIR, "ModelVersionManager.ts"),
		"utf8",
	);
	assert.ok(
		source.includes(
			'ModelFamily',
		) && source.includes('ModelVersion') && source.includes(
			'TextModelFamily',
		) && source.includes('TieredModels') && source.includes(
			'modelVersionTypes',
		),
		"should re-export types",
	);
	assert.ok(
		source.includes(
			'parseModelVersion',
		) && source.includes('compareVersions') && source.includes(
			'versionDistance',
		) && source.includes('classifyModel') && source.includes(
			'classifyTextModel',
		) && source.includes('modelVersionUtils'),
		"should re-export utils",
	);
});

test("NAT-067: modelVersionTypes.ts has no Electron app dependency", () => {
	const source = fs.readFileSync(
		path.join(SERVICES_DIR, "modelVersionTypes.ts"),
		"utf8",
	);
	assert.ok(
		!source.includes("import { app }"),
		"types should not import Electron app",
	);
});

test("NAT-067: modelVersionUtils.ts imports from modelVersionTypes", () => {
	const source = fs.readFileSync(
		path.join(SERVICES_DIR, "modelVersionUtils.ts"),
		"utf8",
	);
	assert.ok(
		source.includes("modelVersionTypes"),
		"utils should import types",
	);
});
