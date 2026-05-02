const { spawnSync } = require("node:child_process");

function runNodeTest(testFile, envOverrides) {
	const result = spawnSync(process.execPath, ["--test", testFile], {
		stdio: "inherit",
		env: {
			...process.env,
			...envOverrides,
		},
	});

	if (result.status !== 0) {
		const profile = envOverrides.NATIVELY_SOAK_SCENARIO || "unknown";
		throw new Error(`soak scenario failed (${profile})`);
	}
}

function runSoakScenarios() {
	const testFile = "dist-electron/electron/tests/missionCriticalSoak.test.js";
	const profile =
		process.env.NATIVELY_SOAK_PROFILE === "prerelease" ? "prerelease" : "ci";

	const scenarios = [
		{
			NATIVELY_SOAK_SCENARIO: "2h-session",
			NATIVELY_SOAK_DURATION_MINUTES: profile === "prerelease" ? "120" : "30",
			NATIVELY_SOAK_AUDIO_GAPS: process.env.NATIVELY_SOAK_AUDIO_GAPS ?? "0",
			NATIVELY_SOAK_HOT_MEMORY_MB:
				process.env.NATIVELY_SOAK_HOT_MEMORY_MB ?? "140",
			NATIVELY_SOAK_LATENCY_DRIFT_PCT:
				process.env.NATIVELY_SOAK_LATENCY_DRIFT_PCT ?? "10",
			NATIVELY_SOAK_UNRECOVERABLE_CRASHES:
				process.env.NATIVELY_SOAK_UNRECOVERABLE_CRASHES ?? "0",
			NATIVELY_SOAK_MEETING_CYCLES:
				process.env.NATIVELY_SOAK_MEETING_CYCLES ?? "10",
			NATIVELY_SOAK_CYCLE_WINDOW_MINUTES:
				process.env.NATIVELY_SOAK_CYCLE_WINDOW_MINUTES ?? "5",
		},
		{
			NATIVELY_SOAK_SCENARIO: "4h-session",
			NATIVELY_SOAK_DURATION_MINUTES: profile === "prerelease" ? "240" : "30",
			NATIVELY_SOAK_AUDIO_GAPS:
				process.env.NATIVELY_SOAK_4H_AUDIO_GAPS ??
				process.env.NATIVELY_SOAK_AUDIO_GAPS ??
				"0",
			NATIVELY_SOAK_HOT_MEMORY_MB:
				process.env.NATIVELY_SOAK_4H_HOT_MEMORY_MB ??
				process.env.NATIVELY_SOAK_HOT_MEMORY_MB ??
				"140",
			NATIVELY_SOAK_LATENCY_DRIFT_PCT:
				process.env.NATIVELY_SOAK_4H_LATENCY_DRIFT_PCT ??
				process.env.NATIVELY_SOAK_LATENCY_DRIFT_PCT ??
				"10",
			NATIVELY_SOAK_UNRECOVERABLE_CRASHES:
				process.env.NATIVELY_SOAK_4H_UNRECOVERABLE_CRASHES ??
				process.env.NATIVELY_SOAK_UNRECOVERABLE_CRASHES ??
				"0",
			NATIVELY_SOAK_MEETING_CYCLES:
				process.env.NATIVELY_SOAK_4H_MEETING_CYCLES ??
				process.env.NATIVELY_SOAK_MEETING_CYCLES ??
				"10",
			NATIVELY_SOAK_CYCLE_WINDOW_MINUTES:
				process.env.NATIVELY_SOAK_4H_CYCLE_WINDOW_MINUTES ??
				process.env.NATIVELY_SOAK_CYCLE_WINDOW_MINUTES ??
				"5",
		},
		{
			NATIVELY_SOAK_SCENARIO: "rapid-cycles",
			NATIVELY_SOAK_DURATION_MINUTES:
				process.env.NATIVELY_SOAK_RAPID_DURATION_MINUTES ?? "5",
			NATIVELY_SOAK_AUDIO_GAPS:
				process.env.NATIVELY_SOAK_RAPID_AUDIO_GAPS ?? "0",
			NATIVELY_SOAK_HOT_MEMORY_MB:
				process.env.NATIVELY_SOAK_RAPID_HOT_MEMORY_MB ??
				process.env.NATIVELY_SOAK_HOT_MEMORY_MB ??
				"140",
			NATIVELY_SOAK_LATENCY_DRIFT_PCT:
				process.env.NATIVELY_SOAK_RAPID_LATENCY_DRIFT_PCT ??
				process.env.NATIVELY_SOAK_LATENCY_DRIFT_PCT ??
				"10",
			NATIVELY_SOAK_UNRECOVERABLE_CRASHES:
				process.env.NATIVELY_SOAK_RAPID_UNRECOVERABLE_CRASHES ?? "0",
			NATIVELY_SOAK_MEETING_CYCLES:
				process.env.NATIVELY_SOAK_RAPID_MEETING_CYCLES ?? "50",
			NATIVELY_SOAK_CYCLE_WINDOW_MINUTES:
				process.env.NATIVELY_SOAK_RAPID_CYCLE_WINDOW_MINUTES ?? "5",
		},
	];

	for (const scenarioEnv of scenarios) {
		runNodeTest(testFile, scenarioEnv);
	}
}

try {
	runSoakScenarios();
} catch (error) {
	console.error(
		"[soak-scenarios] failed:",
		error instanceof Error ? error.message : String(error),
	);
	process.exit(1);
}
